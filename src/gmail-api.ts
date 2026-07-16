import { getAccount, reauthUrl } from "./accounts.js";
import { refreshAccessToken } from "./google.js";
import type { Env } from "./types.js";

const API_BASE = "https://gmail.googleapis.com/gmail/v1/users/me";

/** ツール応答にそのまま載せられる、alias 解決/認証まわりの失敗。 */
export class GmailAuthError extends Error {}

/**
 * alias → 生きた access_token。未登録 alias / refresh 失効は再認証 URL 付きの
 * GmailAuthError にして、ツール応答でユーザーを誘導できるようにする。
 */
export async function accessTokenFor(env: Env, alias: string): Promise<string> {
  const account = await getAccount(env, alias);
  if (!account) {
    throw new GmailAuthError(
      `アカウント "${alias}" は未登録です。list_accounts で登録済み alias を確認するか、` +
        `ブラウザで ${reauthUrl(env, alias)} を開いて認可してください。`,
    );
  }
  const result = await refreshAccessToken(env, account.refresh_token);
  if (!result.ok) {
    if (result.needs_reauth) {
      throw new GmailAuthError(
        `アカウント "${alias}" (${account.email}) の refresh token が失効しています` +
          `(テストモードは 7 日で失効)。ブラウザで ${reauthUrl(env, alias)} を開いて再認可してください。`,
      );
    }
    throw new GmailAuthError(`token refresh 失敗: ${result.error}`);
  }
  return result.access_token;
}

/** Gmail API GET。パスは /gmail/v1/users/me 配下の相対 (例: "threads")。 */
export async function gmailGet<T>(
  accessToken: string,
  path: string,
  params: Record<string, string | number | string[] | undefined> = {},
): Promise<T> {
  const url = new URL(`${API_BASE}/${path}`);
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const v of value) url.searchParams.append(key, v);
    } else {
      url.searchParams.set(key, String(value));
    }
  }
  const resp = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`Gmail API ${path} failed: HTTP ${resp.status} ${body.slice(0, 300)}`);
  }
  return (await resp.json()) as T;
}
