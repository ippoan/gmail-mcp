import { afterEach, describe, expect, it, vi } from "vitest";
import type { McpServer } from "@modelcontextprotocol/server";
import { registerTools } from "../src/tools.js";
import { putAccount } from "../src/accounts.js";
import { base64UrlToBase64, findAttachmentPart, type GmailPart } from "../src/mime.js";
import type { Env } from "../src/types.js";
import { testEnv } from "./helpers.js";

type Content =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string }
  | { type: "resource"; resource: { uri: string; mimeType: string; blob: string } };

type Handler = (args: Record<string, unknown>) => Promise<{
  content: Content[];
  isError?: boolean;
}>;

async function attachmentHandler(): Promise<Handler> {
  const env: Env = testEnv();
  await putAccount(env, "default", {
    email: "me@example.com",
    refresh_token: "rt-1",
    scopes: ["https://www.googleapis.com/auth/gmail.modify"],
    created_at: "2026-07-16T00:00:00.000Z",
  });
  let handler: Handler | undefined;
  const server = {
    registerTool: (name: string, _config: unknown, h: Handler) => {
      if (name === "get_attachment") handler = h;
      return {};
    },
  } as unknown as McpServer;
  registerTools(server, env);
  return handler!;
}

// 本文 + PDF (attachmentId 経由) + 小さい PNG (payload に inline) + 大きすぎる添付
const payload: GmailPart = {
  mimeType: "multipart/mixed",
  parts: [
    { partId: "0", mimeType: "text/plain", body: { data: "aGVsbG8", size: 5 } },
    {
      partId: "1",
      mimeType: "application/pdf",
      filename: "見積書.pdf",
      body: { size: 5, attachmentId: "att-pdf" },
    },
    { partId: "2", mimeType: "image/png", filename: "logo.png", body: { size: 2, data: "-_8" } },
    {
      partId: "3",
      mimeType: "application/zip",
      filename: "huge.zip",
      body: { size: 11 * 1024 * 1024, attachmentId: "att-huge" },
    },
  ],
};

function stubGmail(): string[] {
  const urls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      urls.push(url);
      if (url.startsWith("https://oauth2.googleapis.com/token")) {
        return Response.json({ access_token: "at-1" });
      }
      if (url.includes("/messages/m1/attachments/att-pdf")) {
        // "%PDF-" の base64url (padding なし)
        return Response.json({ data: "JVBERi0", size: 5 });
      }
      if (url.includes("/messages/m1?")) return Response.json({ id: "m1", payload });
      throw new Error(`unexpected fetch: ${url}`);
    }),
  );
  return urls;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("get_attachment", () => {
  it("returns a PDF as an embedded resource (standard base64, padded)", async () => {
    const handler = await attachmentHandler();
    stubGmail();
    const result = await handler({ message_id: "m1", part_id: "1" });
    expect(result.isError).toBeUndefined();
    const [meta, body] = result.content;
    expect(JSON.parse((meta as { text: string }).text)).toEqual({
      message_id: "m1",
      part_id: "1",
      filename: "見積書.pdf",
      mimeType: "application/pdf",
      size: 5,
    });
    expect(body).toEqual({
      type: "resource",
      resource: {
        uri: `gmail://default/messages/m1/parts/1/${encodeURIComponent("見積書.pdf")}`,
        mimeType: "application/pdf",
        blob: "JVBERi0=",
      },
    });
    expect(atob("JVBERi0=")).toBe("%PDF-");
  });

  it("returns an inline image part as image content without an attachments call", async () => {
    const handler = await attachmentHandler();
    const urls = stubGmail();
    const result = await handler({ message_id: "m1", part_id: "2" });
    expect(result.content[1]).toEqual({ type: "image", data: "+/8=", mimeType: "image/png" });
    expect(urls.some((u) => u.includes("/attachments/"))).toBe(false);
  });

  it("rejects a body part / unknown part_id", async () => {
    const handler = await attachmentHandler();
    stubGmail();
    for (const part_id of ["0", "9"]) {
      const result = await handler({ message_id: "m1", part_id });
      expect(result.isError).toBe(true);
      expect((result.content[0] as { text: string }).text).toContain("part_id");
    }
  });

  it("rejects attachments over 10 MB before downloading", async () => {
    const handler = await attachmentHandler();
    const urls = stubGmail();
    const result = await handler({ message_id: "m1", part_id: "3" });
    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toContain("大きすぎます");
    expect(urls.some((u) => u.includes("/attachments/"))).toBe(false);
  });
});

describe("findAttachmentPart / base64UrlToBase64", () => {
  it("finds nested attachment parts by partId", () => {
    const nested: GmailPart = { mimeType: "multipart/mixed", parts: [payload] };
    expect(findAttachmentPart(nested, "1")?.filename).toBe("見積書.pdf");
    expect(findAttachmentPart(undefined, "1")).toBeUndefined();
  });

  it("pads to a multiple of 4", () => {
    expect(base64UrlToBase64("YQ")).toBe("YQ==");
    expect(base64UrlToBase64("YWI")).toBe("YWI=");
    expect(base64UrlToBase64("YWJj")).toBe("YWJj");
  });
});
