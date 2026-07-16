import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { assertNoForbiddenTools } from "./meta.js";
import type { Env } from "./types.js";

// ここに登録したものだけが Claude から見える。send 系 (messages.send /
// drafts.send) は定義自体を置かないことで送信経路を物理的に断つ (Issue #1)。
// v1 の read / draft / label 系ツールは Issue #3 / #4 で追加する。
export function registerTools(server: McpServer, _env: Env): void {
  const names: string[] = [];
  const register: McpServer["registerTool"] = (name, config, handler) => {
    names.push(name);
    return server.registerTool(name, config, handler);
  };

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
