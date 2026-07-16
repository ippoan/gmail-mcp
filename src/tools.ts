import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { assertNoForbiddenTools } from "./meta.js";
import { listAccountSummaries, getAccount, reauthUrl } from "./accounts.js";
import { refreshAccessToken } from "./google.js";
import type { Env } from "./types.js";

// ここに登録したものだけが Claude から見える。send 系 (messages.send /
// drafts.send) は定義自体を置かないことで送信経路を物理的に断つ (Issue #1)。
// v1 の read / draft / label 系ツールは Issue #3 / #4 で追加する。
export function registerTools(server: McpServer, env: Env): void {
  const names: string[] = [];
  const register: McpServer["registerTool"] = (name, config, handler) => {
    names.push(name);
    return server.registerTool(name, config, handler);
  };

  register(
    "list_accounts",
    {
      description:
        "登録済み Gmail アカウント一覧 (エイリアス・メールアドレス・スコープ・認証状態)。" +
        "check_auth=true で各アカウントの refresh token が生きているか実際に確認し、" +
        "失効していれば再認証 URL を返す (テストモード運用のため 7 日で失効する)。",
      inputSchema: {
        check_auth: z
          .boolean()
          .optional()
          .describe("true で refresh token の生存確認を行う (アカウント毎に Google へ 1 call)"),
      },
    },
    async ({ check_auth }) => {
      const summaries = await listAccountSummaries(env);
      if (summaries.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                accounts: [],
                note: `アカウント未登録。ブラウザで ${reauthUrl(env, "default")} を開いて認可してください。`,
              }),
            },
          ],
        };
      }
      const accounts = [];
      for (const s of summaries) {
        let auth: string | undefined;
        if (check_auth) {
          const record = await getAccount(env, s.alias);
          if (record) {
            const result = await refreshAccessToken(env, record.refresh_token);
            auth = result.ok
              ? "ok"
              : result.needs_reauth
                ? `needs_reauth: ${reauthUrl(env, s.alias)}`
                : `error: ${result.error}`;
          }
        }
        accounts.push({ ...s, ...(auth !== undefined ? { auth } : {}) });
      }
      return { content: [{ type: "text", text: JSON.stringify({ accounts }) }] };
    },
  );

  register(
    "ping",
    {
      description:
        "疎通確認。message をそのまま echo する。認証 (binding_jwt) が通っていればこのツールに到達できる。",
      inputSchema: { message: z.string().optional().describe("echo する文字列") },
    },
    async ({ message }) => ({
      content: [{ type: "text", text: `pong${message ? `: ${message}` : ""}` }],
    }),
  );

  assertNoForbiddenTools(names);
}
