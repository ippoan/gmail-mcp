// Gmail API (format=full) の payload から本文テキストと添付メタを取り出す。
// 方針 (Issue #3): text/plain 優先、無ければ text/html をタグ除去、
// 添付はメタ情報のみ (ダウンロードは v1 スコープ外)。

export interface GmailHeader {
  name: string;
  value: string;
}

export interface GmailBody {
  data?: string;
  size: number;
  attachmentId?: string;
}

export interface GmailPart {
  partId?: string;
  mimeType?: string;
  filename?: string;
  headers?: GmailHeader[];
  body?: GmailBody;
  parts?: GmailPart[];
}

export interface AttachmentMeta {
  filename: string;
  mimeType: string;
  size: number;
}

export interface ExtractedBody {
  text: string;
  /** 本文の出所。plain / html(タグ除去) / none */
  source: "plain" | "html" | "none";
  attachments: AttachmentMeta[];
}

export function header(headers: GmailHeader[] | undefined, name: string): string | undefined {
  return headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value;
}

/** base64url → bytes → charset デコード (未対応 charset は UTF-8 fallback)。 */
export function decodeBody(data: string, charset: string | undefined): string {
  const b64 = data.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const label = (charset ?? "utf-8").toLowerCase();
  try {
    return new TextDecoder(label).decode(bytes);
  } catch {
    // ランタイムが charset 未対応 (TextDecoder が throw) の場合は UTF-8 で読む
    return new TextDecoder("utf-8").decode(bytes);
  }
}

function charsetOf(part: GmailPart): string | undefined {
  const ct = header(part.headers, "Content-Type");
  const m = ct?.match(/charset="?([^";\s]+)"?/i);
  return m?.[1];
}

/** ごく素朴な HTML → テキスト (依存を増やさない範囲で)。 */
export function htmlToText(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|tr|li|h[1-6])>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function walk(part: GmailPart, visit: (p: GmailPart) => void): void {
  visit(part);
  for (const child of part.parts ?? []) walk(child, visit);
}

/** payload 全体から本文 (plain 優先 → html) と添付メタを抽出する。 */
export function extractBody(payload: GmailPart | undefined): ExtractedBody {
  if (!payload) return { text: "", source: "none", attachments: [] };

  const plains: string[] = [];
  const htmls: string[] = [];
  const attachments: AttachmentMeta[] = [];

  walk(payload, (part) => {
    const mime = (part.mimeType ?? "").toLowerCase();
    const isAttachment = Boolean(part.filename) || Boolean(part.body?.attachmentId);
    if (isAttachment) {
      attachments.push({
        filename: part.filename || "(unnamed)",
        mimeType: part.mimeType ?? "application/octet-stream",
        size: part.body?.size ?? 0,
      });
      return;
    }
    if (!part.body?.data) return;
    if (mime === "text/plain") {
      plains.push(decodeBody(part.body.data, charsetOf(part)));
    } else if (mime === "text/html") {
      htmls.push(decodeBody(part.body.data, charsetOf(part)));
    }
  });

  if (plains.length > 0) {
    return { text: plains.join("\n"), source: "plain", attachments };
  }
  if (htmls.length > 0) {
    return { text: htmlToText(htmls.join("\n")), source: "html", attachments };
  }
  return { text: "", source: "none", attachments };
}
