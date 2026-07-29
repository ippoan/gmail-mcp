import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import { assertNoForbiddenTools } from "./meta.js";
import { listAccountSummaries, getAccount, reauthUrl } from "./accounts.js";
import { refreshAccessToken } from "./google.js";
import { accessTokenFor, gmailGet, gmailPost, gmailDelete, GmailAuthError } from "./gmail-api.js";
import { extractBody, header, type GmailPart } from "./mime.js";
import { buildRawMessage, replySubject } from "./rfc822.js";
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

interface DraftResponse {
  id: string;
  message?: { id?: string; threadId?: string; payload?: GmailPart };
}

interface DraftsListResponse {
  drafts?: { id: string; message?: { id?: string; threadId?: string } }[];
}

// TRASH / SPAM は add / remove とも拒否 (決定: 削除系は delete_draft のみ、
// ゴミ箱移動は将来も含め実装しない)。
const FORBIDDEN_LABEL_IDS = new Set(["TRASH", "SPAM"]);

function forbiddenLabels(ids: string[] | undefined): string[] {
  return (ids ?? []).filter((id) => FORBIDDEN_LABEL_IDS.has(id.toUpperCase()));
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
  // SDK v2 の registerTool は overload 付き generic のため、間接代入
  // (`McpServer["registerTool"]`) では引数型が推論されない。呼び出し側で
  // 使う形 (description + z.object の inputSchema) に絞った generic で包み、
  // forward 箇所のみ cast する (cf-access-mcp の RegisterableServer と同じ発想。
  // 呼び出し側の args 推論は register 自身の signature が担保する)。
  const register = <Schema extends z.ZodType>(
    name: string,
    config: { description: string; inputSchema: Schema },
    handler: (args: z.infer<Schema>) => Promise<ToolResult> | ToolResult,
  ) => {
    names.push(name);
    return server.registerTool(
      name,
      config as { description: string; inputSchema: z.ZodType },
      handler as (args: unknown) => Promise<ToolResult>,
    );
  };

  register(
    "list_accounts",
    {
      description:
        "登録済み Gmail アカウント一覧 (エイリアス・メールアドレス・スコープ・認証状態)。" +
        "check_auth=true で各アカウントの refresh token が生きているか実際に確認し、" +
        "失効していれば再認証 URL を返す (テストモード運用のため 7 日で失効する)。",
      inputSchema: z.object({
        check_auth: z
          .boolean()
          .optional()
          .describe("true で refresh token の生存確認を行う (アカウント毎に Google へ 1 call)"),
      }),
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
      inputSchema: z.object({
        query: z.string().describe("Gmail 検索構文のクエリ"),
        max_results: z
          .number()
          .int()
          .min(1)
          .max(50)
          .optional()
          .describe("最大件数 (default 10, 上限 50)"),
        account: accountArg,
      }),
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
      inputSchema: z.object({
        thread_id: z.string().describe("search_threads が返した thread_id"),
        account: accountArg,
      }),
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
      inputSchema: z.object({
        message_id: z.string().describe("メッセージ ID"),
        account: accountArg,
      }),
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
      inputSchema: z.object({ account: accountArg }),
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
    "create_draft",
    {
      description:
        "メール下書きを作成する (送信はしない — send 系はこのサーバーに存在しない。" +
        "送信はユーザー自身が Gmail UI で行う)。thread_id を渡すと返信下書きとして" +
        "元スレッドにぶら下がる (In-Reply-To / References を自動設定、件名に Re: を補完)。",
      inputSchema: z.object({
        to: z.string().describe("宛先 (カンマ区切り可)"),
        subject: z.string().describe("件名 (返信時は Re: が無ければ自動付与)"),
        body: z.string().describe("本文 (plain text)"),
        thread_id: z.string().optional().describe("返信先スレッド ID (省略時は新規メール)"),
        cc: z.string().optional().describe("Cc (カンマ区切り可)"),
        account: accountArg,
      }),
    },
    async ({ to, subject, body, thread_id, cc, account }) =>
      run(async () => {
        const token = await accessTokenFor(env, account ?? "default");

        let inReplyTo: string | undefined;
        let references: string | undefined;
        let finalSubject = subject;
        if (thread_id) {
          const thread = await gmailGet<ThreadResponse>(token, `threads/${thread_id}`, {
            format: "metadata",
            metadataHeaders: ["Message-ID", "References", "Subject"],
          });
          const last = thread.messages?.[thread.messages.length - 1];
          inReplyTo = header(last?.payload?.headers, "Message-ID");
          references = header(last?.payload?.headers, "References");
          finalSubject = replySubject(subject);
        }

        const raw = buildRawMessage({
          to,
          cc,
          subject: finalSubject,
          body,
          inReplyTo,
          references,
        });
        const draft = await gmailPost<DraftResponse>(token, "drafts", {
          message: { raw, ...(thread_id ? { threadId: thread_id } : {}) },
        });
        return jsonResult({
          draft_id: draft.id,
          message_id: draft.message?.id,
          thread_id: draft.message?.threadId,
          gmail_url: "https://mail.google.com/mail/u/0/#drafts",
          note: "下書きを作成しました。内容を確認して送信するのは Gmail UI で行ってください。",
        });
      }),
  );

  register(
    "list_drafts",
    {
      description: "下書き一覧 (件名・宛先・下書き ID)。",
      inputSchema: z.object({
        max_results: z
          .number()
          .int()
          .min(1)
          .max(50)
          .optional()
          .describe("最大件数 (default 10, 上限 50)"),
        account: accountArg,
      }),
    },
    async ({ max_results, account }) =>
      run(async () => {
        const token = await accessTokenFor(env, account ?? "default");
        const list = await gmailGet<DraftsListResponse>(token, "drafts", {
          maxResults: max_results ?? 10,
        });
        const drafts = await Promise.all(
          (list.drafts ?? []).map(async (d) => {
            const draft = await gmailGet<DraftResponse>(token, `drafts/${d.id}`, {
              format: "metadata",
            });
            const headers = draft.message?.payload?.headers;
            return {
              draft_id: d.id,
              thread_id: draft.message?.threadId,
              to: header(headers, "To"),
              subject: header(headers, "Subject"),
            };
          }),
        );
        return jsonResult({ drafts });
      }),
  );

  register(
    "delete_draft",
    {
      description:
        "下書きを削除する (削除系ツールはこれが唯一。メッセージ/スレッドの削除・ゴミ箱移動はできない)。",
      inputSchema: z.object({
        draft_id: z.string().describe("list_drafts / create_draft が返した draft_id"),
        account: accountArg,
      }),
    },
    async ({ draft_id, account }) =>
      run(async () => {
        const token = await accessTokenFor(env, account ?? "default");
        await gmailDelete(token, `drafts/${draft_id}`);
        return jsonResult({ ok: true, deleted_draft_id: draft_id });
      }),
  );

  register(
    "modify_labels",
    {
      description:
        "スレッドのラベルを付け外しする。アーカイブは remove: [\"INBOX\"]。" +
        "TRASH / SPAM は add / remove とも拒否される (ゴミ箱移動・スパム操作は非対応)。" +
        "ユーザーラベルの ID は list_labels で確認する。",
      inputSchema: z.object({
        thread_id: z.string().describe("対象スレッド ID"),
        add: z.array(z.string()).optional().describe("付与するラベル ID"),
        remove: z.array(z.string()).optional().describe("除去するラベル ID"),
        account: accountArg,
      }),
    },
    async ({ thread_id, add, remove, account }) =>
      run(async () => {
        const bad = [...forbiddenLabels(add), ...forbiddenLabels(remove)];
        if (bad.length > 0) {
          return errorResult(
            `拒否: ${bad.join(", ")} は操作できません。` +
              "ゴミ箱/スパム操作はこのサーバーでは実装していません (削除系は delete_draft のみ)。",
          );
        }
        if ((add?.length ?? 0) === 0 && (remove?.length ?? 0) === 0) {
          return errorResult("add / remove のどちらかにラベル ID を指定してください。");
        }
        const token = await accessTokenFor(env, account ?? "default");
        const thread = await gmailPost<ThreadResponse>(token, `threads/${thread_id}/modify`, {
          addLabelIds: add ?? [],
          removeLabelIds: remove ?? [],
        });
        const labels = new Set<string>();
        for (const m of thread.messages ?? []) {
          for (const l of m.labelIds ?? []) labels.add(l);
        }
        return jsonResult({
          thread_id,
          added: add ?? [],
          removed: remove ?? [],
          labels_now: [...labels].sort(),
        });
      }),
  );

  register(
    "ping",
    {
      description:
        "疎通確認。message をそのまま echo する。認証 (binding_jwt) が通っていればこのツールに到達できる。",
      inputSchema: z.object({ message: z.string().optional().describe("echo する文字列") }),
    },
    async ({ message }) => ({
      content: [{ type: "text", text: `pong${message ? `: ${message}` : ""}` }],
    }),
  );

  assertNoForbiddenTools(names);
}
