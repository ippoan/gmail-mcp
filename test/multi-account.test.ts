import { afterEach, describe, expect, it, vi } from "vitest";
import type { McpServer } from "@modelcontextprotocol/server";
import { registerTools } from "../src/tools.js";
import { putAccount } from "../src/accounts.js";
import { accessTokenFor, GmailAuthError } from "../src/gmail-api.js";
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

async function envWithTwoAccounts(): Promise<Env> {
  const env = testEnv();
  await putAccount(env, "default", {
    email: "personal@example.com",
    refresh_token: "rt-default",
    scopes: [],
    created_at: "2026-07-16T00:00:00.000Z",
  });
  await putAccount(env, "work", {
    email: "work@example.com",
    refresh_token: "rt-work",
    scopes: [],
    created_at: "2026-07-16T00:00:00.000Z",
  });
  return env;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("multi-account", () => {
  it("resolves each alias to its own refresh_token", async () => {
    const env = await envWithTwoAccounts();
    const refreshed: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        const params = new URLSearchParams(String(init?.body));
        refreshed.push(params.get("refresh_token")!);
        return Response.json({ access_token: `at-${params.get("refresh_token")}` });
      }),
    );

    expect(await accessTokenFor(env, "default")).toBe("at-rt-default");
    expect(await accessTokenFor(env, "work")).toBe("at-rt-work");
    expect(refreshed).toEqual(["rt-default", "rt-work"]);
  });

  it("one account's expiry does not affect the other", async () => {
    const env = await envWithTwoAccounts();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        const params = new URLSearchParams(String(init?.body));
        if (params.get("refresh_token") === "rt-work") {
          return Response.json({ error: "invalid_grant" }, { status: 400 });
        }
        return Response.json({ access_token: "at-ok" });
      }),
    );

    await expect(accessTokenFor(env, "default")).resolves.toBe("at-ok");
    await expect(accessTokenFor(env, "work")).rejects.toThrow(GmailAuthError);
    await expect(accessTokenFor(env, "work")).rejects.toThrow(/oauth\/start\?alias=work/);
  });

  it("unknown alias returns guidance with registered list hint", async () => {
    const env = await envWithTwoAccounts();
    const handlers = toolHandlers(env);
    const result = await handlers.get("search_threads")!({ query: "x", account: "nope" });
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("未登録");
    expect(result.content[0]!.text).toContain("oauth/start?alias=nope");
  });
});
