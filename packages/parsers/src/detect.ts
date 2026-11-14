/**
 * File type from the content first (magic bytes), the name second. A renamed file is read
 * as what it is: an "invoice.pdf" that is a ZIP is parsed as a ZIP.
 */
import { fileTypeFromBuffer } from "file-type";
import { CODE_EXTENSIONS } from "./formats/text.ts";

export interface Detected {
  mime: string;
  kind: "pdf" | "docx" | "xlsx" | "pptx" | "eml" | "msg" | "mbox" | "html" | "csv" | "markdown" | "text" | "code" | "zip" | "image" | "unknown";
}

const ext = (name: string) => (name.includes(".") ? name.split(".").pop()!.toLowerCase() : "");

export async function detectType(data: Buffer, name: string): Promise<Detected> {
  const e = ext(name);
  const ft = await fileTypeFromBuffer(data.subarray(0, 4100));
  if (ft) {
    switch (ft.mime) {
      case "application/pdf":
        return { mime: ft.mime, kind: "pdf" };
      case "application/vnd.openxmlformats-officedocument.wordprocessingml.document":
        return { mime: ft.mime, kind: "docx" };
      case "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet":
        return { mime: ft.mime, kind: "xlsx" };
      case "application/vnd.openxmlformats-officedocument.presentationml.presentation":
        return { mime: ft.mime, kind: "pptx" };
      case "application/zip":
        // some writers produce OOXML that file-type sees as plain ZIP: trust the extension then
        if (e === "docx") return { mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", kind: "docx" };
        if (e === "xlsx") return { mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", kind: "xlsx" };
        if (e === "pptx") return { mime: "application/vnd.openxmlformats-officedocument.presentationml.presentation", kind: "pptx" };
        return { mime: ft.mime, kind: "zip" };
      case "application/x-cfb":
        return e === "msg" ? { mime: "application/vnd.ms-outlook", kind: "msg" } : { mime: ft.mime, kind: "unknown" }; // legacy .doc/.xls: not supported
      case "message/rfc822":
        return { mime: ft.mime, kind: "eml" };
      default:
        if (ft.mime.startsWith("image/")) return { mime: ft.mime, kind: "image" };
        if (ft.mime === "application/xml" || ft.mime === "text/xml") break; // fall through to text detection
        return { mime: ft.mime, kind: "unknown" };
    }
  }
  // Text formats: look at the start of the content
  const head = data.subarray(0, 2048).toString("latin1");
  if (/\0/.test(head)) return { mime: "application/octet-stream", kind: "unknown" };
  if (/^From \S+/.test(head) && /\n(From|Subject|Date):/i.test(head)) return { mime: "application/mbox", kind: "mbox" };
  if (e === "eml" || /^(Received|Return-Path|Message-ID|MIME-Version|From|Date|Subject|Delivered-To):/im.test(head.split(/\r?\n\r?\n/)[0] ?? "") && /^(From|To|Subject):/im.test(head)) {
    if (e === "eml" || /^(MIME-Version|Message-ID|Received):/im.test(head)) return { mime: "message/rfc822", kind: "eml" };
  }
  if (e === "html" || e === "htm" || /^\s*(<!doctype html|<html)/i.test(head)) return { mime: "text/html", kind: "html" };
  if (e === "csv" || e === "tsv") return { mime: "text/csv", kind: "csv" };
  if (e === "md" || e === "markdown") return { mime: "text/markdown", kind: "markdown" };
  if (CODE_EXTENSIONS.includes(e)) return { mime: "text/plain", kind: "code" };
  return { mime: "text/plain", kind: "text" };
}
