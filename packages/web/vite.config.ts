import { resolve } from "node:path";
import { defineConfig } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";

// Dev server: the API runs on the Fastify server (npm start, port 3700). The proxy keeps one
// origin, so the SameSite=Strict session cookie and the CSRF header work as in production.
const api = process.env.CB_API ?? "http://127.0.0.1:3700";

export default defineConfig({
  plugins: [svelte()],
  server: {
    port: 5310,
    strictPort: true,
    proxy: { "/api": { target: api, changeOrigin: false, ws: false } },
  },
  build: {
    target: "es2022",
    sourcemap: true,
    // fonts stay files: the Content-Security-Policy of the server refuses data: fonts
    assetsInlineLimit: (file) => (/\.(woff2?|ttf|otf)$/.test(file) ? false : undefined),
    rollupOptions: { input: { main: resolve(import.meta.dirname, "index.html"), kitchen: resolve(import.meta.dirname, "kitchen.html") } },
  },
});
