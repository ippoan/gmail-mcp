import type { Env } from "./types.js";

export interface AccountRecord {
  email: string;
  refresh_token: string;
  scopes: string[];
  created_at: string;
}

/** refresh_token を含まない、tool 応答に出してよい形。 */
export interface AccountSummary {
  alias: string;
  email: string;
  scopes: string[];
  created_at: string;
}

const ACCOUNT_PREFIX = "account:";

// KV key に使う都合上 & URL query にそのまま乗せる都合上、alias は保守的に制限する
export const ALIAS_PATTERN = /^[a-z0-9][a-z0-9_-]{0,31}$/;

export function isValidAlias(alias: string): boolean {
  return ALIAS_PATTERN.test(alias);
}

export async function getAccount(env: Env, alias: string): Promise<AccountRecord | null> {
  return env.ACCOUNTS.get<AccountRecord>(`${ACCOUNT_PREFIX}${alias}`, "json");
}

export async function putAccount(env: Env, alias: string, record: AccountRecord): Promise<void> {
  await env.ACCOUNTS.put(`${ACCOUNT_PREFIX}${alias}`, JSON.stringify(record));
}

export async function listAccountSummaries(env: Env): Promise<AccountSummary[]> {
  const { keys } = await env.ACCOUNTS.list({ prefix: ACCOUNT_PREFIX });
  const summaries: AccountSummary[] = [];
  for (const key of keys) {
    const alias = key.name.slice(ACCOUNT_PREFIX.length);
    const record = await getAccount(env, alias);
    if (!record) continue;
    summaries.push({
      alias,
      email: record.email,
      scopes: record.scopes,
      created_at: record.created_at,
    });
  }
  return summaries;
}

/** 未登録 alias や refresh 失効時に案内する再認証 URL。 */
export function reauthUrl(env: Env, alias: string): string {
  return `${env.PUBLIC_ORIGIN}/oauth/start?alias=${encodeURIComponent(alias)}`;
}
