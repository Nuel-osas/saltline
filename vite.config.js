import { defineConfig, loadEnv } from "vite";

// Dev only: serves POST /api/faucet through server/faucet.ts, as api/faucet.ts does on Vercel. The env is loaded
// here with every prefix, on the dev server, so the handler can read FAUCET_PRIVATE_KEY; the browser still only
// sees VITE_ variables, as Vite always does.
/**
 * The URL handleTick is given for a dev request. Connect hands the middleware the path after its mount point
 * ("/?game=v2", or "?game=v2"), so only the query is taken from it; the host and path are fixed.
 */
export function tickRequestUrl(url) {
  const at = typeof url === "string" ? url.indexOf("?") : -1;
  return `http://localhost/api/tick${at < 0 ? "" : url.slice(at)}`;
}

function faucetDev() {
  let env = {};
  return {
    name: "saltline:faucet-dev",
    apply: "serve",
    configResolved(config) {
      // The dev server keeps users and metrics in a JSON file (.saltline.local/store.json, server/store.ts) unless
      // .env says otherwise: a local run never writes to the deployed database by accident, even with its
      // credentials in .env. SALTLINE_STORE=upstash in .env opts in; =off keeps nothing. The salt is a dev-only
      // stand-in for METRICS_SALT, which hashes the ids in that file. A setting left empty in .env counts as unset.
      const loaded = loadEnv(config.mode, config.envDir || config.root, "");
      env = { ...loaded, SALTLINE_STORE: (loaded.SALTLINE_STORE || "").trim() || "file", METRICS_SALT: (loaded.METRICS_SALT || "").trim() || "saltline-local-dev-salt" };
    },
    configureServer(server) {
      // POST /api/metrics (the browser's beacon, server/metrics.ts) and GET /api/stats (the studio's numbers,
      // server/stats.ts), as api/metrics.ts and api/stats.ts do on Vercel. /api/stats answers 404 until .env has a
      // STATS_ADMIN_TOKEN. The client address comes from the socket, never from a header the browser sent.
      const serve = (path, file, handler) =>
        server.middlewares.use(path, async (req, res) => {
          try {
            const chunks = [];
            let size = 0;
            for await (const chunk of req) {
              size += chunk.length;
              if (size > 4096) break;
              chunks.push(chunk);
            }
            const headers = new Headers();
            for (const [k, v] of Object.entries(req.headers)) if (typeof v === "string") headers.set(k, v);
            headers.delete("x-real-ip");
            headers.set("x-forwarded-for", req.socket.remoteAddress || "unknown");
            const hasBody = req.method !== "GET" && req.method !== "HEAD";
            const at = typeof req.url === "string" ? req.url.indexOf("?") : -1;
            const request = new Request(`http://localhost${path}${at < 0 ? "" : req.url.slice(at)}`, { method: req.method, headers, body: hasBody ? Buffer.concat(chunks) : undefined });
            const response = await (await server.ssrLoadModule(file))[handler](request, env);
            res.statusCode = response.status;
            response.headers.forEach((value, key) => res.setHeader(key, value));
            res.end(Buffer.from(await response.arrayBuffer()));
          } catch {
            res.statusCode = 500;
            res.end();
          }
        });
      serve("/api/metrics", "/server/metrics.ts", "handleMetrics");
      serve("/api/stats", "/server/stats.ts", "handleStats");
      // POST /api/tick wakes the broker agents (server/tick.ts), as api/tick.ts does on Vercel. With no broker keys
      // in .env it answers 503, so local play never signs as a broker by accident. The query string goes through, so
      // /api/tick?game=v2 wakes v2's characters here as it does on Vercel.
      server.middlewares.use("/api/tick", async (req, res) => {
        try {
          const { handleTick } = await server.ssrLoadModule("/server/tick.ts");
          const response = await handleTick(new Request(tickRequestUrl(req.url), { method: req.method }), env);
          res.statusCode = response.status;
          response.headers.forEach((value, key) => res.setHeader(key, value));
          res.end(Buffer.from(await response.arrayBuffer()));
        } catch {
          res.statusCode = 500;
          res.end("{}");
        }
      });
      // POST /api/session hands a signed-in player their wallet (server/session.ts), as api/session.ts does on Vercel.
      // Without PRIVY_APP_ID and WALLET_SECRET in .env it answers 404: sign-in is off, and local play is as before.
      server.middlewares.use("/api/session", async (req, res) => {
        try {
          const headers = new Headers();
          for (const [k, val] of Object.entries(req.headers)) if (typeof val === "string") headers.set(k, val);
          headers.delete("x-real-ip");
          headers.set("x-forwarded-for", req.socket.remoteAddress || "unknown");
          const { handleSession } = await server.ssrLoadModule("/server/session.ts");
          const response = await handleSession(new Request("http://localhost/api/session", { method: req.method, headers }), env);
          res.statusCode = response.status;
          response.headers.forEach((value, key) => res.setHeader(key, value));
          res.end(Buffer.from(await response.arrayBuffer()));
        } catch {
          res.statusCode = 500;
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify({ ok: false, error: "The dock office hit a snag. Try again." }));
        }
      });
      server.middlewares.use("/api/faucet", async (req, res) => {
        try {
          const chunks = [];
          let size = 0;
          for await (const chunk of req) {
            size += chunk.length;
            if (size > 4096) break;
            chunks.push(chunk);
          }
          const headers = new Headers();
          for (const [k, v] of Object.entries(req.headers)) if (typeof v === "string") headers.set(k, v);
          // The client IP comes from the socket, never from a header the browser sent.
          headers.delete("x-real-ip");
          headers.set("x-forwarded-for", req.socket.remoteAddress || "unknown");
          const hasBody = req.method !== "GET" && req.method !== "HEAD";
          const request = new Request("http://localhost/api/faucet", {
            method: req.method,
            headers,
            body: hasBody ? Buffer.concat(chunks) : undefined,
          });
          const { handleFaucet } = await server.ssrLoadModule("/server/faucet.ts");
          const response = await handleFaucet(request, env);
          res.statusCode = response.status;
          response.headers.forEach((value, key) => res.setHeader(key, value));
          res.end(Buffer.from(await response.arrayBuffer()));
        } catch {
          server.config.logger.error("[faucet] the dev middleware failed before the handler answered");
          res.statusCode = 500;
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify({ ok: false, error: "The dock office hit a snag. Try again." }));
        }
      });
    },
  };
}

// Relative asset paths, so the built game in dist/ runs from any folder or static host.
export default defineConfig({
  base: "./",
  build: { chunkSizeWarningLimit: 4000 },
  test: { include: ["test/**/*.test.ts"], environment: "node" },
  plugins: [faucetDev()],
});
