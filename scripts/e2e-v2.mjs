// Saltline v2 end to end on NEAR testnet, in a real browser: a new guest wallet gets a dock pass from the faucet,
// signs on to a raid with the issue rifle (start_raid), cuts seals, cuts the uplinks, makes the boat (extract), and
// at the dock sells to a vendor, exports, and settles with the Harbormaster. Every call goes to the deployed
// contract; the tx hashes are printed.
//
//   npm run dev          (.env: VITE_CONTRACT_ID_V2, CONTRACT_ID_V2, FAUCET_ACCOUNT_ID, FAUCET_PRIVATE_KEY)
//   node scripts/e2e-v2.mjs [http://127.0.0.1:5280] [--shots DIR]
//
// It spends testnet NEAR: the faucet funds one new account (0.1 NEAR) per run.
import { launch } from "./browser.mjs";

const base = process.argv.find((a) => a.startsWith("http")) || "http://127.0.0.1:5280";
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
// A failed resource shows in the console without its address, so failed responses are collected by address instead.
// /api/tick answers 503 where the agents' keys aren't set (a developer's machine); that is not the game's error.
page.on("console", (m) => m.type() === "error" && !/Failed to load resource/.test(m.text()) && errors.push(m.text().slice(0, 200)));
page.on("response", (r) => r.status() >= 400 && !/\/api\/tick/.test(r.url()) && errors.push(`${r.status()} ${r.url().slice(0, 120)}`));
page.on("pageerror", (e) => errors.push(String(e).slice(0, 200)));
const shot = async (name) => shots && (await page.screenshot({ path: `${shots}/${name}.png` }));

