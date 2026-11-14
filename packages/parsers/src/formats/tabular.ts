import ExcelJS from "exceljs";
import Papa from "papaparse";
import type { Parser } from "../types.ts";
import { decodeText, describeTable } from "../util.ts";

export const csvParser: Parser = {
  id: "csv",
  version: "1",
  async parse(data) {
    const text = decodeText(data);
    const r = Papa.parse<string[]>(text.trim(), { delimiter: "", skipEmptyLines: true }); // "" = auto-detect ; , \t |
    const [header = [], ...rows] = r.data;
    const t = describeTable(header, rows);
    const warnings = r.errors.length ? [`csv_errors:${r.errors.length}`] : [];
    return { markdown: t.markdown, meta: { ...t.meta, delimiter: r.meta.delimiter }, attachments: [], warnings };
  },
};

function cellValue(v: ExcelJS.CellValue): unknown {
  if (v === null || v === undefined) return "";
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === "object") {
    if ("result" in v) return cellValue(v.result as ExcelJS.CellValue); // formula: its value
    if ("richText" in v) return v.richText.map((t) => t.text).join("");
    if ("text" in v) return v.text; // hyperlink
    if ("error" in v) return v.error;
  }
  return v;
}

export const xlsxParser: Parser = {
  id: "xlsx",
  version: "1",
  async parse(data) {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(data as unknown as ArrayBuffer);
    const sections: string[] = [];
    const sheets: { name: string; rows: number; columns: number }[] = [];
    wb.eachSheet((ws) => {
      const rows: unknown[][] = [];
      ws.eachRow({ includeEmpty: false }, (row) => {
        const values = (row.values as ExcelJS.CellValue[]).slice(1).map(cellValue);
        rows.push(values);
      });
      if (rows.length === 0) return;
      const [header, ...body] = rows;
      const t = describeTable(header!.map(String), body);
      sheets.push({ name: ws.name, rows: body.length, columns: header!.length });
      sections.push(`## Foglio: ${ws.name}\n\n${t.markdown}`);
    });
    const props = wb.creator || wb.title ? { author: wb.creator || undefined, created: wb.created?.toISOString() } : {};
    return { markdown: sections.join("\n\n"), ...(wb.title ? { title: wb.title } : {}), meta: { sheets, ...props }, attachments: [], warnings: sections.length ? [] : ["empty"] };
  },
};
