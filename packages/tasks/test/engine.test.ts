import { afterAll, describe, expect, it } from "vitest";
import type { Sql } from "@cb/db";
import { ulid } from "@cb/shared";
import { defineTask, InterruptedEffectError, TaskEngine } from "../src/index.ts";
import { setupTestDb } from "@cb/db/testing";

const sql: Sql | undefined = await setupTestDb();
if (sql) await sql`create table if not exists test_side_effects (key text, at timestamptz default now())`;
const engines: TaskEngine[] = [];
const run = ulid().slice(-8).toLowerCase(); // unique task names per run: tests never see old rows

afterAll(async () => {
  await Promise.all(engines.map((e) => e.stop()));
  await sql?.end();
});

function engine(opts: ConstructorParameters<typeof TaskEngine>[1] = {}): TaskEngine {
  const e = new TaskEngine(sql!, { pollMs: 50, leaseMs: 2000, ...opts });
  engines.push(e);
  return e;
}

const db = () => (sql ? it : it.skip);

describe("TaskEngine", () => {
  db()("runs phases in order and keeps the state between them", async () => {
    const T = defineTask<{ n: number }, { trail: string[] }, { trail: string[] }>({
      name: `t-phases-${run}`,
      version: 1,
      firstPhase: "a",
      initial: () => ({ trail: [] }),
      phases: {
        a: async (c) => c.next("b", { trail: [...c.task.state.trail, `a${c.task.input.n}`] }),
        b: async (c) => c.next("c", { trail: [...c.task.state.trail, "b"] }),
        c: async (c) => c.done({ trail: [...c.task.state.trail, "c"] }),
      },
    });
    const e = engine().register(T);
    await e.start();
    const { id } = await e.submit(T, { n: 7 });
    const t = await e.waitFor(id, 10_000);
    expect(t.status).toBe("done");
    expect(t.result).toEqual({ trail: ["a7", "b", "c"] });
  });

  db()("submit is idempotent per requestId", async () => {
    const T = defineTask<{}, {}, null>({
      name: `t-idem-${run}`,
      version: 1,
      firstPhase: "x",
      initial: () => ({}),
      phases: { x: async (c) => c.done(null) },
    });
    const e = engine();
    const a = await e.submit(T, {}, { requestId: `req-${run}` });
    const b = await e.submit(T, {}, { requestId: `req-${run}` });
    expect(a.created).toBe(true);
    expect(b).toEqual({ id: a.id, created: false });
  });

  db()("retries a failing phase with backoff and keeps the checkpoint", async () => {
    let calls = 0;
    const T = defineTask<{}, { ok: boolean }, number>({
      name: `t-retry-${run}`,
      version: 1,
      firstPhase: "prep",
      maxAttempts: 4,
      backoffMs: () => 20,
      initial: () => ({ ok: false }),
      phases: {
        prep: async (c) => c.next("flaky", { ok: true }),
        flaky: async (c) => {
          calls++;
          expect(c.task.state.ok).toBe(true); // checkpoint from the previous phase
          if (calls < 3) throw new Error("transient");
          return c.done(calls);
        },
      },
    });
    const e = engine().register(T);
    await e.start();
    const { id } = await e.submit(T, {});
    const t = await e.waitFor(id, 10_000);
    expect(t.status).toBe("done");
    expect(t.result).toBe(3);
  });

  db()("fails after max attempts", async () => {
    const T = defineTask<{}, {}, null>({
      name: `t-fail-${run}`,
      version: 1,
      firstPhase: "x",
      maxAttempts: 2,
      backoffMs: () => 10,
      initial: () => ({}),
      phases: {
        x: async () => {
          throw new Error("always");
        },
      },
    });
    const e = engine().register(T);
    await e.start();
    const { id } = await e.submit(T, {});
    const t = await e.waitFor(id, 10_000);
    expect(t.status).toBe("failed");
    expect(t.error).toMatch(/always/);
  });

  db()("sleepUntil suspends the task and resumes it later", async () => {
    const T = defineTask<{}, { at: number }, number>({
      name: `t-sleep-${run}`,
      version: 1,
      firstPhase: "wait",
      initial: () => ({ at: 0 }),
      phases: {
        wait: async (c) => c.sleepUntil(new Date(Date.now() + 300), "wake", { at: Date.now() }),
        wake: async (c) => c.done(Date.now() - c.task.state.at),
      },
    });
    const e = engine().register(T);
    await e.start();
    const { id } = await e.submit(T, {});
    const t = await e.waitFor(id, 10_000);
    expect(t.result as number).toBeGreaterThanOrEqual(280);
  });

  db()("spawns children, waits, and reads their results", async () => {
    const Child = defineTask<{ x: number }, {}, number>({
      name: `t-child-${run}`,
      version: 1,
      firstPhase: "go",
      initial: () => ({}),
      phases: { go: async (c) => c.done(c.task.input.x * 10) },
    });
    const Parent = defineTask<{}, {}, number>({
      name: `t-parent-${run}`,
      version: 1,
      firstPhase: "fan",
      initial: () => ({}),
      phases: {
        fan: async (c) => {
          for (const x of [1, 2, 3, 4, 5]) await c.spawn(Child, `c${x}`, { x });
          return c.waitChildren("sum", {});
        },
        sum: async (c) => {
          const kids = await c.children();
          return c.done(kids.reduce((s, k) => s + (k.result as number), 0));
        },
      },
    });
    const e = engine({ concurrency: 8 }).register(Parent, Child);
    await e.start();
    const { id } = await e.submit(Parent, {});
    const t = await e.waitFor(id, 15_000);
    expect(t.status).toBe("done");
    expect(t.result).toBe(150);
  });

  db()("effectTx runs exactly once even when the phase is retried", async () => {
    const key = `fx-${run}`;
    let attempt = 0;
    const T = defineTask<{}, {}, null>({
      name: `t-effecttx-${run}`,
      version: 1,
      firstPhase: "x",
      backoffMs: () => 10,
      initial: () => ({}),
      phases: {
        x: async (c) => {
          await c.effectTx("write", async (tx) => {
            await tx`insert into test_side_effects (key) values (${key})`;
            return "written";
          });
          attempt++;
          if (attempt === 1) throw new Error("crash after the effect");
          return c.done(null);
        },
      },
    });
    const e = engine().register(T);
    await e.start();
    const { id } = await e.submit(T, {});
    expect((await e.waitFor(id, 10_000)).status).toBe("done");
    const [{ n }] = (await sql!`select count(*)::int as n from test_side_effects where key = ${key}`) as unknown as [{ n: number }];
    expect(n).toBe(1);
  });

  db()("an interrupted effect that is not replay-safe is reported, not repeated", async () => {
    let ran = 0;
    let seen: unknown;
    const T = defineTask<{}, {}, string>({
      name: `t-interrupt-${run}`,
      version: 1,
      firstPhase: "x",
      initial: () => ({}),
      phases: {
        x: async (c) => {
          try {
            await c.effect("send-mail", async () => void ran++, { replaySafe: false });
            return c.done("sent");
          } catch (err) {
            seen = err;
            return c.done("interrupted");
          }
        },
      },
    });
    const e = engine().register(T);
    const { id } = await e.submit(T, {});
    // Simulate a crash between "intent saved" and "result saved".
    await sql!`insert into task_effects (task_id, key, replay_safe, status) values (${id}, 'send-mail', false, 'intent')`;
    await e.start();
    const t = await e.waitFor(id, 10_000);
    expect(t.result).toBe("interrupted");
    expect(seen).toBeInstanceOf(InterruptedEffectError);
    expect(ran).toBe(0);
  });

  db()("recovers a task whose worker died (expired lease)", async () => {
    const T = defineTask<{}, { step: number }, number>({
      name: `t-reap-${run}`,
      version: 1,
      firstPhase: "a",
      initial: () => ({ step: 0 }),
      phases: {
        a: async (c) => c.next("b", { step: 1 }),
        b: async (c) => c.done(c.task.state.step + 1),
      },
    });
    const e = engine().register(T);
    const { id } = await e.submit(T, {});
    // A dead worker had committed phase "a" and then crashed while running "b".
    await sql!`
      update tasks set status = 'running', phase = 'b', state = ${sql!.json({ step: 1 })}, attempts = 1,
             lease_owner = 'dead-worker', lease_until = now() - interval '1 second'
      where id = ${id}`;
    await e.start();
    const t = await e.waitFor(id, 10_000);
    expect(t.status).toBe("done");
    expect(t.result).toBe(2);
  });

  db()("many workers share the queue without running a task twice", async () => {
    const name = `t-share-${run}`;
    const T = defineTask<{ i: number }, {}, null>({
      name,
      version: 1,
      firstPhase: "x",
      initial: () => ({}),
      phases: {
        x: async (c) => {
          await c.effectTx("count", async (tx) => {
            await tx`insert into test_side_effects (key) values (${`${name}:${c.task.input.i}`})`;
            return null;
          });
          return c.done(null);
        },
      },
    });
    const workers = [engine({ concurrency: 4 }), engine({ concurrency: 4 }), engine({ concurrency: 4 })];
    for (const w of workers) w.register(T);
    const ids = [];
    for (let i = 0; i < 60; i++) ids.push((await workers[0]!.submit(T, { i })).id);
    await Promise.all(workers.map((w) => w.start()));
    for (const id of ids) expect((await workers[0]!.waitFor(id, 20_000)).status).toBe("done");
    const rows = await sql!<{ key: string; n: number }[]>`
      select key, count(*)::int as n from test_side_effects where key like ${name + ":%"} group by key`;
    expect(rows).toHaveLength(60);
    expect(rows.every((r) => r.n === 1)).toBe(true);
  });
});
