---
name: hivevault-ingest
description: Load documents or web pages into the company memory (HiveVault) and follow their processing - upload files to a vault, add a link, check parsing, indexing and compilation, find documents to review. Use when the user wants to add files, folders or URLs to HiveVault, or asks why a document is not found.
---

# Load documents into HiveVault

Documents go to a vault of the HiveVault server. The server keeps the original file encrypted, reads it with local parsers and makes it searchable; a local model compiles it into wiki pages. Nothing is sent to external services.

## Connect

| Variable | Meaning |
|---|---|
| `HIVEVAULT_URL` | Server address, for example `https://brain.example.local` |
| `HIVEVAULT_API_KEY` | API key of an account with the `ingest` or `write` scope on the target vault |

Ask the user for both if they are not set. Never print the key.

## Client script

`scripts/brain.mjs` needs Node.js 18 or newer and no packages.

```bash
node scripts/brain.mjs vaults                          # vaults this key can write
node scripts/brain.mjs upload <vault> file1.pdf file2.docx [--compile] [--classification interno]
node scripts/brain.mjs link <vault> https://example.com/page [--compile]
node scripts/brain.mjs status <source-id>               # status, level, warnings, error
node scripts/brain.mjs wait <source-id> [level]         # wait until the level is reached (default 1)
node scripts/brain.mjs review                           # documents that failed or need attention
```

`<vault>` is the slug or the id of the vault.

## Levels

| Level | Meaning |
|---|---|
| I1 | Text extracted, chunks indexed: searchable by keywords |
| I2 | Embeddings computed: searchable by meaning |
| I3 | Compiled: the content is in wiki pages with citations |

A file is useful at I1 already. Compilation (I3) runs with `--compile`, on demand when people search for it, when the local chat model is free, or during the night. One model compiles for the whole server: `GET /api/sources/queue` gives the documents waiting and the estimated wait in minutes (`waitMinutes`, null before the first measured compile).

## Rules

1. **Classification first.** The default classification of the vault applies. Pages classified `pubblico` or `interno` can be read by the cloud agent through MCP; `riservato` and `segreto` cannot. Ask the user before you load sensitive documents with a low classification.
2. **Duplicates are free.** The same file in the same vault is stored once; uploading it again returns the existing source.
3. **Limits.** Files over the server limit (default 500 MB) are refused. Links must be public `http(s)` addresses: internal network addresses are refused by the server.
4. **Formats.** PDF, DOCX, XLSX, PPTX, CSV, EML, MSG, MBOX, HTML, ZIP (members become child documents), Markdown, text, code. Images and scanned PDF pages are read by the local OCR model when the server has one; without it they keep the warning `needs_ocr`. Old `.doc` and `.xls` are not supported.
5. **Problems.** `status` shows `failed` with the error, `unsupported`, or warnings such as `needs_ocr` (a scan, and the server has no OCR model). `review` lists them. A failed document can be processed again from the web interface ("Rielabora").
6. **Folders.** For thousands of files ask an administrator for a bulk import from a server folder instead of uploading one by one.
