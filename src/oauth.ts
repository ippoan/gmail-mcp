import { Hono } from "hono";
import { isValidAlias, putAccount } from "./accounts.js";
import { buildAuthUrl, exchangeCode, fetchProfileEmail } from "./google.js";
import type { Env } from "./types.js";

// /oauth/* はエッジの CF Access host app (policy: me) が人間認証を担う。
// Google からの /oauth/callback リダイレクトも同一ブラウザなので CF Access
// セッション cookie で通過する (bypass 不要)。CSRF は KV 保存の state nonce
// (server-side state) で防ぐ。
const STATE_PREFIX = "state:";
const STATE_TTL_SECONDS = 600;

interface StateRecord {
  alias: string;
}

function redirectUri(requestUrl: string): string {
  return `${new URL(requestUrl).origin}/oauth/callback`;
}

export const oauthRoutes = new Hono<{ Bindings: Env }>();

oauthRoutes.get("/start", async (c) => {
  const alias = c.req.query("alias") ?? "default";
  if (!isValidAlias(alias)) {
    return c.json({ error: `invalid alias (must match ${String(/^[a-z0-9][a-z0-9_-]{0,31}$/)})` }, 400);
  }
  const nonce = crypto.randomUUID();
  await c.env.ACCOUNTS.put(
    `${STATE_PREFIX}${nonce}`,
    JSON.stringify({ alias } satisfies StateRecord),
    { expirationTtl: STATE_TTL_SECONDS },
  );
  return c.redirect(
    buildAuthUrl({
      clientId: c.env.GOOGLE_CLIENT_ID,
      redirectUri: redirectUri(c.req.url),
      state: nonce,
    }),
    302,
  );
});

oauthRoutes.get("/callback", async (c) => {
  const error = c.req.query("error");
  if (error) {
    return c.json({ error: `Google authorization failed: ${error}` }, 400);
  }
  const code = c.req.query("code");
  const state = c.req.query("state");
  if (!code || !state) {
    return c.json({ error: "missing code or state" }, 400);
  }

  const stateKey = `${STATE_PREFIX}${state}`;
  const record = await c.env.ACCOUNTS.get<StateRecord>(stateKey, "json");
  if (!record) {
    return c.json(
      { error: "unknown or expired state (10分以内に /oauth/start からやり直してください)" },
      400,
    );
  }
  await c.env.ACCOUNTS.delete(stateKey); // one-shot

  const tokens = await exchangeCode(c.env, { code, redirectUri: redirectUri(c.req.url) });
  const email = await fetchProfileEmail(tokens.access_token);

  await putAccount(c.env, record.alias, {
    email,
    refresh_token: tokens.refresh_token,
    scopes: tokens.scope.split(" ").filter(Boolean),
    created_at: new Date().toISOString(),
  });

  return c.json({
    ok: true,
    alias: record.alias,
    email,
    scopes: tokens.scope,
    note: "登録完了。Claude 側から list_accounts で確認できます。",
  });
});
