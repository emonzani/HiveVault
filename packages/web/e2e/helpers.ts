import { createHmac } from "node:crypto";
import { expect, test as base, type Page } from "@playwright/test";

/** RFC 6238 TOTP (SHA-1, 6 digits, 30 s), as the server computes it. */
export function totpCode(secretBase32: string, at = Date.now()): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const ch of secretBase32.replace(/=+$/, "").toUpperCase()) bits += alphabet.indexOf(ch).toString(2).padStart(5, "0");
  const key = Buffer.from(bits.match(/.{8}/g)!.map((b) => parseInt(b, 2)));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(at / 1000 / 30)));
  const h = createHmac("sha1", key).update(counter).digest();
  const o = h[h.length - 1]! & 0xf;
  const n = ((h[o]! & 0x7f) << 24) | (h[o + 1]! << 16) | (h[o + 2]! << 8) | h[o + 3]!;
  return String(n % 1_000_000).padStart(6, "0");
}

/**
 * Test with the theme of the project applied before the first paint, and a check that the
 * page logged no errors (401 answers of the first session check are expected and ignored).
 */
export const test = base.extend<{ theme: string; consoleErrors: string[] }>({
  theme: async ({}, use, info) => use(String(info.project.metadata.theme ?? "scuro")),
  consoleErrors: [
    async ({ page, theme }, use) => {
      await page.addInitScript((t) => localStorage.setItem("cb-theme", t), theme);
      const errors: string[] = [];
      page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
      page.on("console", (m) => {
        if (m.type() === "error" && !/status of 401|status of 409/.test(m.text())) errors.push(m.text());
      });
      await use(errors);
      expect(errors, "errori nella console del browser").toEqual([]);
    },
    { auto: true },
  ],
});
export { expect };

/** Waits until the logged-in shell is on screen (the shortcuts are active from then on). */
export async function ready(page: Page) {
  await expect(page.getByRole("navigation", { name: "Azioni principali" })).toBeVisible();
}

/** Opens a page through the quick switcher (Ctrl+O), as a user would. */
export async function openBySwitcher(page: Page, title: string) {
  await ready(page);
  await page.keyboard.press("Control+o");
  const box = page.getByRole("combobox");
  await expect(box).toBeFocused();
  await box.fill(title);
  await expect(page.getByRole("option").first()).toContainText(title);
  await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { level: 1, name: title })).toBeVisible();
}
