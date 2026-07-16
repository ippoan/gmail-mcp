import { describe, expect, it } from "vitest";
import { buildRawMessage, encodeHeaderValue, replySubject } from "../src/rfc822.js";

function decodeRaw(raw: string): string {
  const b64 = raw.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder("utf-8").decode(bytes);
}

describe("encodeHeaderValue", () => {
  it("keeps ASCII as-is", () => {
    expect(encodeHeaderValue("Hello Re: test")).toBe("Hello Re: test");
  });
  it("encodes Japanese as RFC 2047 encoded-word", () => {
    const encoded = encodeHeaderValue("会議の件");
    expect(encoded).toMatch(/^=\?UTF-8\?B\?.+\?=$/);
  });
});

describe("replySubject", () => {
  it("prefixes Re: when missing", () => {
    expect(replySubject("会議の件")).toBe("Re: 会議の件");
  });
  it("keeps existing Re: (case-insensitive)", () => {
    expect(replySubject("RE: 会議の件")).toBe("RE: 会議の件");
    expect(replySubject("Re: x")).toBe("Re: x");
  });
});

describe("buildRawMessage", () => {
  it("builds a plain new message with base64 body", () => {
    const raw = decodeRaw(
      buildRawMessage({ to: "a@example.com", subject: "Hi", body: "こんにちは" }),
    );
    expect(raw).toContain("To: a@example.com");
    expect(raw).toContain("Subject: Hi");
    expect(raw).toContain('Content-Type: text/plain; charset="UTF-8"');
    expect(raw).toContain("Content-Transfer-Encoding: base64");
    expect(raw).not.toContain("In-Reply-To");
    // body は base64 (こんにちは)
    const bodyLine = raw.split("\r\n\r\n")[1];
    expect(atob(bodyLine!).length).toBeGreaterThan(0);
  });

  it("adds reply headers with References chain", () => {
    const raw = decodeRaw(
      buildRawMessage({
        to: "a@example.com",
        subject: "Re: 会議の件",
        body: "body",
        inReplyTo: "<msg-2@example.com>",
        references: "<msg-1@example.com>",
      }),
    );
    expect(raw).toContain("In-Reply-To: <msg-2@example.com>");
    expect(raw).toContain("References: <msg-1@example.com> <msg-2@example.com>");
  });

  it("includes Cc only when provided", () => {
    const withCc = decodeRaw(
      buildRawMessage({ to: "a@x.com", cc: "b@x.com", subject: "s", body: "b" }),
    );
    expect(withCc).toContain("Cc: b@x.com");
    const withoutCc = decodeRaw(buildRawMessage({ to: "a@x.com", subject: "s", body: "b" }));
    expect(withoutCc).not.toContain("Cc:");
  });
});
