/**
 * Email: one message (EML, MSG) or a mailbox (MBOX).
 *
 * - Header block in Italian (Da, A, Cc, Data, Oggetto) so the chunker and the model see who
 *   wrote to whom and when.
 * - Quoted replies and signatures are removed: in a thread every message repeats the
 *   previous ones, and indexing them again would multiply the same text.
 * - Message-ID / In-Reply-To / References go into meta: the compiler rebuilds the thread.
 * - Attachments become child sources; a mailbox becomes one child source per message.
 */
import MsgReaderModule, { type FieldsData } from "@kenjiuno/msgreader";
import { simpleParser, type AddressObject } from "mailparser";
import type { Attachment, Parser } from "../types.ts";
import { turndown } from "./office.ts";

const addr = (a: AddressObject | AddressObject[] | undefined) =>
  (Array.isArray(a) ? a : a ? [a] : []).flatMap((x) => x.value.map((v) => (v.name ? `${v.name} <${v.address ?? ""}>` : (v.address ?? "")))).join(", ");

/** Removes quoted history ("> ..." lines, "Il ... ha scritto:" blocks, forwarded originals) and the signature. */
export function stripQuotes(text: string): string {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]!;
    if (/^-- ?$/.test(l)) break; // RFC 3676 signature separator
    if (/^(Il|On) .{5,200}(ha scritto|wrote):\s*$/.test(l)) break;
    if (/^-{2,}\s*(Messaggio originale|Original Message|Forwarded message|Messaggio inoltrato)\s*-{2,}/i.test(l)) break;
    if (/^(Da|From):\s.+/.test(l) && /^(Inviato|Sent|Data|Date):/.test(lines[i + 1] ?? "")) break; // Outlook reply header
    if (/^>/.test(l)) continue;
    out.push(l);
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

function headerBlock(h: { from?: string; to?: string; cc?: string; date?: Date | string; subject?: string }): string {
  const date = h.date ? (h.date instanceof Date ? h.date : new Date(h.date)) : null;
  return [
    h.from ? `**Da:** ${h.from}` : "",
    h.to ? `**A:** ${h.to}` : "",
    h.cc ? `**Cc:** ${h.cc}` : "",
    date && !Number.isNaN(date.getTime()) ? `**Data:** ${date.toISOString().replace("T", " ").slice(0, 16)}` : "",
    h.subject ? `**Oggetto:** ${h.subject}` : "",
  ]
    .filter(Boolean)
    .join("  \n");
}

export const emlParser: Parser = {
  id: "eml",
  version: "1",
  async parse(data) {
    const m = await simpleParser(data, { skipImageLinks: true });
    const raw = m.text?.trim() ? m.text : m.html ? turndown.turndown(m.html) : "";
    const body = stripQuotes(raw);
    const attachments: Attachment[] = m.attachments
      .filter((a) => a.contentDisposition !== "inline" || !a.contentType.startsWith("image/"))
      .map((a, i) => ({ name: a.filename ?? `allegato-${i + 1}`, data: a.content, mime: a.contentType }));
    const references = Array.isArray(m.references) ? m.references : m.references ? [m.references] : [];
    return {
      markdown: `${headerBlock({ from: addr(m.from), to: addr(m.to), cc: addr(m.cc), date: m.date, subject: m.subject })}\n\n${body}`.trim(),
      ...(m.subject ? { title: m.subject } : {}),
      meta: {
        messageId: m.messageId,
        inReplyTo: m.inReplyTo,
        references,
        from: addr(m.from),
        to: addr(m.to),
        date: m.date?.toISOString(),
        subject: m.subject,
        attachments: attachments.map((a) => a.name),
      },
      attachments,
      warnings: [],
    };
  },
};

/** Outlook .msg (CFB container). */
export const msgParser: Parser = {
  id: "msg",
  version: "1",
  async parse(data) {
    // CommonJS module with a default export: under ESM the class is one level down
    type MsgReaderClass = (typeof import("@kenjiuno/msgreader"))["default"];
    const mod = MsgReaderModule as unknown as { default?: MsgReaderClass };
    const MsgReader = (mod.default ?? MsgReaderModule) as MsgReaderClass;
    const reader = new MsgReader(new DataView(data.buffer, data.byteOffset, data.byteLength));
    const info = reader.getFileData();
    if (info.error) throw new Error(`msg: ${info.error}`);
    const to = (info.recipients ?? []).map((r: FieldsData) => (r.name ? `${r.name} <${r.smtpAddress ?? r.email ?? ""}>` : (r.smtpAddress ?? r.email ?? ""))).join(", ");
    const from = info.senderName ? `${info.senderName} <${info.senderSmtpAddress ?? info.senderEmail ?? ""}>` : (info.senderEmail ?? "");
    const attachments: Attachment[] = (info.attachments ?? []).map((a: FieldsData, i: number) => {
      const file = reader.getAttachment(a);
      return { name: file.fileName || `allegato-${i + 1}`, data: Buffer.from(file.content) };
    });
    const date = info.messageDeliveryTime ?? info.clientSubmitTime;
    return {
      markdown: `${headerBlock({ from, to, subject: info.subject ?? "", ...(date ? { date } : {}) })}\n\n${stripQuotes(info.body ?? "")}`.trim(),
      ...(info.subject ? { title: info.subject } : {}),
      meta: { from, to, subject: info.subject, date, messageId: info.messageId, attachments: attachments.map((a) => a.name) },
      attachments,
      warnings: [],
    };
  },
};

/** MBOX: every message becomes a child source (parsed by emlParser). */
export const mboxParser: Parser = {
  id: "mbox",
  version: "1",
  async parse(data, ctx) {
    const text = data.toString("latin1"); // byte-preserving: each message is re-encoded as it was
    const starts: number[] = [];
    for (const m of text.matchAll(/^From \S+.*$/gm)) starts.push(m.index!);
    const messages = starts.map((s, i) => {
      const chunk = text.slice(s, starts[i + 1] ?? text.length);
      const body = chunk.slice(chunk.indexOf("\n") + 1).replace(/^>(>*From )/gm, "$1"); // mboxrd unescaping
      return Buffer.from(body, "latin1");
    });
    const subjects = messages.map((m) => /^Subject:\s*(.*)$/im.exec(m.toString("latin1").slice(0, 4000))?.[1]?.trim() ?? "(senza oggetto)");
    return {
      markdown: `Archivio di posta con ${messages.length} messaggi.\n\n${subjects.slice(0, 200).map((s, i) => `${i + 1}. ${s}`).join("\n")}`,
      title: ctx.name,
      meta: { messages: messages.length },
      attachments: messages.map((m, i) => ({ name: `messaggio-${String(i + 1).padStart(5, "0")}.eml`, data: m, mime: "message/rfc822" })),
      warnings: [],
    };
  },
};
