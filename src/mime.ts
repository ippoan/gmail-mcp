// Gmail API (format=full) の payload から本文テキストと添付メタを取り出す。
// 方針 (Issue #3): text/plain 優先、無ければ text/html をタグ除去、
// 添付はメタ情報のみ。中身は get_attachment が part_id で取りに行く (Issue #19)。

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
  /** get_attachment に渡す ID。Gmail の attachmentId は取得のたびに変わるので partId を使う。 */
  part_id: string;
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

// 日本のメーラー / 業務システムが付けるが WHATWG のラベルに無い名前 (Issue #17)。
// TextDecoder は "cp932" で throw する (workerd で実測)。
const CHARSET_ALIASES: Record<string, string> = {
  cp932: "shift_jis",
  "x-ms-cp932": "shift_jis",
  cp943: "shift_jis",
  cp51932: "euc-jp",
  cp50220: "iso-2022-jp",
  cp50221: "iso-2022-jp",
  "iso-2022-jp-ms": "iso-2022-jp",
};

/** fatal デコード。charset 未対応 / バイト列が charset に合わないときは undefined。 */
function tryDecode(bytes: Uint8Array, label: string): string | undefined {
  try {
    return new TextDecoder(label, { fatal: true, ignoreBOM: false }).decode(bytes);
  } catch {
    return undefined;
  }
}

/**
 * base64url → bytes → charset デコード。
 * 宣言された charset で読めないとき (宣言なし / 未対応の名前 / 宣言と実際が違う) は
 * ISO-2022-JP (ESC があるとき) → UTF-8 → EUC-JP → Shift_JIS の順に試す (Issue #17)。
 * EUC-JP を先に試すのは、EUC-JP のバイト列が Shift_JIS の半角カナとして通るため
 * (逆は 0x81–0x9F の先行バイトで落ちる)。全部だめなら UTF-8 (U+FFFD 入り)。
 */
export function decodeBody(data: string, charset: string | undefined): string {
  const b64 = data.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const declared = charset?.toLowerCase();
  const candidates = [
    ...(declared ? [CHARSET_ALIASES[declared] ?? declared] : []),
    // ISO-2022-JP は 7 bit なので UTF-8 としても通る。ESC があれば先に試す
    ...(bytes.includes(0x1b) ? ["iso-2022-jp"] : []),
    "utf-8",
    "euc-jp",
    "shift_jis",
  ];
  for (const label of candidates) {
    const text = tryDecode(bytes, label);
    if (text !== undefined) return text;
  }
  return new TextDecoder("utf-8").decode(bytes);
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

/** payload から partId が一致する添付パートを探す (本文パートは対象外)。 */
export function findAttachmentPart(
  payload: GmailPart | undefined,
  partId: string,
): GmailPart | undefined {
  if (!payload) return undefined;
  let found: GmailPart | undefined;
  walk(payload, (part) => {
    const isAttachment = Boolean(part.filename) || Boolean(part.body?.attachmentId);
    if (!found && isAttachment && (part.partId ?? "") === partId) found = part;
  });
  return found;
}

/** Gmail の base64url (padding なし) → MCP の blob / image が要求する標準 base64。 */
export function base64UrlToBase64(data: string): string {
  const b64 = data.replace(/-/g, "+").replace(/_/g, "/");
  return b64 + "=".repeat((4 - (b64.length % 4)) % 4);
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
        part_id: part.partId ?? "",
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
