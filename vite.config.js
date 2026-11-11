import { defineConfig, loadEnv } from "vite";

// Dev only: serves POST /api/faucet through server/faucet.ts, as api/faucet.ts does on Vercel. The env is loaded
// here with every prefix, on the dev server, so the handler can read FAUCET_PRIVATE_KEY; the browser still only
// sees VITE_ variables, as Vite always does.
function faucetDev() {
  let env = {};
  return {
    name: "saltline:faucet-dev",
    apply: "serve",
    configResolved(config) {
      env = loadEnv(config.mode, config.envDir || config.root, "");
    },
    configureServer(server) {
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
