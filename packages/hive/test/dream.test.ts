// Acceptance of phase 5 (plan §10): a dream cycle stopped by its budget sleeps until the next
// night and continues from the same step; every step runs once; the report is written.
import { afterAll, describe, expect, it } from "vitest";
import { PageStore, VaultStore } from "@cb/brain";
import type { Sql } from "@cb/db";
import { setupTestDb } from "@cb/db/testing";
import { MockEndpoint, ModelDispatcher, type ChatRequest } from "@cb/models";
import { ulid } from "@cb/shared";
import { TaskEngine } from "@cb/tasks";
import { defineDreamTask, DreamBusyError, DreamVaultError, inWindow, nextWindowStart, nightOf, scheduleNight, setFeeds, startDream, STEPS } from "../src/index.ts";

const sql: Sql | undefined = await setupTestDb();
const run = ulid().slice(-6).toLowerCase();
const db = () => (sql ? it : it.skip);
const pages = sql ? new PageStore(sql, { minTokens: 1 }) : undefined;
const vaults = sql ? new VaultStore(sql, 16) : undefined;
let engine: TaskEngine | undefined;
let engine2: TaskEngine | undefined;
afterAll(async () => {
  await engine?.stop();
  await engine2?.stop();
  await sql?.end();
});

describe("night window", () => {
  const w = "22:00-06:00";
  it("knows when it is night and when the next night starts", () => {
    expect(inWindow(new Date(2026, 9, 28, 23, 0), w)).toBe(true);
    expect(inWindow(new Date(2026, 9, 29, 5, 59), w)).toBe(true);
    expect(inWindow(new Date(2026, 9, 29, 6, 0), w)).toBe(false);
    expect(nextWindowStart(new Date(2026, 9, 29, 5, 0), w)).toEqual(new Date(2026, 9, 29, 22, 0));
    expect(nextWindowStart(new Date(2026, 9, 28, 23, 0), w)).toEqual(new Date(2026, 9, 29, 22, 0));
    expect(nightOf(new Date(2026, 9, 29, 3, 0), w)).toBe("2026-10-28");
    expect(nightOf(new Date(2026, 9, 28, 22, 30), w)).toBe("2026-10-28");
  });
});

