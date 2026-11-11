// Lets plain Node run the agents straight from TypeScript, with no build step and no extra dependency:
//
//   node --import ./agents/ts-hook.mjs agents/brokers.ts --once
//
// Node strips the types itself, but it resolves import paths literally. This repo's TypeScript imports carry .js
// (chain.ts imports "./items.js", so it also runs as compiled JavaScript on Vercel), and under plain Node that file
// doesn't exist. This hook retries a missing relative "./x.js" as "./x.ts" and changes nothing else.
// tsx does the same mapping on its own, so `tsx agents/brokers.ts` needs no hook.
import { registerHooks } from "node:module";

registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context);
    } catch (err) {
      const relative = specifier.startsWith("./") || specifier.startsWith("../");
      if (err?.code !== "ERR_MODULE_NOT_FOUND" || !relative || !specifier.endsWith(".js")) throw err;
      return nextResolve(`${specifier.slice(0, -3)}.ts`, context);
    }
  },
});
