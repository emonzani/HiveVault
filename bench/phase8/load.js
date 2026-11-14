// k6 load test (phase 8). Run with the official image, against a running server:
//   docker run --rm -i --add-host=host.docker.internal:host-gateway -v "$PWD/bench:/bench" \
//     -e BASE=http://host.docker.internal:3700 -e VUS=40 -e HOLD=3m grafana/k6:0.57.0 run /bench/phase8/load.js
// The server must listen on an address the container reaches (HOST=0.0.0.0 on Linux).
// Input: bench/out/load-seed.json (npx tsx bench/phase8/load-seed.ts).
// Targets from the plan (§0.2): hybrid search without rerank p95 < 200 ms; budgeted page read
// p95 < 20 ms. The mix follows a working day: mostly reads, a third searches.
import http from "k6/http";
import { check, sleep } from "k6";
import { Trend } from "k6/metrics";

const seed = JSON.parse(open("/bench/out/load-seed.json"));
const BASE = __ENV.BASE || "http://host.docker.internal:3700";
const VUS = Number(__ENV.VUS || 40);
const H = { headers: { authorization: `Bearer ${seed.key}`, "content-type": "application/json" } };

const search = new Trend("t_search", true);
// searches the result cache has not seen: the target of the plan is on these
const searchMiss = new Trend("t_search_miss", true);
const searchHit = new Trend("t_search_hit", true);
const read = new Trend("t_read", true);
const full = new Trend("t_full", true);
const recent = new Trend("t_recent", true);

export const options = {
  scenarios: {
    // ramp to VUS users, hold, ramp down; each user thinks 0.5–1.5 s between actions
    lavoro: {
      executor: "ramping-vus",
      startVUs: 0,
      stages: [
        { duration: "30s", target: VUS },
        { duration: __ENV.HOLD || "3m", target: VUS },
        { duration: "15s", target: 0 },
      ],
      gracefulRampDown: "10s",
    },
  },
  thresholds: {
    "t_search_miss": ["p(95)<200"],
    "t_read": ["p(95)<20"],
    "http_req_failed": ["rate<0.01"],
  },
  summaryTrendStats: ["avg", "med", "p(90)", "p(95)", "p(99)", "max", "count"],
};

const pick = (a) => a[Math.floor(Math.random() * a.length)];

export default function () {
  const r = Math.random();
  if (r < 0.35) {
    const res = http.post(`${BASE}/api/search`, JSON.stringify({ query: pick(seed.queries), limit: 8, rerank: false }), { ...H, tags: { name: "search" } });
    check(res, { "ricerca 200": (x) => x.status === 200 });
    search.add(res.timings.duration);
    if (res.status === 200) (res.json("cached") ? searchHit : searchMiss).add(res.timings.duration);
  } else if (r < 0.75) {
    const res = http.get(`${BASE}/api/pages/${pick(seed.pages)}?maxTokens=2000`, { ...H, tags: { name: "read" } });
    check(res, { "lettura 200": (x) => x.status === 200 });
    read.add(res.timings.duration);
  } else if (r < 0.95) {
    const res = http.get(`${BASE}/api/pages/${pick(seed.pages)}/full`, { ...H, tags: { name: "full" } });
    check(res, { "pagina 200": (x) => x.status === 200 });
    full.add(res.timings.duration);
  } else {
    const res = http.get(`${BASE}/api/recent`, { ...H, tags: { name: "recent" } });
    check(res, { "recenti 200": (x) => x.status === 200 });
    recent.add(res.timings.duration);
  }
  // think time
  sleep(0.5 + Math.random());
}
