// Worker thread entry of ParserPool: parses one file, or renders PDF pages for OCR. Errors are
// returned as values with a stable name, because thrown custom errors lose their class across
// the thread boundary.
import { parseFile } from "./index.ts";
import { renderPdfPages } from "./render.ts";

type Task = { op?: "parse"; data: ArrayBuffer; name: string; maxChars?: number } | { op: "render"; data: ArrayBuffer; pages: number[]; scale?: number };

export default async function run(task: Task) {
  if (task.op === "render") return renderPdfPages(Buffer.from(task.data), task.pages, task.scale);
  return parseFile(Buffer.from(task.data), task.name, task.maxChars ? { maxChars: task.maxChars } : {});
}
