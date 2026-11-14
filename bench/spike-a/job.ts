import { defineTask } from "@cb/tasks";
import { sleep } from "@cb/shared";

/**
 * Spike A job: four phases with database effects (exactly once), a replay-safe external
 * effect (at least once) and random delays, so that kills land in every part of a phase.
 */
export const SPIKE_TABLE = "spike_a_effects";

const jitter = () => sleep(20 + Math.floor(Math.random() * 180));

export const SpikeJob = defineTask<{ run: string; n: number }, { p1?: string; p3?: string }, { ok: true }>({
  name: "spike-a-job",
  version: 1,
  firstPhase: "p1",
  maxAttempts: 50,
  backoffMs: () => 50,
  initial: () => ({}),
  phases: {
    p1: async (c) => {
      await jitter();
      const v = await c.effectTx("p1", async (tx) => {
        await tx`insert into spike_a_effects (run, task_id, effect) values (${c.task.input.run}, ${c.task.id}, 'p1')`;
        return "p1-done";
      });
      await jitter();
      return c.next("p2", { p1: v });
    },
    p2: async (c) => {
      await jitter();
      // replay-safe "external" read: may run more than once, the result is the same
      await c.effect("p2-read", async () => ({ value: c.task.input.n * 2 }), { replaySafe: true });
      await jitter();
      return c.next("p3", c.task.state);
    },
    p3: async (c) => {
      const v = await c.effectTx("p3", async (tx) => {
        await tx`insert into spike_a_effects (run, task_id, effect) values (${c.task.input.run}, ${c.task.id}, 'p3')`;
        await sleep(30); // the kill can land inside the transaction: it must roll back
        return "p3-done";
      });
      await jitter();
      return c.next("p4", { ...c.task.state, p3: v });
    },
    p4: async (c) => {
      await jitter();
      if (c.task.state.p1 !== "p1-done" || c.task.state.p3 !== "p3-done") return c.fail("lost checkpoint");
      return c.done({ ok: true });
    },
  },
});
