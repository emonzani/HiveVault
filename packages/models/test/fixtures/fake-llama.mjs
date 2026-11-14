// Fake llama-server for supervisor tests: accepts the llama-server arguments, serves /health,
// /v1/models and /v1/embeddings. FAKE_EXIT_AFTER_MS makes it exit (simulated crash).
import http from "node:http";

const args = process.argv.slice(2);
const arg = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const port = Number(arg("--port"));
const model = arg("-m") ?? "fake";
const dims = Number(process.env.FAKE_DIMS ?? 8);

const server = http.createServer((req, res) => {
  const send = (code, body) => {
    res.writeHead(code, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  if (req.url === "/health") return send(200, { status: "ok" });
  if (req.url === "/v1/models") return send(200, { data: [{ id: model }] });
  if (req.url === "/v1/embeddings") {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const input = JSON.parse(raw).input;
      const texts = Array.isArray(input) ? input : [input];
      send(200, {
        data: texts.map((t, index) => ({ index, embedding: Array.from({ length: dims }, (_, i) => (t.length + i) % 7) })),
        usage: { prompt_tokens: texts.length * 4 },
      });
    });
    return;
  }
  send(404, { error: "not found" });
});
server.listen(port, "127.0.0.1");

if (process.env.FAKE_EXIT_AFTER_MS) {
  setTimeout(() => process.exit(3), Number(process.env.FAKE_EXIT_AFTER_MS));
}
process.on("SIGTERM", () => server.close(() => process.exit(0)));
