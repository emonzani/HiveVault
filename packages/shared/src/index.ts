export * from "./config.ts";
export * from "./ids.ts";
export * from "./tokens.ts";
export * from "./log.ts";

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(t);
        reject(signal.reason);
      },
      { once: true },
    );
  });
}
export * from "./egress.ts";
export * from "./metrics.ts";
