import { afterEach, describe, expect, it, vi } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerTools } from "../src/tools.js";
import { putAccount } from "../src/accounts.js";
import type { Env } from "../src/types.js";
import { testEnv } from "./helpers.js";

type Handler = (args: Record<string, unknown>) => Promise<{
  content: { type: "text"; text: string }[];
  isError?: boolean;
}>;

function toolHandlers(env: Env): Map<string, Handler> {
  const handlers = new Map<string, Handler>();
  const server = {
    registerTool: (name: string, _config: unknown, handler: Handler) => {
      handlers.set(name, handler);
      return {};
    },
  } as unknown as McpServer;
  registerTools(server, env);
  return handlers;
}

async function envWithAccount(): Promise<Env> {
  const env = testEnv();
  await putAccount(env, "default", {
    email: "me@example.com",
    refresh_token: "rt-1",
    scopes: ["https://www.googleapis.com/auth/gmail.modify"],
    created_at: "2026-07-16T00:00:00.000Z",
  });
  return env;
}

/** token refresh + Gmail API を route する fetch stub。呼ばれた API を記録する。 */
function stubGmail(routes: Record<string, (init?: RequestInit) => unknown>) {
  const calls: { url: string; init?: RequestInit }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, init });
      if (url.startsWith("https://oauth2.googleapis.com/token")) {
        return Response.json({ access_token: "at-1" });
      }
      for (const [prefix, respond] of Object.entries(routes)) {
        if (url.includes(prefix)) return Response.json(respond(init));
      }
      throw new Error(`unexpected fetch: ${url}`);
    }),
  );
  return calls;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("modify_labels policy", () => {
  it.each([
    { add: ["TRASH"], remove: undefined },
    { add: undefined, remove: ["TRASH"] },
    { add: ["SPAM"], remove: undefined },
    { add: ["STARRED"], remove: ["spam"] }, // 小文字でも拒否
  ])("rejects TRASH/SPAM (%j) without calling Gmail", async ({ add, remove }) => {
    const env = await envWithAccount();
    const calls = stubGmail({});
    const handlers = toolHandlers(env);
    const result = await handlers.get("modify_labels")!({ thread_id: "t1", add, remove });
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("拒否");
    // Gmail API どころか token refresh すら呼ばれない (バリデーションが先)
    expect(calls).toHaveLength(0);
  });

  it("allows archive (remove INBOX)", async () => {
    const env = await envWithAccount();
    stubGmail({
      "/threads/t1/modify": () => ({
        id: "t1",
        messages: [{ id: "m1", labelIds: ["IMPORTANT"] }],
      }),
    });
    const handlers = toolHandlers(env);
    const result = await handlers.get("modify_labels")!({ thread_id: "t1", remove: ["INBOX"] });
    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content[0]!.text);
    expect(parsed.removed).toEqual(["INBOX"]);
    expect(parsed.labels_now).toEqual(["IMPORTANT"]);
  });
});

describe("create_draft", () => {
  it("creates a reply draft with In-Reply-To/References and Re: subject", async () => {
    const env = await envWithAccount();
    let draftBody: { message?: { raw?: string; threadId?: string } } | undefined;
    stubGmail({
      "/threads/t1?": () => ({
        id: "t1",
        messages: [
          {
            id: "m1",
            payload: {
              headers: [
                { name: "Message-ID", value: "<orig@example.com>" },
                { name: "Subject", value: "会議の件" },
              ],
            },
          },
        ],
      }),
      "/drafts": (init) => {
        draftBody = JSON.parse(String(init?.body));
        return { id: "d1", message: { id: "m2", threadId: "t1" } };
      },
    });
    const handlers = toolHandlers(env);
    const result = await handlers.get("create_draft")!({
      to: "a@example.com",
      subject: "会議の件",
      body: "返信本文",
      thread_id: "t1",
    });
    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content[0]!.text);
    expect(parsed.draft_id).toBe("d1");

    expect(draftBody?.message?.threadId).toBe("t1");
    const raw = draftBody!.message!.raw!;
    const decoded = (() => {
      const b64 = raw.replace(/-/g, "+").replace(/_/g, "/");
      const bin = atob(b64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      return new TextDecoder().decode(bytes);
    })();
    expect(decoded).toContain("In-Reply-To: <orig@example.com>");
    expect(decoded).toContain("References: <orig@example.com>");
    // 件名は Re: 付き + RFC 2047 encode
    expect(decoded).toMatch(/Subject: =\?UTF-8\?B\?/);
  });
});

describe("delete_draft", () => {
  it("deletes via drafts DELETE only", async () => {
    const env = await envWithAccount();
    const calls = stubGmail({ "/drafts/d1": () => ({}) });
    const handlers = toolHandlers(env);
    const result = await handlers.get("delete_draft")!({ draft_id: "d1" });
    expect(result.isError).toBeUndefined();
    const del = calls.find((c) => c.url.includes("/drafts/d1"));
    expect(del?.init?.method).toBe("DELETE");
  });
});
