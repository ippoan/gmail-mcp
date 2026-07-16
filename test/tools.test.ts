import { describe, expect, it } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerTools } from "../src/tools.js";
import { testEnv } from "./helpers.js";

// registerTools が実際に登録した名前を記録する fake server。
// SDK の実体を import せず (type only)、登録面だけを snapshot する。
function recordToolNames(): { names: string[]; server: McpServer } {
  const names: string[] = [];
  const server = {
    registerTool: (name: string) => {
      names.push(name);
      return {};
    },
  } as unknown as McpServer;
  return { names, server };
}

describe("tools/list surface", () => {
  it("matches the registered tool-name snapshot (send 系が紛れ込んだら fail)", () => {
    const { names, server } = recordToolNames();
    registerTools(server, testEnv());
    // ツールを追加したら意図的にこの snapshot を更新すること。
    // send / trash 系が現れる変更はレビューで必ず弾く。
    expect(names).toEqual(["list_accounts", "ping"]);
  });

  it("has no send-like tool names", () => {
    const { names, server } = recordToolNames();
    registerTools(server, testEnv());
    for (const name of names) {
      expect(name).not.toMatch(/send/i);
    }
  });
});
