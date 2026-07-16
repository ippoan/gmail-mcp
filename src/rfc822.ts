// create_draft 用の RFC 822 メッセージ組み立て。
// 日本語ヘッダは RFC 2047 (=?UTF-8?B?...?=)、本文は base64 で安全に運ぶ。

function utf8ToB64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

export function b64urlEncode(text: string): string {
  return utf8ToB64(text).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** 非 ASCII を含むヘッダ値を RFC 2047 encoded-word にする。 */
export function encodeHeaderValue(value: string): string {
  // eslint-disable-next-line no-control-regex
  if (/^[\x20-\x7e]*$/.test(value)) return value;
  return `=?UTF-8?B?${utf8ToB64(value)}?=`;
}

export interface DraftMessageOptions {
  to: string;
  cc?: string;
  subject: string;
  body: string;
  /** 返信時: 元スレッド最終メッセージの Message-ID。 */
  inReplyTo?: string;
  /** 返信時: 元メッセージの References ヘッダ (無ければ空)。 */
  references?: string;
}

/** 件名に Re: を付ける (既に付いていればそのまま)。 */
export function replySubject(subject: string): string {
  return /^re:/i.test(subject.trim()) ? subject : `Re: ${subject}`;
}

/** RFC 822 raw メッセージを組み立てて base64url で返す (drafts.create の message.raw 用)。 */
export function buildRawMessage(opts: DraftMessageOptions): string {
  const lines: string[] = [
    `To: ${opts.to}`,
    ...(opts.cc ? [`Cc: ${opts.cc}`] : []),
    `Subject: ${encodeHeaderValue(opts.subject)}`,
    ...(opts.inReplyTo ? [`In-Reply-To: ${opts.inReplyTo}`] : []),
    ...(opts.inReplyTo
      ? [`References: ${[opts.references, opts.inReplyTo].filter(Boolean).join(" ")}`]
      : []),
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: base64",
    "",
    utf8ToB64(opts.body),
  ];
  return b64urlEncode(lines.join("\r\n"));
}
