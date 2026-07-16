import { describe, expect, it } from "vitest";
import {
  getAccount,
  isValidAlias,
  listAccountSummaries,
  putAccount,
  reauthUrl,
} from "../src/accounts.js";
import { testEnv } from "./helpers.js";

describe("alias validation", () => {
  it("accepts conservative aliases", () => {
    for (const alias of ["default", "work", "sub-2", "a_b", "x"]) {
      expect(isValidAlias(alias), alias).toBe(true);
    }
  });
  it("rejects unsafe aliases", () => {
    for (const alias of ["", "-lead", "UPPER", "日本語", "a".repeat(33), "a b", "a/b"]) {
      expect(isValidAlias(alias), alias).toBe(false);
    }
  });
});

describe("account registry", () => {
  it("roundtrips and lists without leaking refresh_token", async () => {
    const env = testEnv();
    await putAccount(env, "default", {
      email: "me@example.com",
      refresh_token: "rt-secret",
      scopes: ["https://www.googleapis.com/auth/gmail.modify"],
      created_at: "2026-07-16T00:00:00.000Z",
    });

    const record = await getAccount(env, "default");
    expect(record?.refresh_token).toBe("rt-secret");

    const summaries = await listAccountSummaries(env);
    expect(summaries).toHaveLength(1);
    expect(summaries[0]).toEqual({
      alias: "default",
      email: "me@example.com",
      scopes: ["https://www.googleapis.com/auth/gmail.modify"],
      created_at: "2026-07-16T00:00:00.000Z",
    });
    // summary 型に refresh_token が現れないこと (tool 応答に載せない)
    expect(JSON.stringify(summaries)).not.toContain("rt-secret");
  });

  it("builds reauth URL from PUBLIC_ORIGIN", () => {
    const env = testEnv();
    expect(reauthUrl(env, "work")).toBe(
      "https://gmail-mcp.example.test/oauth/start?alias=work",
    );
  });
});
