/**
 * Metrics of the machine that runs the server: CPU,
 * memory, load, network (Linux), disk of the data folder, temperatures (Linux hwmon) and the
 * GPU (rocm-smi or nvidia-smi: read-only queries with a time limit, when the tool exists).
 */
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let prevCpu: { idle: number; total: number } | null = null;
let prevNet: { rx: number; tx: number; t: number } | null = null;

function cpuTimes() {
  let idle = 0;
  let total = 0;
  for (const c of os.cpus()) {
    const t = c.times;
    idle += t.idle;
    total += t.user + t.nice + t.sys + t.idle + t.irq;
  }
  return { idle, total };
}

function memory(): { total: number; used: number } {
  try {
    const info = fs.readFileSync("/proc/meminfo", "utf-8");
    const kb = (k: string) => Number(new RegExp(`^${k}:\\s+(\\d+)`, "m").exec(info)?.[1] || 0) * 1024;
    const total = kb("MemTotal");
    return { total, used: total - kb("MemAvailable") };
  } catch {
    return { total: os.totalmem(), used: os.totalmem() - os.freemem() };
  }
}

function network(): { rx: number; tx: number } | null {
  try {
    let rx = 0;
    let tx = 0;
    for (const line of fs.readFileSync("/proc/net/dev", "utf-8").split("\n").slice(2)) {
      const [name, rest] = line.split(":");
      const n = name?.trim() ?? "";
      if (!rest || n === "lo" || n.startsWith("docker") || n.startsWith("veth")) continue;
      const f = rest.trim().split(/\s+/).map(Number);
      rx += f[0] ?? 0;
      tx += f[8] ?? 0;
    }
    return { rx, tx };
  } catch {
    return null;
  }
}

/** Temperatures from /sys/class/hwmon by sensor name: CPU (k10temp/coretemp), GPU (amdgpu)… */
export function temperatures(): Record<string, number> {
  const out: Record<string, number> = {};
  try {
    for (const h of fs.readdirSync("/sys/class/hwmon")) {
      const dir = path.join("/sys/class/hwmon", h);
      try {
        const name = fs.readFileSync(path.join(dir, "name"), "utf-8").trim();
        const raw = Number(fs.readFileSync(path.join(dir, "temp1_input"), "utf-8"));
        if (Number.isFinite(raw) && raw > 0 && out[name] === undefined) out[name] = Math.round(raw / 100) / 10;
      } catch {
        /* a sensor without temp1_input */
      }
    }
  } catch {
    /* no hwmon (Windows, containers) */
  }
  return out;
}

export interface GpuSnapshot {
  name: string;
  use: number | null;
  vramUsed: number | null;
  vramTotal: number | null;
  temp: number | null;
  junction: number | null;
  power: number | null;
}

let gpuTool: "rocm" | "nvidia" | "none" | null = null;
const run = (cmd: string, args: string[]) =>
  new Promise<string>((resolve, reject) =>
    execFile(cmd, args, { timeout: 4000, maxBuffer: 1024 * 1024, windowsHide: true }, (e, out) => (e ? reject(e) : resolve(out))),
  );

