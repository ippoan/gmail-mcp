import { resolveSecret } from "@ippoan/mcp-cf-workers/auth";
import type { Env } from "./types.js";

// 「下書き可・送信不可」のスコープは Google に存在しないため gmail.modify 1 本。
// 送信ブロックは MCP サーバーが send 系ツールを一切公開しないことで担保する。
export const GMAIL_SCOPE = "https://www.googleapis.com/auth/gmail.modify";

const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";

export type FetchLike = typeof fetch;

export function buildAuthUrl(opts: {
  clientId: string;
  redirectUri: string;
  state: string;
}): string {
  const url = new URL(AUTH_URL);
  url.searchParams.set("client_id", opts.clientId);
  url.searchParams.set("redirect_uri", opts.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", GMAIL_SCOPE);
  // refresh_token を必ず貰う: offline + 再同意の強制 (2 回目以降の認可で
  // refresh_token が省略されるのを防ぐ)
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("prompt", "consent");
  url.searchParams.set("state", opts.state);
  return url.toString();
}

async function clientSecret(env: Env): Promise<string> {
  const secret = await resolveSecret(env.GOOGLE_CLIENT_SECRET);
  if (!secret) {
    throw new Error(
      "GOOGLE_CLIENT_SECRET binding unresolved (Secrets Store 未投入?) — fail closed",
    );
  }
  return secret;
}

export interface TokenExchangeResult {
  access_token: string;
  refresh_token: string;
  scope: string;
}

/** authorization code → refresh_token 交換 (/oauth/callback から呼ぶ)。 */
export async function exchangeCode(
  env: Env,
  opts: { code: string; redirectUri: string },
  fetchImpl: FetchLike = fetch,
): Promise<TokenExchangeResult> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code: opts.code,
    client_id: env.GOOGLE_CLIENT_ID,
    client_secret: await clientSecret(env),
    redirect_uri: opts.redirectUri,
  });
  const resp = await fetchImpl(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  const json = (await resp.json()) as {
    access_token?: string;
    refresh_token?: string;
    scope?: string;
    error?: string;
    error_description?: string;
  };
  if (!resp.ok || !json.access_token) {
    throw new Error(`token exchange failed: ${json.error ?? resp.status} ${json.error_description ?? ""}`);
  }
  if (!json.refresh_token) {
    // access_type=offline + prompt=consent で通常発生しないが fail loud
    throw new Error("token response has no refresh_token (prompt=consent で再認可してください)");
  }
  return {
    access_token: json.access_token,
    refresh_token: json.refresh_token,
    scope: json.scope ?? "",
  };
}

export type RefreshResult =
  | { ok: true; access_token: string }
  | { ok: false; needs_reauth: boolean; error: string };

/**
 * refresh_token → access_token。`invalid_grant` は失効/取り消し (= 再認証が
 * 必要、テストモードでは 7 日で発生する) として needs_reauth を立てる。
 */
export async function refreshAccessToken(
  env: Env,
  refreshToken: string,
  fetchImpl: FetchLike = fetch,
): Promise<RefreshResult> {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: env.GOOGLE_CLIENT_ID,
    client_secret: await clientSecret(env),
  });
  const resp = await fetchImpl(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  const json = (await resp.json()) as { access_token?: string; error?: string };
  if (resp.ok && json.access_token) {
    return { ok: true, access_token: json.access_token };
  }
  return {
    ok: false,
    needs_reauth: json.error === "invalid_grant",
    error: json.error ?? `HTTP ${resp.status}`,
  };
}

/** 認可したアカウントのメールアドレス (Gmail profile)。 */
export async function fetchProfileEmail(
  accessToken: string,
  fetchImpl: FetchLike = fetch,
): Promise<string> {
  const resp = await fetchImpl("https://gmail.googleapis.com/gmail/v1/users/me/profile", {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!resp.ok) throw new Error(`profile fetch failed: HTTP ${resp.status}`);
  const json = (await resp.json()) as { emailAddress?: string };
  if (!json.emailAddress) throw new Error("profile response has no emailAddress");
  return json.emailAddress;
}
