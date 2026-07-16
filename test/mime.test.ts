import { describe, expect, it } from "vitest";
import { decodeBody, extractBody, header, htmlToText, type GmailPart } from "../src/mime.js";

function bytesToB64url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64url(text: string): string {
  return bytesToB64url(new TextEncoder().encode(text));
}

describe("decodeBody", () => {
  it("decodes UTF-8 base64url", () => {
    expect(decodeBody(b64url("こんにちは world"), "UTF-8")).toBe("こんにちは world");
  });

  it("decodes ISO-2022-JP (日本語メールの定番エンコーディング)", () => {
    // "日本" in ISO-2022-JP: ESC $ B 46 7C 4B 5C ESC ( B
    const bytes = new Uint8Array([0x1b, 0x24, 0x42, 0x46, 0x7c, 0x4b, 0x5c, 0x1b, 0x28, 0x42]);
    expect(decodeBody(bytesToB64url(bytes), "ISO-2022-JP")).toBe("日本");
  });

  it("falls back to UTF-8 for unknown charsets", () => {
    expect(decodeBody(b64url("fallback"), "x-unknown-charset")).toBe("fallback");
  });
});

describe("extractBody", () => {
  const plainPart = (text: string, charset = "UTF-8"): GmailPart => ({
    mimeType: "text/plain",
    headers: [{ name: "Content-Type", value: `text/plain; charset=${charset}` }],
    body: { data: b64url(text), size: text.length },
  });
  const htmlPart = (html: string): GmailPart => ({
    mimeType: "text/html",
    headers: [{ name: "Content-Type", value: "text/html; charset=UTF-8" }],
    body: { data: b64url(html), size: html.length },
  });

  it("prefers text/plain in multipart/alternative", () => {
    const payload: GmailPart = {
      mimeType: "multipart/alternative",
      parts: [plainPart("plain body"), htmlPart("<p>html body</p>")],
    };
    const result = extractBody(payload);
    expect(result.source).toBe("plain");
    expect(result.text).toBe("plain body");
  });

  it("strips tags when only HTML exists", () => {
    const payload: GmailPart = {
      mimeType: "multipart/alternative",
      parts: [htmlPart("<div>Hello<br><b>World</b> &amp; more</div><style>p{}</style>")],
    };
    const result = extractBody(payload);
    expect(result.source).toBe("html");
    expect(result.text).toContain("Hello");
    expect(result.text).toContain("World & more");
    expect(result.text).not.toContain("<");
  });

  it("collects attachment metadata without downloading", () => {
    const payload: GmailPart = {
      mimeType: "multipart/mixed",
      parts: [
        plainPart("see attached"),
        {
          mimeType: "application/pdf",
          filename: "report.pdf",
          body: { size: 12345, attachmentId: "att-1" },
        },
      ],
    };
    const result = extractBody(payload);
    expect(result.text).toBe("see attached");
    expect(result.attachments).toEqual([
      { filename: "report.pdf", mimeType: "application/pdf", size: 12345 },
    ]);
  });

  it("handles single-part (non-multipart) plain message", () => {
    const result = extractBody(plainPart("single"));
    expect(result.source).toBe("plain");
    expect(result.text).toBe("single");
  });

  it("returns none when no readable body", () => {
    const result = extractBody({ mimeType: "multipart/mixed", parts: [] });
    expect(result.source).toBe("none");
    expect(result.text).toBe("");
  });
});

describe("header / htmlToText", () => {
  it("header lookup is case-insensitive", () => {
    const headers = [{ name: "subject", value: "Hello" }];
    expect(header(headers, "Subject")).toBe("Hello");
  });

  it("htmlToText collapses blank lines", () => {
    expect(htmlToText("<p>a</p><p></p><p></p><p>b</p>")).toBe("a\n\nb");
  });
});