/** The first GPU, or null when no tool answers. The tool is detected once. */
export async function gpuSnapshot(): Promise<GpuSnapshot | null> {
  if (gpuTool === null) {
    gpuTool = "none";
    for (const [tool, args] of [["rocm-smi", ["--version"]], ["nvidia-smi", ["-L"]]] as const) {
      try {
        await run(tool, [...args]);
        gpuTool = tool === "rocm-smi" ? "rocm" : "nvidia";
        break;
      } catch {
        /* not installed */
      }
    }
  }
  try {
    if (gpuTool === "rocm") {
      const out = await run("rocm-smi", ["--showuse", "--showtemp", "--showpower", "--showmeminfo", "vram", "--showproductname", "--json"]);
      const card = Object.values(JSON.parse(out) as Record<string, Record<string, string>>)[0] ?? {};
      const num = (k: string) => (card[k] !== undefined && card[k] !== "N/A" ? Number(card[k]) : null);
      const str = (k: string) => (card[k] && card[k] !== "N/A" ? card[k] : "");
      const gfx = str("GFX Version");
      return {
        // rocm-smi prints a PCI id as model: prefer the series, then the GFX target
        name: str("Card Series") || str("Card series") || (gfx ? `AMD Radeon ${gfx}` : "") || "AMD GPU",
        use: num("GPU use (%)"),
        vramUsed: num("VRAM Total Used Memory (B)"),
        vramTotal: num("VRAM Total Memory (B)"),
        temp: num("Temperature (Sensor edge) (C)"),
        junction: num("Temperature (Sensor junction) (C)"),
        power: num("Average Graphics Package Power (W)") ?? num("Current Socket Graphics Package Power (W)"),
      };
    }
    if (gpuTool === "nvidia") {
      const out = await run("nvidia-smi", ["--query-gpu=name,utilization.gpu,memory.used,memory.total,temperature.gpu,power.draw", "--format=csv,noheader,nounits"]);
      const [name = "NVIDIA GPU", use, used, total, temp, power] = (out.split("\n")[0] ?? "").split(",").map((x) => x.trim());
      const n = (v: string | undefined) => (v !== undefined && Number.isFinite(Number(v)) ? Number(v) : null);
      return { name, use: n(use), vramUsed: n(used) === null ? null : n(used)! * 1048576, vramTotal: n(total) === null ? null : n(total)! * 1048576, temp: n(temp), junction: null, power: n(power) };
    }
  } catch {
    /* the tool failed this time: no GPU sample */
  }
  return null;
}

export interface HostSnapshot {
  cpu: number;
  memUsed: number;
  memTotal: number;
  load1: number;
  rxPerSec: number | null;
  txPerSec: number | null;
  disk: { path: string; total: number; used: number } | null;
  cores: number;
  cpuModel: string;
  hostname: string;
  platform: string;
  uptime: number;
  processRss: number;
  /** CPU temperature (°C), when a sensor is readable. */
  cpuTemp: number | null;
}

/** One sample. CPU and network are deltas since the previous call (0 the first time). */
export function hostSnapshot(dataDir: string): HostSnapshot {
  const now = cpuTimes();
  const cpu = prevCpu ? Math.max(0, Math.min(100, (1 - (now.idle - prevCpu.idle) / Math.max(1, now.total - prevCpu.total)) * 100)) : 0;
  prevCpu = now;
  const t = Date.now();
  const net = network();
  let rx: number | null = null;
  let tx: number | null = null;
  if (net && prevNet) {
    const dt = Math.max(0.001, (t - prevNet.t) / 1000);
    rx = Math.max(0, (net.rx - prevNet.rx) / dt);
    tx = Math.max(0, (net.tx - prevNet.tx) / dt);
  }
  if (net) prevNet = { ...net, t };
  let disk: HostSnapshot["disk"] = null;
  try {
    const s = fs.statfsSync(dataDir);
    disk = { path: dataDir, total: s.blocks * s.bsize, used: (s.blocks - s.bavail) * s.bsize };
  } catch {
    /* not available on this platform */
  }
  const mem = memory();
  const cpus = os.cpus();
  return {
    cpu: Math.round(cpu * 10) / 10,
    memUsed: mem.used,
    memTotal: mem.total,
    load1: os.loadavg()[0] ?? 0,
    rxPerSec: rx,
    txPerSec: tx,
    disk,
    cores: cpus.length,
    cpuModel: cpus[0]?.model?.trim() || "CPU",
    hostname: os.hostname(),
    platform: `${os.type()} ${os.release()}`,
    uptime: os.uptime(),
    processRss: process.memoryUsage().rss,
    cpuTemp: (() => {
      const t = temperatures();
      return t.k10temp ?? t.coretemp ?? t.cpu_thermal ?? t.zenpower ?? null;
    })(),
  };
}