try {
  await page.addInitScript(() => {
    try {
      localStorage.removeItem("saltline.wallet.v1"); // a brand-new player every run
    } catch {}
  });
  await page.goto(`${base}/?game=v2&noaudio=1`, { waitUntil: "load" });
  await page.waitForFunction(() => window.__ready === true, null, { timeout: 90000 });
  await page.waitForFunction(() => !!window.__G.v2 && !!window.__G.raid, null, { timeout: 15000 });
  const net = await page.evaluate(() => [window.__G.v2.chain.network, window.__G.v2.chain.contractId]);
  check(net[0] === "testnet", "v2 runs on testnet", net.join(" · "));

  // Record the chain calls the game itself makes.
  await page.evaluate(() => {
    const c = window.__G.v2.chain;
    window.__txs = [];
    for (const m of ["startRaid", "extract", "die", "sell", "exportGoods", "settle"]) {
      const f = c[m].bind(c);
      c[m] = async (...args) => {
        const r = await f(...args);
        window.__txs.push({ method: m, ok: r.ok, txHash: r.txHash, error: r.error, code: r.code, pending: r.pending });
        return r;
      };
    }
    const G = window.__G;
    const down = G.input.down.bind(G.input);
    G.input.down = (a) => (a === "interact" && window.__hold) || down(a);
    window.__at = (key) => {
      const t = G.raid.state.targets.find((x) => x.key === key);
      if (!t) return false;
      const d = t.kind === "seal" ? 1.3 : 1.5;
      G.player.pos.set(t.at.x + t.out.x * d, 0, t.at.z + t.out.z * d);
      G.player.vel.set(0, 0, 0);
      G.player.yaw = Math.atan2(-(t.at.x - G.player.pos.x), -(t.at.z - G.player.pos.z));
      G.player.pitch = Math.atan2(t.at.y - 1.6, Math.hypot(t.at.x - G.player.pos.x, t.at.z - G.player.pos.z));
      return true;
    };
  });

  // 1. The dock pass, from the real faucet.
  const callsign = `E2E ${Math.floor(Math.random() * 9000 + 1000)}`;
  const claim = await page.evaluate(async (cs) => {
    const w = window.__G.v2.wallet;
    const r = await w.claim(cs);
    return { ok: r.ok, error: r.error, account: w.accountId(), registered: await w.registered().catch(() => "unknown") };
  }, callsign);
  check(claim.ok && claim.registered === true, "the faucet funds and registers a new guest account", `${callsign} → ${claim.account}`);

  // 2. Sign on (start_raid) and go over the fence with the issue rifle.
  const signed = await page.evaluate(() => window.__G.raid.prepare());
  check(signed === "signed", "start_raid signs the raid on", String(signed));
  await page.evaluate(() => window.__G.game.start({ skipIntro: true }));
  await page.waitForFunction(() => window.__G.game.state === "playing", null, { timeout: 20000 });
  await page.evaluate(() => {
    window.__G.player.invulnerable = true; // the drones would end a scripted raid
    setInterval(() => window.__G.game.state === "playing" && window.__G.enemies.clear(), 150);
  });
  const raid = await page.evaluate(() => JSON.parse(JSON.stringify(window.__G.v2.raid)));
  check(!!raid && raid.containers.length >= 8, "the manifest comes from the contract", `raid ${raid?.raidId}, ${raid?.containers.length} containers, ${raid?.wrecks.length} wreck(s), ${raid?.invoiceStart} on the invoice`);
  const gun = await page.evaluate(() => ({ name: window.__G.weapon.name, damage: window.__G.weapon.damage, mag: window.__G.weapon.magSize }));
  check(gun.damage === 21 && gun.mag === 24, "the issue rifle's numbers are in the shooter", JSON.stringify(gun));

  // 3. Cut seals up to the carry limit.
  let cut = 0;
  for (let i = 0; i < 4; i++) {
    const key = await page.evaluate(() => window.__G.raid.state.targets.find((t) => t.kind === "seal" && !t.bonded && window.__G.raid.state.weight + t.weight <= 6)?.key ?? null);
    if (!key) break;
    await page.evaluate((k) => (window.__at(k), (window.__hold = true)), key);
    await page.waitForFunction((k) => !window.__G.raid.state.targets.some((t) => t.key === k), key, { timeout: 8000, polling: 50 }).catch(() => {});
    await page.evaluate(() => (window.__hold = false));
    cut++;
    if (i === 0) await shot("v2-1-seal");
    await page.waitForTimeout(300);
  }
  const mid = await page.evaluate(() => ({ weight: window.__G.raid.state.weight, opened: window.__G.raid.state.opened, meter: document.querySelector(".rd-inv")?.dataset.text ?? "" }));
  check(cut >= 2 && mid.weight > 0, "seals cut, cargo carried, the invoice climbing", `${cut} seals, weight ${mid.weight}, ${mid.meter}`);

  // 4. Wait out the contract's minimum raid time, cut the uplinks, make the boat.
  const need = await page.evaluate(() => window.__G.v2.raid.startedAt + (45 + 8 * window.__G.raid.state.opened.length + 6) * 1000 - Date.now());
  console.log(`     waiting ${Math.max(0, Math.round(need / 1000))} s for the contract's minimum raid time`);
  if (need > 0) await page.waitForTimeout(need);
  await page.evaluate(async () => {
    const G = window.__G;
    for (let i = 0; i < 3; i++) (G.game.debugCut(), await new Promise((ok) => setTimeout(ok, 300)));
    const b = G.level.extraction.pos;
    G.player.pos.set(b.x, 0, b.z);
    G.player.vel.set(0, 0, 0);
  });
  await page.waitForFunction(() => window.__G.game.state === "complete", null, { timeout: 20000 });
  await page.waitForFunction(() => window.__txs.some((t) => t.method === "extract"), null, { timeout: 60000 });
  await page.waitForTimeout(1500);
  const ext = await page.evaluate(() => window.__txs.find((t) => t.method === "extract"));
  const rows = await page.evaluate(() => [...document.querySelectorAll('.menu [data-s="complete"] .rd-sec .rd-row, .menu [data-s="complete"] .rd-sec > *')].map((r) => r.textContent.replace(/\s+/g, " ").trim()).filter(Boolean).slice(0, 8));
  check(ext?.ok === true, "extract mints the haul on chain", `${ext?.txHash ?? ext?.error}`);
  check(rows.some((r) => /invoice/i.test(r)) && rows.some((r) => /arrears/i.test(r)), "the debrief shows the haul, the invoice and arrears", JSON.stringify(rows));
  await shot("v2-2-debrief");

  // 5. At the dock: what the player holds, a sale to a vendor, an export, a payment to the Harbormaster.
  const dock = await page.evaluate(async () => {
    const { chain, wallet } = window.__G.v2;
    const me = wallet.accountId();
    const bal = await chain.balances(me);
    const profile = await chain.profile(me);
    const vendors = await chain.vendors();
    const out = { bal, arrears: profile.arrears, extractions: profile.extractions };
    const pick = (ids) => ids.find((m) => (bal[m] ?? 0) > 0);
    const forMoss = pick(["copper", "chips", "servo", "rotor", "core"]);
    const forInes = pick(["meds", "fuel", "chips", "copper"]);
    const [vendor, mat] = forMoss ? ["moss", forMoss] : ["ines", forInes];
    if (mat) {
      const bid = vendors.find((v) => v.id === vendor).bids.find((q) => q.tokenId === mat);
      out.sale = { vendor, mat, bid: bid?.price, reason: bid?.reason, r: await chain.sell(vendor, mat, 1) };
    }
    const after = await chain.balances(me);
    const exp = Object.keys(after).find((k) => k !== "scrip" && ["copper", "chips", "meds", "fuel", "core", "servo", "rotor"].includes(k));
    if (exp) out.exported = { mat: exp, r: await chain.exportGoods(exp, 1) };
    out.settle = await chain.settle(10);
    out.hm = await chain.harbormaster();
    out.scrip = (await chain.balances(me)).scrip;
    return out;
  });
  check(dock.extractions === 1 && Object.keys(dock.bal).length > 1, "the haul is in the player's account", JSON.stringify(dock.bal));
  check(dock.sale?.r.ok === true, "a vendor pays its bid", dock.sale ? `${dock.sale.vendor} paid ${dock.sale.r.paid} for 1 ${dock.sale.mat} ("${dock.sale.reason}")` : "nothing to sell");
  check(!dock.exported || dock.exported.r.ok === true, "the export desk mints scrip for a material", dock.exported ? `${dock.exported.r.paid} for 1 ${dock.exported.mat}` : "nothing left to export");
  check(dock.settle.ok === true && dock.hm.balance > 0, "settling pays the Harbormaster's wallet", `cleared ${dock.settle.cleared}, ${dock.settle.arrears} still owed; its wallet holds ${dock.hm.balance}`);
  await page.click('[data-dock], .dk2-entry, button:has-text("Dock")').catch(() => {});
  await page.waitForTimeout(3000);
  await shot("v2-3-dock");

  const txs = await page.evaluate(() => window.__txs);
  for (const t of txs) console.log(`     ${t.method.padEnd(11)} ${t.ok ? "ok" : t.pending ? "pending" : "refused"}  ${t.txHash ?? ""} ${t.error ?? ""}`);
  check(errors.length === 0, "no console errors", errors.slice(0, 3).join(" | "));
} catch (e) {
  failed++;
  console.log("FAIL", String(e).slice(0, 300));
} finally {
  await browser.close();
}
console.log(failed ? `${failed} check(s) failed` : "all checks passed");
process.exit(failed ? 1 : 0);
