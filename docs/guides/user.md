# User Guide

HiveVault is the company's memory. It collects documents and turns them into linked pages: customers, people, projects, and decisions.

## 1. First sign-in

1. Open the activation link you received.
2. Scan the QR code with an authenticator app (for example, Google Authenticator, Microsoft Authenticator, or Aegis).
3. Enter the 6-digit code from the app.
4. **Save the recovery codes** in a safe place. Each code works once. You need them if you lose your phone.
5. Read the notice about the cloud agent and confirm.

Future sign-ins: enter your username and the code from the app. To sign in without a code, add a passkey in **My account**.

If you lose your phone and your recovery codes, ask an administrator to reset your authentication.

## 2. The cloud agent and your data

- Original documents never leave the company server.
- The cloud agent (an external service) can read the text of **public** (`pubblico`) and **internal** (`interno`) pages.
- The cloud agent never reads **confidential** (`riservato`), **secret** (`segreto`), or **personal** (`personale`) pages.
- In your cell, you can use the **personal** level: only you read that content, not even administrators. If your account is deleted, personal content is deleted; the rest of the cell moves to one of your teams.
- Your cell starts with the **personal** default level: anything you write or upload without choosing a level is visible only to you. To share a page or document with colleagues or with the cloud agent, choose a lower level.
- Pages readable by the cloud agent show "☁ Readable by the cloud agent".
- **What the cloud agent read** (star icon) shows every read of pages in your cell.
- **Work journal**: with the prompts `buongiorno`, `chiudi-sessione`, and `fine-giornata`, the cloud agent reads and writes journal notes (Done, Decided, Open) in your cell's inbox folder. Each note links to at least one real page.

When you upload a document with sensitive information, raise its classification **before** you upload it.

## 3. The screen

| Area | Content |
|---|---|
| Left bar | Search, open a page, graph, inbox, new page, upload documents |
| Sidebar | Active vault, folders, recent pages, curator queue |
| Center | Pages in tabs. You can split the screen into two panes |
| Right panel | Page outline, incoming links (backlinks), mentions, local graph |

## 4. Keyboard shortcuts

| Keys | Action |
|---|---|
| Ctrl O | Open a page by title |
| Ctrl Shift F | Search |
| Ctrl K | Command palette |
| Ctrl E | Edit the page |
| Alt N | New page |
| Alt T / Alt W | New tab / close the tab |
| Alt ← / Alt → | Back / forward in the tab |
| Ctrl \ | Split or merge panes |
| Ctrl B | Show or hide the sidebar |

## 5. Searching

Type a question or keywords. Search matches both exact words and meaning. Use filters for vault, page type, kind, and level. Hover over a result to see a preview.

## 6. Reading a page

- Underlined words are **links** to other pages. Hover over them for a preview.
- Numbers in brackets are **citations**: they open the exact passage of the document where the information comes from.
- A **conflict** callout marks two sources that say different things. A curator decides which value is correct.
- **History** shows versions and diffs. **Restore this version** brings back an earlier version; the history stays intact.
- Below the title is the page **reliability**: high, medium, or low. Hover over it to see the reasons: how many sources it cites, open conflicts, who confirmed it, and when it must be reviewed. A page with a conflict, no sources, or past its review date has low reliability.
- **It is correct** confirms that the page states the truth. The page counts as checked from today. A confirmation stays valid until a newer document arrives.

## 7. Writing

1. **New page** (Alt N): enter the title and type.
2. Write in Markdown. Type `[[` to link another page: the editor suggests titles. On the `tags:` line, the editor suggests tags from the vault, most used first: reuse an existing tag instead of creating a similar one.
3. Save with Ctrl S.

If another person saves the same page while you write, the editor warns you. Copy your text and reload the page.

Hive pages (badge "Hive · N cells") are written by the nightly cycle: to change them, edit your cell's page or ask a curator.

## 8. Uploading documents

1. Select **Upload documents**, or drag files into the window.
2. Choose the vault and the classification.
3. Select **Upload N files**.

The status of each document updates live: queued, parsed, searchable, compiled. Supported formats: PDF, Word, Excel, PowerPoint, CSV, email (EML, MSG, MBOX), HTML, ZIP, plain text, code, and images.

Emails and their attachments become at least **confidential**. The administrator can disable email ingestion: in that case, the file stays "unsupported". Do not upload other people's email without authorization.

To delete a document, select it in the inbox and press **Delete**. If other pages cite it, HiveVault offers to **retract** it: sentences cited only by that document are removed from pages, other sentences lose its citation, and compiled pages with no remaining sources are removed. Previous versions that cite it are also removed. If a retraction changes more than one fifth of the vault, HiveVault asks for a second confirmation and saves a restore point first.

The nightly cycle re-downloads documents added from a link every 7 days. If the content changed, it becomes a new version of the document and pages update automatically.

Photos and scanned PDFs go through OCR if the administrator configured an OCR model. Without OCR, the document shows "Needs OCR": you can find it by name, but not by its text.

## 9. Curator queue

If you are a curator of a space, the **Curator queue** shows:

- **Conflicts**: two cells report different values. Pick the right value or enter a new one.
- **Duplicates**: two pages describe the same subject. Pick the page to keep.
- **Cloud agent proposals**: the cloud agent proposes an edit. Inspect the diff, then select **Approve and apply** or **Reject**.
- **To review**: the page passed its review date. Read it, fix it if needed, then press **It is correct**.
- **Mass changes**: the nightly cycle wants to remove many Hive pages at once (more than one fifth). This happens if a cell was unlinked or emptied by mistake. Select **Confirm removal** if it is intentional, or **Keep pages** otherwise.

## 10. My account

**My account** shows your sessions, passkeys, and signing keys. Close any session you do not recognize.
