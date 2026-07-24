import type { SecretBinding } from "@ippoan/mcp-cf-workers/auth";

export interface Env {
  /**
   * auth-worker origin。省略時は lib default (https://auth.ippoan.org)。
   * WWW-Authenticate表示用。introspect自体は下のAUTH_WORKER service binding経由。
   */
  AUTH_WORKER_ORIGIN?: string;
  /** auth-worker への Service Binding (`/mcp/introspect` 呼び出し用)。 */
  AUTH_WORKER: Fetcher;
  /** 公開 origin。list_accounts が再認証 URL を組み立てるのに使う。 */
  PUBLIC_ORIGIN: string;
  /** Google OAuth クライアント ID (非機密、wrangler vars)。 */
  GOOGLE_CLIENT_ID: string;
  /**
   * Google OAuth クライアント secret。本番は Secrets Store binding
   * (`gmail-mcp-google-client-secret`)、wrangler dev / test では平文 string。
   */
  GOOGLE_CLIENT_SECRET: SecretBinding;
  /** アカウントレジストリ (`account:<alias>`) + OAuth state (`state:<nonce>`)。 */
  ACCOUNTS: KVNamespace;
}
