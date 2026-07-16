import { describe, expect, it } from "vitest";
import { assertNoForbiddenTools, SERVER_NAME } from "../src/meta.js";

describe("meta", () => {
  it("server name is gmail-mcp", () => {
    expect(SERVER_NAME).toBe("gmail-mcp");
  });

  it("rejects send-like tool names", () => {
    expect(() => assertNoForbiddenTools(["create_draft", "send_message"]))
      .toThrow(/send_message/);
    expect(() => assertNoForbiddenTools(["drafts_send"])).toThrow();
  });

  it("accepts the planned v1 tool set", () => {
    expect(() =>
      assertNoForbiddenTools([
        "list_accounts",
        "search_threads",
        "get_thread",
        "get_message",
        "list_labels",
        "create_draft",
        "list_drafts",
        "delete_draft",
        "modify_labels",
      ]),
    ).not.toThrow();
  });
});
