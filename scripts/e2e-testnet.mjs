// End-to-end on NEAR testnet, in a real browser: a new guest wallet claims a dock pass from the faucet, plays a run
// (cuts seals, recovers a wreck if the manifest has one), waits out the contract's minimum run time, reaches the boat,
// then sells at the Dockside. Every chain call goes to the deployed contract; every tx hash is printed.
//
//   npm run dev -- --port 5293        (with .env: VITE_CONTRACT_ID, FAUCET_ACCOUNT_ID, FAUCET_PRIVATE_KEY)
//   node scripts/e2e-testnet.mjs [http://127.0.0.1:5293] [--shots DIR]
//
// It spends testnet NEAR: the faucet funds one new account (0.1 NEAR) per run.
import { launch } from "./browser.mjs";

const base = process.argv.find((a) => a.startsWith("http")) || "http://127.0.0.1:5293";
const shotsAt = process.argv.indexOf("--shots");
const shots = shotsAt > 0 ? process.argv[shotsAt + 1] : null;
let failed = 0;
const check = (ok, what, detail = "") => {
  console.log(`${ok ? "ok  " : "FAIL"} ${what}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failed++;
};

const browser = await launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const errors = [];
const outside = new Set();
page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
page.on("pageerror", (e) => errors.push(String(e)));
page.on("request", (r) => {
  const u = new URL(r.url());
  if (u.hostname !== "127.0.0.1") outside.add(u.hostname);
});
const shot = async (name) => shots && (await page.screenshot({ path: `${shots}/${name}.png` }));
const stand = (x, z, tx, tz, pitch = -0.1) =>
  page.evaluate(
    ([x, z, tx, tz, pitch]) => {
      const p = window.__G.player;
      p.pos.set(x, 0, z);
      p.vel.set(0, 0, 0);
      p.yaw = Math.atan2(-(tx - x), -(tz - z));
      p.pitch = pitch;
    },
    [x, z, tx, tz, pitch],
  );

try {
  await page.addInitScript(() => localStorage.removeItem("saltline.wallet.v1")); // a brand-new player every run
  await page.goto(`${base}/?noaudio=1`, { waitUntil: "load" });
  await page.waitForFunction(() => window.__ready === true, null, { timeout: 90000 });
  await page.waitForFunction(() => !!window.__G.economy, null, { timeout: 10000 });
  const net = await page.evaluate(() => [window.__G.economy.chain.network, window.__G.economy.chain.contractId]);
  check(net[0] === "testnet", "the game runs on testnet", net.join(" · "));

  // 1. A dock pass from the real faucet: the account is created and registered on chain.
  const callsign = `E2E ${Math.floor(Math.random() * 1e4)}`;
  const claim = await page.evaluate(async (cs) => {
    const w = window.__G.economy.wallet;
    const r = await w.claim(cs);
    return { ...r, account: w.accountId(), registered: await w.registered().catch(() => "unknown") };
  }, callsign);
  check(claim.ok && claim.registered === true, "the faucet funds and registers a new guest account", `${callsign} → ${claim.account}`);

  // Record each run call's result (tx hashes) as salvage makes them.
  await page.evaluate(() => {
    const c = window.__G.economy.chain;
    window.__txs = [];
    for (const m of ["startRun", "extract", "sell"]) {
      const f = c[m].bind(c);
      c[m] = async (...args) => {
        const r = await f(...args);
        window.__txs.push({ method: m, ok: r.ok, txHash: r.txHash, error: r.error, pending: r.pending });
        return r;
      };
    }
    window.__G.game.start({ skipIntro: true });
  });
  await page.waitForFunction(() => window.__G.game.state === "playing", null, { timeout: 20000 });
  await page.evaluate(() => (window.__G.player.invulnerable = true)); // the drones would end a scripted run

  // 2. start_run on chain returns the manifest.
  await page.waitForFunction(() => window.__G.salvage?.state.status === "live", null, { timeout: 30000 });
  const manifest = await page.evaluate(() => window.__G.economy.manifest);
  check(manifest && manifest.containers.length === 8, "start_run returns a manifest from the contract", `run ${manifest?.runId}, ${manifest?.wrecks.length} wreck(s)`);

  // 3. Cut two seals that fit the carry limit, and recover a wreck if there is one.
  const targets = await page.evaluate(() =>
    window.__G.salvage.state.targets.map((t) => ({ kind: t.kind, key: t.key, spot: t.spot, wreckId: t.wreckId, at: t.at, out: t.out })),
  );
  let cut = 0;
  for (const t of targets.filter((t) => t.kind === "seal")) {
    if (cut === 2) break;
    await stand(t.at.x + t.out.x * 1.2, t.at.z + t.out.z * 1.2, t.at.x, t.at.z, -0.12);
    await page.waitForTimeout(250);
    await page.keyboard.down("e");
    await page.waitForFunction((s) => window.__G.salvage.state.opened.includes(s), t.spot, { timeout: 5000 }).catch(() => {});
    await page.keyboard.up("e");
    if (await page.evaluate((s) => window.__G.salvage.state.opened.includes(s), t.spot)) cut++;
    if (cut === 1) await shot("e2e-1-seal");
  }
  check(cut === 2, "two seals cut in the yard", JSON.stringify(await page.evaluate(() => window.__G.economy.carried)));
  const wreck = targets.find((t) => t.kind === "wreck");
  if (wreck) {
    await stand(wreck.at.x + wreck.out.x * 1.3, wreck.at.z + wreck.out.z * 1.3, wreck.at.x, wreck.at.z, -0.3);
    await page.waitForTimeout(250);
    await page.keyboard.down("e");
    await page.waitForFunction((id) => window.__G.salvage.state.wrecks.includes(id), wreck.wreckId, { timeout: 5000 }).catch(() => {});
    await page.keyboard.up("e");
  }

  // 4. Wait out the contract's minimum run time (block time, so no skew here), then cut the relays and reach the boat.
  const need = await page.evaluate(() => {
    const s = window.__G.salvage.state;
    return window.__G.economy.manifest.startedAt + (45 + 8 * s.opened.length + 6) * 1000 - Date.now();
  });
  console.log(`     waiting ${Math.max(0, Math.round(need / 1000))} s for the contract's minimum run time`);
  if (need > 0) await page.waitForTimeout(need);
  await page.evaluate(() => {
    for (let i = 0; i < 3; i++) window.__G.game.debugCut();
  });
  const boat = await page.evaluate(() => window.__G.level.extraction.pos);
  await stand(boat.x, boat.z, boat.x + 1, boat.z);
  await page.waitForFunction(() => window.__G.game.state === "complete", null, { timeout: 15000 });
  await page
    .waitForFunction(() => !/settling/i.test(document.querySelector(".sv-sec")?.textContent || "settling"), null, { timeout: 40000 })
    .catch(() => {});
  await page.waitForTimeout(800);
  const debrief = await page.evaluate(() => [...document.querySelectorAll(".sv-sec .sv-row")].map((r) => r.textContent));
  const ledger = await page.evaluate(() => document.querySelector(".sv-sec a")?.href || null);
  check(/×\d/.test(debrief[0] || "") && /scrip/.test(debrief[1] || ""), "extract mints the haul on chain and the debrief shows it", JSON.stringify(debrief));
  check(!!ledger && ledger.startsWith("https://testnet.nearblocks.io/txns/"), "the debrief links the extract transaction", ledger || "none");
  await shot("e2e-2-debrief");

  // 5. Sell one unit at the Dockside: the price comes from the contract and the scrip lands in the wallet.
  const sale = await page.evaluate(async () => {
    const { chain, wallet } = window.__G.economy;
    const me = wallet.accountId();
    const before = await chain.balances(me);
    const brokers = await chain.brokers();
    const BUYS = { moss: ["copper", "chips"], ines: ["meds", "fuel"], qm: ["core", "fuel"] };
    for (const b of brokers) {
      if (!b.open) continue;
      const t = BUYS[b.id].find((c) => (before[c] ?? 0) > 0);
      if (!t) continue;
      const bid = b.bids.find((q) => q.tokenId === t);
      const r = await chain.sell(b.id, t, 1);
      const after = await chain.balances(me);
      return { broker: b.id, token: t, bid: bid?.price, reason: bid?.reason, r, scripBefore: before.scrip, scripAfter: after.scrip };
    }
    return { none: true, before };
  });
  check(
    sale.r?.ok && sale.scripAfter - sale.scripBefore === sale.r.paid,
    "selling to a broker pays the bid in scrip",
    sale.none ? JSON.stringify(sale.before) : `${sale.broker} paid ${sale.r?.paid} for 1 ${sale.token} ("${sale.reason}")`,
  );
  await page.click('[data-dk="complete"]').catch(() => {});
  await page.waitForTimeout(3000);
  await shot("e2e-3-dockside");

  const txs = await page.evaluate(() => window.__txs);
  for (const t of txs) console.log(`     ${t.method.padEnd(8)} ${t.ok ? "ok" : t.pending ? "pending" : "refused"}  ${t.txHash ?? ""} ${t.error ?? ""}`);
  check(errors.length === 0, "no console errors", errors.slice(0, 3).join(" | "));
  console.log(`     hosts contacted outside 127.0.0.1: ${[...outside].join(", ") || "none"}`);
} catch (e) {
  failed++;
  console.log("FAIL", String(e));
} finally {
  await browser.close();
}
console.log(failed ? `${failed} check(s) failed` : "all checks passed");
process.exit(failed ? 1 : 0);
