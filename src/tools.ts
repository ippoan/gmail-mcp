import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { assertNoForbiddenTools } from "./meta.js";
import { listAccountSummaries, getAccount, reauthUrl } from "./accounts.js";
import { refreshAccessToken } from "./google.js";
import { accessTokenFor, gmailGet, GmailAuthError } from "./gmail-api.js";
import { extractBody, header, type GmailPart } from "./mime.js";
import type { Env } from "./types.js";

// 全ツール共通の account 引数 (マルチアカウント対応、省略時 default)
const accountArg = z
  .string()
  .optional()
  .describe('アカウントの alias (省略時 "default")。list_accounts で一覧できる');

type ToolResult = {
  content: { type: "text"; text: string }[];
  isError?: boolean;
};

function jsonResult(value: unknown): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value) }] };
}

function errorResult(message: string): ToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

/** GmailAuthError (再認証誘導) をツール応答に変換する共通ラッパ。 */
async function run(fn: () => Promise<ToolResult>): Promise<ToolResult> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof GmailAuthError) return errorResult(err.message);
    throw err;
  }
}

interface ThreadsListResponse {
  threads?: { id: string; snippet?: string }[];
  resultSizeEstimate?: number;
}

interface GmailMessage {
  id: string;
  threadId?: string;
  labelIds?: string[];
  snippet?: string;
  internalDate?: string;
  payload?: GmailPart;
}

interface ThreadResponse {
  id: string;
  messages?: GmailMessage[];
}

interface LabelsResponse {
  labels?: { id: string; name: string; type?: string }[];
}

function messageSummary(message: GmailMessage) {
  const headers = message.payload?.headers;
  const body = extractBody(message.payload);
  return {
    message_id: message.id,
    from: header(headers, "From"),
    to: header(headers, "To"),
    ...(header(headers, "Cc") ? { cc: header(headers, "Cc") } : {}),
    subject: header(headers, "Subject"),
    date: header(headers, "Date"),
    labels: message.labelIds,
    body: body.text,
    body_source: body.source,
    attachments: body.attachments,
  };
}

// ここに登録したものだけが Claude から見える。send 系 (messages.send /
// drafts.send) は定義自体を置かないことで送信経路を物理的に断つ (Issue #1)。
// draft / label 系ツールは Issue #4 で追加する。
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
        return jsonResult({
          accounts: [],
          note: `アカウント未登録。ブラウザで ${reauthUrl(env, "default")} を開いて認可してください。`,
        });
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
      return jsonResult({ accounts });
    },
  );

  register(
    "search_threads",
    {
      description:
        "Gmail 検索構文でスレッドを検索する (例: 'from:foo@example.com newer_than:7d is:unread')。" +
        "各スレッドの件名・差出人・日時・snippet を返す。本文は get_thread で取得する。",
      inputSchema: {
        query: z.string().describe("Gmail 検索構文のクエリ"),
        max_results: z
          .number()
          .int()
          .min(1)
          .max(50)
          .optional()
          .describe("最大件数 (default 10, 上限 50)"),
        account: accountArg,
      },
    },
    async ({ query, max_results, account }) =>
      run(async () => {
        const token = await accessTokenFor(env, account ?? "default");
        const list = await gmailGet<ThreadsListResponse>(token, "threads", {
          q: query,
          maxResults: max_results ?? 10,
        });
        const threads = list.threads ?? [];
        const detailed = await Promise.all(
          threads.map(async (t) => {
            const thread = await gmailGet<ThreadResponse>(token, `threads/${t.id}`, {
              format: "metadata",
              metadataHeaders: ["Subject", "From", "Date"],
            });
            const messages = thread.messages ?? [];
            const first = messages[0];
            const last = messages[messages.length - 1];
            return {
              thread_id: t.id,
              subject: header(first?.payload?.headers, "Subject"),
              from: header(last?.payload?.headers, "From"),
              date: header(last?.payload?.headers, "Date"),
              message_count: messages.length,
              snippet: t.snippet,
            };
          }),
        );
        return jsonResult({
          threads: detailed,
          result_size_estimate: list.resultSizeEstimate,
        });
      }),
  );

  register(
    "get_thread",
    {
      description:
        "スレッド内の全メッセージ (ヘッダ・本文・添付メタ) を取得する。本文は text/plain 優先、" +
        "無ければ HTML をテキスト化。添付はメタ情報のみ (ダウンロード非対応)。",
      inputSchema: {
        thread_id: z.string().describe("search_threads が返した thread_id"),
        account: accountArg,
      },
    },
    async ({ thread_id, account }) =>
      run(async () => {
        const token = await accessTokenFor(env, account ?? "default");
        const thread = await gmailGet<ThreadResponse>(token, `threads/${thread_id}`, {
          format: "full",
        });
        return jsonResult({
          thread_id: thread.id,
          messages: (thread.messages ?? []).map(messageSummary),
        });
      }),
  );

  register(
    "get_message",
    {
      description:
        "単一メッセージの本文・ヘッダ・添付メタを取得する。本文は text/plain 優先、" +
        "無ければ HTML をテキスト化。",
      inputSchema: {
        message_id: z.string().describe("メッセージ ID"),
        account: accountArg,
      },
    },
    async ({ message_id, account }) =>
      run(async () => {
        const token = await accessTokenFor(env, account ?? "default");
        const message = await gmailGet<GmailMessage>(token, `messages/${message_id}`, {
          format: "full",
        });
        return jsonResult({ thread_id: message.threadId, ...messageSummary(message) });
      }),
  );

  register(
    "list_labels",
    {
      description: "ラベル一覧 (システムラベル + ユーザーラベル)。",
      inputSchema: { account: accountArg },
    },
    async ({ account }) =>
      run(async () => {
        const token = await accessTokenFor(env, account ?? "default");
        const resp = await gmailGet<LabelsResponse>(token, "labels");
        return jsonResult({
          labels: (resp.labels ?? []).map((l) => ({ id: l.id, name: l.name, type: l.type })),
        });
      }),
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