describe("dream cycle", () => {
  db()("stops at the end of its budget, sleeps until the next night, continues from the same step", { timeout: 150_000 }, async () => {
    const cell = await vaults!.create({ kind: "cell", slug: `dc-${run}`, name: "Cella" });
    const space = await vaults!.create({ kind: "space", slug: `ds-${run}`, name: "Alveare" });
    const md = (t: string, body: string, extra = "") => `---\ntitle: ${t}\ntype: entity/company\n${extra}---\n# ${t}\n\n${body}\n`;
    // duplicates: same company with and without the legal form
    await pages!.upsert({ vaultId: cell.id, markdown: md(`Beta ${run} S.r.l.`, "## Stato attuale\n- Postazioni: 40\n- Referente tecnico: [[Nome CognomeMMM]]") });
    await pages!.upsert({ vaultId: cell.id, markdown: md(`Beta ${run} srl`, "## Stato attuale\n- Rinnovo: 2027-01-01") });
    // an unlinked mention of an existing page, a broken link, a page without tldr
    await pages!.upsert({ vaultId: cell.id, markdown: md(`Nome CognomeMMM`, "## Stato attuale\n- Ruolo: responsabile IT", "type: entity/person\n") });
    await pages!.upsert({
      vaultId: cell.id,
      markdown: `---\ntitle: Verbale ${run}\ntype: note\n---\n# Verbale ${run}\n\nRiunione con Nome CognomeMMM sul rinnovo. Vedi anche [[Pagina che non esiste ${run}]].\n\n${"Dettagli della riunione e decisioni prese. ".repeat(40)}`,
    });
    await setFeeds(sql!, space.id, [{ cellId: cell.id }]);

    // scripted chat model for the tldr step (the duplicate is certain: no model call)
    const dispatcher = new ModelDispatcher({ expected: {} });
    await dispatcher.addEndpoint(
      new MockEndpoint({
        kind: "chat",
        id: "scripted",
        script: (req: ChatRequest) => ({ content: /tldr/.test(String(req.messages[0]?.content)) ? '{"tldr": "Verbale della riunione con Nome CognomeMMM sul rinnovo del contratto."}' : "{}", usage: { promptTokens: 400, completionTokens: 30 } }),
      }),
    );

    // fake clock in a night of next year: the engine wakes a sleeping task by the real clock,
    // so the night after the pause must still be in the future
    const Y = new Date().getFullYear() + 1;
    // fake clock: 20 minutes pass at every look in the first night (budget 60 minutes), one
    // second in the second night (enough time to finish)
    let clock = new Date(Y, 9, 28, 22, 0).getTime();
    let tick = 20 * 60_000;
    const now = () => {
      const d = new Date(clock);
      clock += tick;
      return d;
    };
    const dream = defineDreamTask({ sql: sql!, pages: pages!, dispatcher, window: "22:00-06:00", budget: { minutes: 60, tokens: 100_000 }, now, name: `dream-${run}` });
    engine = new TaskEngine(sql!, { pollMs: 50 }).register(dream);
    await engine.start();

    const night = `${Y}-10-28`;
    const planned: { input: { vaultId: string; night: string }; requestId: string; priority: number }[] = [];
    await scheduleNight(sql!, async (input, requestId, priority) => void planned.push({ input, requestId, priority }), night);
    const mine = planned.filter((p) => p.input.vaultId === cell.id || p.input.vaultId === space.id);
    expect(mine.map((p) => [p.input.vaultId, p.priority])).toEqual([[cell.id, 3], [space.id, 4]]);
    const submit = async (p: (typeof mine)[number]) => (await engine!.submit(dream, p.input, { requestId: `${p.requestId}:${run}`, priority: p.priority })).id;
    const cellTask = await submit(mine[0]!);

    // night 1: the cell cycle runs until the budget ends, then sleeps until 22:00 of the next day
    const sleeping = async (id: string) => {
      for (let i = 0; i < 200; i++) {
        const [t] = await sql!<{ status: string; runAfter: Date; state: { step: number; sessions: number } }[]>`
          select status, run_after as "runAfter", state from tasks where id = ${id}`;
        if (t?.status === "sleeping" && t.state.sessions >= 1) return t;
        if (t?.status === "done") return t;
        await new Promise((r) => setTimeout(r, 50));
      }
      throw new Error("the cycle did not pause");
    };
    const paused = await sleeping(cellTask);
    expect(paused.status).toBe("sleeping");
    expect(paused.runAfter).toEqual(new Date(Y, 9, 29, 22, 0));
    expect(paused.state.step).toBeGreaterThan(0);
    expect(paused.state.step).toBeLessThan(STEPS.length - 1);
    const stoppedAt = paused.state.step;
    const [r1] = await sql!<{ status: string; step: string }[]>`select status, step from dream_runs where vault_id = ${cell.id} and night = ${night}`;
    expect(r1).toMatchObject({ status: "paused", step: STEPS[stoppedAt]!.name });

    // next night: the clock moves to 22:00 and the sleeping task becomes due
    clock = new Date(Y, 9, 29, 22, 0).getTime();
    tick = 1000;
    await sql!`update tasks set run_after = now() where id = ${cellTask} and status = 'sleeping'`;
    const done = await engine.waitFor(cellTask, 60_000);
    expect(done.status).toBe("done");
    const result = done.result as { sessions: number; report: Record<string, Record<string, number | string>> };
    expect(result.sessions).toBeGreaterThanOrEqual(2);
    // every step ran, and the steps before the pause did not run again
    for (const s of STEPS.slice(0, -1)) expect(result.report[s.name], s.name).toBeDefined();
    expect(result.report.dedup).toMatchObject({ unite: 1 });
    expect(result.report.crosslink!["link aggiunti"]).toBeGreaterThanOrEqual(1);
    expect(result.report.lint).toMatchObject({ "link rotti": 1 });
    expect(result.report.tldr).toMatchObject({ sintesi: 1 });

    // effects on the vault
    const titles = (await sql!<{ title: string }[]>`select title from pages where vault_id = ${cell.id} order by title`).map((r) => r.title);
    expect(titles.filter((t) => t.startsWith(`Beta ${run}`))).toHaveLength(1);
    const verbale = (await sql!<{ body: string; frontmatter: { tldr?: string } }[]>`select body, frontmatter from pages where vault_id = ${cell.id} and title = ${`Verbale ${run}`}`)[0]!;
    expect(verbale.body).toContain("Riunione con [[Nome CognomeMMM]] sul rinnovo");
    expect(verbale.frontmatter.tldr).toContain("Nome CognomeMMM");
    expect(titles).toContain("Manutenzione del vault");
    const [idx] = await sql!<{ content: string }[]>`select content from vault_indexes where vault_id = ${cell.id} and name = 'llms'`;
    expect(idx!.content).toContain(`Verbale ${run}`);
    const [logRow] = await sql!<{ title: string; data: { sessions: number } }[]>`select title, data from vault_log where vault_id = ${cell.id} and kind = 'dream'`;
    expect(logRow).toMatchObject({ title: `Ciclo notturno del ${night}`, data: { sessions: result.sessions } });
    const [r2] = await sql!<{ status: string }[]>`select status from dream_runs where vault_id = ${cell.id} and night = ${night}`;
    expect(r2!.status).toBe("done");

    // the space cycle promotes the merged company to the hive
    const sp = await engine.waitFor(await submit(mine[1]!), 60_000);
    expect(sp.status).toBe("done");
    const [hive] = await sql!<{ title: string; body: string }[]>`select title, body from pages where vault_id = ${space.id} and frontmatter ? 'hive_subject' and title like ${`Beta ${run}%`}`;
    expect(hive!.body).toContain("- Postazioni: 40");
    expect(hive!.body).toContain("- Rinnovo: 2027-01-01");

    // a vault with a paused cycle does not get a second one the next night
    await sql!`update dream_runs set status = 'paused' where vault_id = ${cell.id} and night = ${night}`;
    const again: string[] = [];
    await scheduleNight(sql!, async (input) => void again.push(input.vaultId), `${Y}-10-29`);
    expect(again).not.toContain(cell.id);
    expect(again).toContain(space.id);
  });

  db()("a cycle links mentions of new names in pages not changed since the last cycle", { timeout: 120_000 }, async () => {
    const cell = await vaults!.create({ kind: "cell", slug: `df-${run}`, name: "Cella completa" });
    const code = `EN 319 ${run.replace(/\D/g, "").padEnd(3, "7").slice(0, 3)}-1`;
    await pages!.upsert({ vaultId: cell.id, markdown: `---
title: Nota ${run}
type: note
---
# Nota ${run}

La consegna segue ${code}.
` });
    const dream = defineDreamTask({ sql: sql!, pages: pages!, dispatcher: new ModelDispatcher({ expected: {} }), window: "22:00-06:00", budget: { minutes: 60, tokens: 100_000 }, name: `dream-full-${run}` });
    engine2 = new TaskEngine(sql!, { pollMs: 50 }).register(dream);
    await engine2.start();
    const cycle = async (day: number, full: boolean) => {
      const r = await startDream(sql!, dream, { vaultId: cell.id, window: "22:00-06:00", full, now: new Date(2020, 0, day, 23, 0) });
      expect((await engine2!.waitFor(r.taskId, 60_000)).status).toBe("done");
      return r;
    };
    const body = async () => (await sql!<{ body: string }[]>`select body from pages where vault_id = ${cell.id} and title = ${`Nota ${run}`}`)[0]!.body;

    // an unknown vault is refused before a task exists; the slug names the vault too
    const tasks = async () => (await sql!<{ n: number }[]>`select count(*)::int as n from tasks where name = ${`dream-full-${run}`}`)[0]!.n;
    await expect(startDream(sql!, dream, { vaultId: `nessuno-${run}`, window: "22:00-06:00" })).rejects.toBeInstanceOf(DreamVaultError);
    expect(await tasks()).toBe(0);
    const bySlug = await startDream(sql!, dream, { vaultId: `df-${run}`, window: "22:00-06:00", now: new Date(2019, 0, 1, 23, 0) });
    expect(bySlug.vaultId).toBe(cell.id);
    expect((await engine2!.waitFor(bySlug.taskId, 60_000)).status).toBe("done");

    const first = await cycle(1, false);
    // the cycle of a night that is finished can start again; a running one cannot
    await sql!`update dream_runs set status = 'running' where vault_id = ${cell.id} and night = ${first.night}`;
    await expect(startDream(sql!, dream, { vaultId: cell.id, window: "22:00-06:00", now: new Date(2020, 0, 1, 23, 0) })).rejects.toBeInstanceOf(DreamBusyError);
    await sql!`update dream_runs set status = 'done' where vault_id = ${cell.id} and night = ${first.night}`;

    // the target page comes after the first cycle: the note is older, but it writes a name
    // new since then, so a normal cycle reads it again
    await pages!.upsert({ vaultId: cell.id, markdown: `---
title: ETSI ${code}
type: concept
---
# ETSI ${code}

Norma.
` });
    await cycle(2, false);
    expect(await body()).toContain(`[[ETSI ${code}|${code}]]`);
    // a full cycle reads every page and adds nothing twice
    await cycle(3, true);
    expect((await body()).match(/\[\[/g)).toHaveLength(1);
  });
});
