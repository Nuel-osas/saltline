// Headless smoke test of the raid, the in-game half of Saltline v2 (src/economy/v2/raid), on the offline mock
// (src/economy/v2/mock.ts), which plays by the contract's rules: the manifest, the report's caps, carry weight, the
// minimum raid time and the 30 s between raids.
//
//   npm run dev -- --port 5313
//   node scripts/smoke-raid.mjs [http://127.0.0.1:5313] [--shots DIR]
//
// Pointer lock doesn't work headless, so the raid is driven through window.__G: a dock pass is claimed, the mock's
// debug hooks put a B-grade Stevedore and its gear in the locker (and a wreck in the yard), DEPLOY is game.start(),
// E is held by stubbing input.down, the player is moved and faced by script, and machines are destroyed through the
// game's own damage path. The chain's startRaid, extract and die are wrapped to record what the raid sends. The
// manifest is the mock's own draw and the invoice's rates are items.ts's, so the checks read both rather than assume
// them. Five page loads:
//   1. a raid to the boat: the sign-on card, the Stevedore's numbers in the shooter, a seal (cargo, and its fee on
//      the invoice), a hound (its cost, and a servo taken by walking over it), a wreck's gun, the load limit, the
//      report the boat sends and the debrief's rows; then a refused sign-on and its off-the-books raid;
//   2. heavy arrears: a bonded container, which looks different and takes longer; then an early death to machines,
//      queued until the contract will log it, and the gun left in a wreck;
//   3. ?invoice=1100: the Bailiff rises as play begins past its threshold, and its grab kills: `bailiff`, impounded,
//      and the next loadout falls back to the issue rifle;
//   4. ?invoice=4000: every threshold fires once, in order, and the Assessor holds the boat;
//   5. no dock pass: the raid is off the books and nothing is sent.
// fps and console errors throughout. Exits non-zero if a check failed.
import { mkdirSync } from "node:fs";
import { launch } from "./browser.mjs";

const base = process.argv.find((a) => a.startsWith("http")) || "http://127.0.0.1:5313";
const shotsAt = process.argv.indexOf("--shots");
const shots = shotsAt > 0 ? process.argv[shotsAt + 1] : null;
if (shots) mkdirSync(shots, { recursive: true });

let failed = 0;
const check = (ok, what, detail = "") => {
  console.log(`${ok ? "ok  " : "FAIL"} ${what}${detail ? " — " + detail : ""}`);
  if (!ok) failed++;
};
const n = (x) => Math.round(x).toLocaleString("en-US");

const browser = await launch();
const errors = [];
const fps = [];

/** A fresh offline world with a registered player holding a B-grade Stevedore, a plate, two charges, two magazines. */
async function open(query, setup = {}) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.addInitScript(() => {
    localStorage.clear();
    localStorage.setItem("saltline.story.v1", JSON.stringify({ v: 1, briefed: true, heard: [], peak: 0 }));
    localStorage.setItem("saltline.intro.v1", "1"); // the opening film has been seen: DEPLOY goes to the sign-on
    // A player past their first raid: no checklist, and the coach's once-ever lines already said.
    localStorage.setItem("saltline.coach.v1", JSON.stringify({ v: 1, done: true, taught: [], seen: ["bailiff", "wreck", "death", "debrief"] }));
  });
  await page.goto(`${base}/?game=v2&mock=1&noaudio=1${query}`, { waitUntil: "load" });
  await page.waitForFunction(() => window.__ready === true, null, { timeout: 90000 });
  await page.waitForFunction(() => !!window.__G.raid && !!window.__G.bailiff && !!window.__G.v2 && !!window.__G.coach, null, { timeout: 15000 });
  await page.evaluate(async (setup) => {
    const G = window.__G;
    const chain = G.v2.chain;
    window.__ev = [];
    for (const name of ["raid:started", "invoice:changed", "invoice:threshold", "raid:extracted", "raid:died", "stash:changed", "bailiff:spawned", "bailiff:grab"])
      G.events.on(name, (e) => window.__ev.push({ name, t: performance.now(), e: JSON.parse(JSON.stringify(e ?? {})) }));
    window.__radio = [];
    G.events.on("radio:line", (e) => window.__radio.push({ text: e.text, who: document.querySelector(".comms-who")?.textContent }));
    // What the raid sends the chain; `__refuse` makes the next startRaid a refusal with that reason.
    window.__calls = [];
    for (const m of ["startRaid", "extract", "die"]) {
      const real = chain[m].bind(chain);
      chain[m] = async (...a) => {
        window.__calls.push({ method: m, t: performance.now(), args: JSON.parse(JSON.stringify(a)) });
        if (m === "startRaid" && window.__refuse) {
          const error = window.__refuse;
          window.__refuse = null;
          return { ok: false, error, code: "E_TOO_SOON" };
        }
        return real(...a);
      };
    }
    if (!setup.noPass) {
      const c = await G.v2.wallet.claim("SMOKE7");
      if (!c.ok) throw new Error("claim failed: " + c.error);
      const gun = chain.debug.giveGun("stevedore", { grade: "B" });
      chain.debug.give({ plate: 1, charge: 2, ammo: 2 });
      if (setup.wreck) chain.debug.addWreck({ spot: 1, frame: "pilot", grade: "C" });
      if (setup.arrears) chain.debug.setArrears(setup.arrears);
      window.__gun = gun;
      /** The loadout, set just before a sign-on (the dock's own screen keeps it between raids in real play). */
      window.__arm = () => (G.v2.loadout = { weapon: gun.serial, plates: 1, charges: 2, mags: 2 });
    }
    // The invoice's rates, as the contract's `rules` view gives them (items.ts INVOICE): the checks read them here.
    window.__inv = (await chain.rules()).invoice;
    // E, held by script.
    window.__hold = false;
    const down = G.input.down.bind(G.input);
    G.input.down = (a) => (a === "interact" && window.__hold) || down(a);
    window.__face = (tx, ty, tz) => {
      const p = G.player;
      p.yaw = Math.atan2(-(tx - p.pos.x), -(tz - p.pos.z));
      p.pitch = Math.atan2(ty - (p.pos.y + 1.6), Math.hypot(tx - p.pos.x, tz - p.pos.z));
    };
    window.__stand = (x, z) => (G.player.pos.set(x, 0, z), G.player.vel.set(0, 0, 0));
    /** Stands in front of a seal or wreck and faces it. `back` metres further out for a screenshot. */
    window.__at = (key, back = 0) => {
      const t = G.raid.state.targets.find((x) => x.key === key);
      if (!t) return false;
      const d = (t.kind === "seal" ? 1.3 : 1.5) + back;
      window.__stand(t.at.x + t.out.x * d, t.at.z + t.out.z * d);
      window.__face(t.at.x, t.at.y + (back ? 0.4 : 0), t.at.z);
      if (back) G.player.yaw -= 0.2; // the target stands left of the rifle in a screenshot
      return true;
    };
    window.__prompt = () => (document.querySelector(".h-prompt, .h-int")?.textContent ?? document.querySelector("[class*=prompt]")?.textContent ?? "").replace(/\s+/g, " ").trim();
    // Every v2 raid starts with the rifle in its crate (src/economy/v2/coach; scripts/smoke-coach.mjs covers it). This
    // test is the raid's, so each run takes the rifle the moment play begins.
    G.events.on("game:state", (e) => e.state === "playing" && G.coach?.take());
    window.__quiet = true; // the drones are not this test's business, except where it makes its own
    setInterval(() => window.__quiet && G.game.state === "playing" && G.enemies.clear(), 150);
  }, setup);
  return page;
}
const ev = (page, name) => page.evaluate((x) => window.__ev.filter((e) => e.name === x), name);
const state = (page) => page.evaluate(() => JSON.parse(JSON.stringify(window.__G.raid.state)));
const raidOf = (page) => page.evaluate(() => JSON.parse(JSON.stringify(window.__G.v2.raid)));
const meter = (page) => page.evaluate(() => ({ on: document.querySelector(".rd-inv")?.classList.contains("on"), text: document.querySelector(".rd-inv")?.dataset.text ?? "", lines: [...document.querySelectorAll(".rd-line")].map((l) => l.textContent) }));
const playing = (page) => page.waitForFunction(() => window.__G.game.state === "playing", null, { timeout: 20000 });
const sample = async (page) => fps.push(await page.evaluate(() => window.__stats().fps));
/** Holds E on a target until it is taken (or `ms` pass). Returns how long it took. */
async function takeIt(page, key, ms = 8000) {
  const t0 = Date.now();
  await page.evaluate((k) => (window.__at(k), (window.__hold = true)), key);
  await page.waitForFunction((k) => !window.__G.raid.state.targets.some((t) => t.key === k), key, { timeout: ms, polling: 50 }).catch(() => {});
  await page.evaluate(() => (window.__hold = false));
  return Date.now() - t0;
}

try {
  // ================================================================================================= 1. to the boat
  let page = await open("", { wreck: true });
  let shot = async (name) => shots && (await page.screenshot({ path: `${shots}/${name}.png` }));
  const net = await page.evaluate(() => window.__G.v2.chain.network);
  check(net === "mock", "the page runs v2 on the offline mock", net);
  const inv = await page.evaluate(() => window.__inv);
  const RATE = { seal: Number(inv.seal), weight: Number(inv.per_weight), hound: Number(inv.hound), entry: Number(inv.entry), carryPct: Number(inv.carry_in_pct), carryMax: Number(inv.carry_in_max) };
  check(Object.values(RATE).every((x) => Number.isInteger(x) && x > 0), "the invoice's rates come from the contract's rules view", JSON.stringify(RATE));

  // ---- signing on ----
  check(await page.evaluate(() => window.__G.ext.weapon.name === "PAC-9 Issue" && window.__G.ext.gateRetries === true), "before any sign-on the shooter would get the issue rifle");
  await page.evaluate(() => (window.__arm(), window.__G.game.start()));
  await page.waitForFunction(() => !document.querySelector(".rd-sign").hidden, null, { timeout: 3000 }).catch(() => {});
  await page.waitForTimeout(350);
  const card = await page.evaluate(() => ({ up: !document.querySelector(".rd-sign").hidden, title: document.querySelector(".rd-sign-t").textContent, sub: document.querySelector(".rd-sign-s").textContent, state: window.__G.game.state }));
  check(card.up && /over the fence/i.test(card.title) && card.state === "title", "DEPLOY shows the sign-on card and holds the run", JSON.stringify(card));
  await shot("0-sign-on");
  await page.waitForFunction(() => window.__G.game.state === "intro", null, { timeout: 8000 });
  const raid = await raidOf(page);
  const h = raid.harbormaster;
  const loc = (await page.evaluate(() => document.querySelector(".loc-card")?.textContent ?? "")).replace(/\s+/g, " ");
  check(loc.includes(`Raid ${raid.raidId} · Saltline Terminal`) && loc.includes(`On the invoice at the fence: ${n(raid.invoiceStart)}`), "the raid card names the raid and what is on the invoice at the fence", loc);
  await playing(page);
  await page.evaluate(() => (window.__G.player.invulnerable = true));
  const gun = await page.evaluate(async () => {
    const G = window.__G;
    const w = G.weapon;
    const held = await G.v2.chain.weapon(window.__gun.serial);
    return { name: w.name, damage: w.damage, rpm: w.rpm, mag: w.magSize, ammo: w.ammo, reserve: w.reserve, range: w.range, reload: w.reloadScale, recoil: w.recoilScale, hud: document.querySelector(".h-wname")?.textContent, maxHealth: G.player.maxHealth, charges: G.arsenal.charges(), callsign: G.ext.callsign, bonus: G.ext.waveBonus, held, sent: window.__calls.filter((c) => c.method === "startRaid").map((c) => c.args[0]) };
  });
  const s = gun.held.stats;
  check(gun.held.state === "raid" && JSON.stringify(gun.sent) === JSON.stringify([{ weapon: gun.held.serial, plates: 1, charges: 2, mags: 2 }]), "the contract has locked the gun the loadout named", `${gun.held.serial}: ${gun.held.state}`);
  check(gun.damage === s.damage && gun.rpm === s.rpm && gun.mag === s.mag && gun.range === s.range && Math.abs(gun.reload - s.reload / 100) < 1e-9 && Math.abs(gun.recoil - s.recoil / 100) < 1e-9, "the raid starts with the Stevedore's numbers in the shooter", JSON.stringify({ shooter: { damage: gun.damage, rpm: gun.rpm, mag: gun.mag, range: gun.range, reload: gun.reload, recoil: gun.recoil }, rolled: s }));
  check(gun.damage >= 16 && gun.damage <= 21 && gun.rpm >= 880 && gun.mag >= 34, "those numbers are inside the Stevedore's bands, not the baseline rifle's 26 / 720 / 30");
  check(gun.reserve === (3 + 2) * s.mag && gun.ammo === s.mag, "the reserve is (3 + 2 brought) magazines", `${gun.ammo} + ${gun.reserve}`);
  check(gun.name === "PAC-9K Stevedore · B" && gun.hud === gun.name, "the HUD names the gun", gun.hud);
  check(gun.maxHealth === 140 && gun.charges === 2, "the plate gives +40 health and the charges are on the belt", `${gun.maxHealth} hp, ${gun.charges} charges`);
  check(gun.callsign === "SMOKE7", "Control has the callsign from the profile", gun.callsign);
  check(gun.bonus && gun.bonus.alive === h.bonusDrones && gun.bonus.gull + gun.bonus.hound === h.bonusDrones, "the Harbormaster's extra Inspection Units feed the patrol and every wave", JSON.stringify({ bonusDrones: h.bonusDrones, waveBonus: gun.bonus }));
  check((await ev(page, "raid:started")).length === 1, "raid:started is emitted once");
  const m0 = await meter(page);
  const total0 = (await state(page)).total;
  check(m0.on && total0 >= raid.invoiceStart && total0 <= raid.invoiceStart + 8 && m0.text.endsWith(` · SECOND NOTICE AT ${n(h.secondNoticeAt)}`), "the invoice meter is on the HUD from the fence", m0.text);

  // ---- a seal: cargo and +80 ----
  const first = await page.evaluate(() => [...window.__G.raid.state.targets].filter((t) => t.kind === "seal" && !t.bonded).sort((a, b) => a.weight - b.weight)[0]);
  const before = (await state(page)).total;
  await takeIt(page, first.key);
  const s1 = await state(page);
  const changes = (await ev(page, "invoice:changed")).filter((e) => e.e.why !== "TIME ON SITE" && e.e.why !== "AT THE FENCE");
  check(s1.opened.includes(first.spot) && s1.weight === first.weight, "holding E cuts the seal and the cargo is carried", `${first.what}: weight ${s1.weight}`);
  check(changes.some((c) => c.e.added === RATE.seal && c.e.why === "CUSTOMS SEAL") && changes.some((c) => c.e.added === RATE.weight * first.weight && c.e.why === `CARGO · ${first.weight} WT`), "the seal adds its fee and its cargo the rate for each unit of weight", JSON.stringify(changes.map((c) => `+${c.e.added} ${c.e.why}`)));
  const rose = s1.total - before;
  const fee = RATE.seal + RATE.weight * first.weight;
  check(rose >= fee && rose <= fee + 4, "the meter rose by exactly that (and the clock)", `${before} → ${s1.total}`);
  check(await page.evaluate((w) => Math.abs(window.__G.ext.speedScale - (1 - 0.06 * w)) < 1e-9, first.weight), "the weight slows the player by 6% a unit", `weight ${first.weight}`);
  await page.waitForTimeout(250);
  const m1 = await meter(page);
  check(m1.lines.some((l) => new RegExp(`\\+${RATE.seal}\\s*CUSTOMS SEAL`).test(l)), "the line item shows under the meter", JSON.stringify(m1.lines));
  await shot("1-invoice-line-item");
  await sample(page);

  // ---- a hound: +120, and a servo on the ground ----
  const drop = await page.evaluate(async () => {
    const G = window.__G;
    window.__quiet = false;
    const out = { kills: 0, drops: 0 };
    // Destroy hounds through the game's own damage path until one drops its servo (60%, seeded by the raid).
    for (let i = 0; i < 6 && !G.raid.state.drops.length; i++) {
      const at = new G.THREE.Vector3(-2 + i * 0.5, 0, 9);
      const hound = G.enemies.spawn("hound", at, { state: "alert" });
      await new Promise((ok) => setTimeout(ok, 120));
      hound.damage(9999, new G.THREE.Vector3(at.x, 0.6, at.z), new G.THREE.Vector3(0, 0.3, -1), "body", "test");
      await new Promise((ok) => setTimeout(ok, 120));
      out.kills = G.raid.state.kills.hound;
    }
    out.drops = G.raid.state.drops.length;
    window.__quiet = true;
    return out;
  });
  const kills = (await ev(page, "invoice:changed")).filter((e) => e.e.why === "HOUND DESTROYED");
  check(drop.kills >= 1 && kills.length === drop.kills && kills.every((k) => k.e.added === RATE.hound), "a destroyed hound adds its replacement cost to the invoice", `${drop.kills} destroyed, +${RATE.hound} each`);
  check(drop.drops >= 1, "a destroyed hound can drop a servo", `${drop.drops} on the ground after ${drop.kills}`);
  if (drop.drops) {
    await page.evaluate(() => {
      const d = window.__G.raid.state.drops[0];
      window.__stand(d.at.x, d.at.z);
    });
    await page.waitForFunction(() => window.__G.raid.state.parts.servo >= 1, null, { timeout: 3000 }).catch(() => {});
    const s2 = await state(page);
    check(s2.parts.servo === 1 && s2.weight === first.weight + 1, "walking over the servo takes it", JSON.stringify({ parts: s2.parts, weight: s2.weight }));
  }

  // ---- a wreck holding a gun ----
  const wreck = raid.wrecks.find((w) => w.weapon);
  check(!!wreck, "the manifest lays out a wreck holding a gun", wreck && `${wreck.callsign}: ${wreck.weapon.frame} ${wreck.weapon.grade} ${wreck.weapon.serial}`);
  if (wreck) {
    const key = "w" + wreck.id;
    await page.evaluate((k) => window.__at(k, 2.2), key);
    await page.waitForTimeout(900);
    await shot("3-wreck-with-gun");
    const prompt = await page.evaluate(async (k) => (window.__at(k), await new Promise((ok) => setTimeout(ok, 200)), window.__prompt()), key);
    check(prompt.includes(`Recover wreck · ${wreck.callsign} · PAC-9M Pilot · ${wreck.weapon.grade}`), "the wreck's prompt names its owner and the gun it holds", prompt);
    const w0 = (await state(page)).weight;
    await takeIt(page, key);
    const s4 = await state(page);
    const gunLine = (await ev(page, "invoice:changed")).filter((e) => /RECOVERED GUN/.test(e.e.why));
    check(s4.wrecks.includes(wreck.id) && s4.weight === w0 + 2 && gunLine.length === 1 && gunLine[0].e.added === 2 * RATE.weight, "holding E takes the wreck's gun: 2 weight, on the invoice", JSON.stringify({ wrecks: s4.wrecks, weight: s4.weight, line: gunLine[0]?.e }));
    check(await page.evaluate(() => /GUN ×1/.test(document.querySelector(".rd-cargo .sv-items")?.textContent ?? "")), "the cargo readout shows what is carried", await page.evaluate(() => (document.querySelector(".rd-cargo")?.textContent ?? "").replace(/\s+/g, " ")));
  }

  // ---- the load limit: take what still fits, then the next seal is refused ----
  for (let i = 0; i < 4; i++) {
    const fits = await page.evaluate(() => window.__G.raid.state.targets.find((t) => t.kind === "seal" && window.__G.raid.state.weight + t.weight <= 6)?.key ?? null);
    if (!fits) break;
    await takeIt(page, fits);
  }
  const heavy = await page.evaluate(() => window.__G.raid.state.targets.find((t) => t.kind === "seal" && window.__G.raid.state.weight + t.weight > 6) ?? null);
  if (heavy) {
    const w0 = (await state(page)).weight;
    await page.evaluate((k) => (window.__at(k), (window.__hold = true)), heavy.key);
    await page.waitForTimeout(2200);
    const said = await page.evaluate(() => window.__prompt());
    await page.evaluate(() => (window.__hold = false));
    const s5 = await state(page);
    check(!s5.opened.includes(heavy.spot) && s5.weight === w0 && /Too heavy/.test(said), "over the limit a seal is refused", `carrying ${w0}, ${heavy.what} weighs ${heavy.weight}: "${said}"`);
  } else console.log("     (every seal left on this manifest fits: the refusal is covered in vitest)");
  await sample(page);
  // The Harbormaster waits its turn (8 s between its lines): give it time for the greeting and one bill.
  await page.waitForFunction(() => window.__radio.filter((r) => r.who === "Harbormaster").length >= 2, null, { timeout: 45000 }).catch(() => {});

  // ---- the boat ----
  const carried = await state(page);
  await page.evaluate(async () => {
    const G = window.__G;
    for (let i = 0; i < 3; i++) (G.game.debugCut(), await new Promise((ok) => setTimeout(ok, 300)));
    const b = G.level.extraction.pos;
    window.__stand(b.x, b.z);
  });
  await page.waitForFunction(() => window.__G.game.state === "complete", null, { timeout: 20000 });
  const pendingRows = await page.evaluate(() => [...document.querySelectorAll('.menu [data-s="complete"] .rd-row')].map((r) => r.textContent));
  check(pendingRows.length === 6 && pendingRows.some((r) => /settling/.test(r)), "the debrief shows the raid settling while the boat's report is on its way", JSON.stringify(pendingRows.slice(3)));
  await page.waitForFunction(() => window.__ev.some((e) => e.name === "raid:extracted"), null, { timeout: 150000 });
  const sent = await page.evaluate(() => window.__calls.find((c) => c.method === "extract")?.args ?? null);
  const r = sent?.[1];
  check(!!r && sent[0] === raid.raidId && JSON.stringify(r.opened) === JSON.stringify(carried.opened) && JSON.stringify(r.wrecks) === JSON.stringify(carried.wrecks) && r.uplinks === 3, "the boat reports the seals opened, the wreck recovered and three uplinks", JSON.stringify(r));
  check(!!r && r.parts.servo === carried.parts.servo && r.parts.servo <= r.kills.hound && r.kills.hound === drop.kills && r.kills.gull === 0, "parts and kills are reported as they happened, parts never over kills", JSON.stringify(r && { parts: r.parts, kills: r.kills }));
  check(!!r && r.used.plates === 1 && r.used.charges === 0 && r.used.mags === 0, "gear used: the plate, no charges, no brought magazines", JSON.stringify(r?.used));
  const out = (await ev(page, "raid:extracted"))[0]?.e;
  check(out?.ok === true && typeof out.invoice === "number" && typeof out.arrears === "number", "the mock accepts the report: raid:extracted carries its invoice and the arrears", JSON.stringify(out));
  check((await ev(page, "stash:changed")).length >= 1, "stash:changed follows the confirmed extraction");
  const bills = await page.evaluate(() => window.__radio.filter((x) => x.who === "Harbormaster").map((x) => x.text));
  const midRaid = /Tampering with a customs seal|Inspection Unit has been written off|units of evidence|Second notice/;
  check(bills[0]?.includes(`trespass surcharge of ${raid.invoiceStart} scrip`) && bills.slice(1).some((t) => midRaid.test(t)) && /Removal of goods noted\. An invoice for \d+ scrip/.test(bills[bills.length - 1] ?? ""), "the Harbormaster bills on its channel: the fence first, what was done, then the boat", JSON.stringify(bills.map((t) => t.slice(0, 44))));
  const rows = await page.evaluate(() => [...document.querySelectorAll('.menu [data-s="complete"] .rd-row')].map((x) => `${x.querySelector("dt").textContent}: ${x.querySelector("dd").textContent}`));
  check(
    rows.length === 6 &&
      /^Haul: .*×\d/.test(rows[0]) &&
      rows[1] === `Your gun: Stevedore ${gun.held.serial} · B · condition 95` &&
      (wreck ? rows[2].startsWith(`Guns recovered: Pilot ${wreck.weapon.serial} · ${wreck.weapon.grade} · condition ${wreck.weapon.condition - 15}`) : /^Guns recovered/.test(rows[2])) &&
      rows[3] === `Invoice: ${n(out?.invoice ?? -1)} scrip` &&
      rows[4] === `Arrears now: ${n(out?.arrears ?? -1)} scrip` &&
      /^Ledger: /.test(rows[5]),
    "the debrief shows the haul, the gun and its wear, guns recovered, the invoice, arrears and the ledger",
    JSON.stringify(rows),
  );
  check(await page.evaluate(() => window.__G.bailiff.list.length === 0 && window.__G.v2.raid === null && !document.querySelector(".rd-inv").classList.contains("on")), "after the boat the yard is cleared and the meter is off");
  await page.waitForTimeout(600);
  await shot("4-debrief");

  // ---- a refused sign-on, and the raid off the books ----
  const refused = await page.evaluate(async () => {
    const G = window.__G;
    window.__refuse = "Too soon. Wait 12 s between raids.";
    window.__arm();
    G.game.start({ quick: true }); // "Redeploy" on the debrief
    await new Promise((ok) => setTimeout(ok, 1800));
    const card = { offer: document.querySelector(".rd-sign").classList.contains("offer"), title: document.querySelector(".rd-sign-t").textContent, why: document.querySelector(".rd-sign-s").textContent, state: G.game.state };
    document.querySelector(".rd-yes").click();
    await new Promise((ok) => setTimeout(ok, 2600));
    return { card, state: G.game.state, mode: G.raid.state.mode, weapon: G.weapon.name, damage: G.weapon.damage, mag: G.weapon.magSize, targets: G.raid.state.targets.length, meter: document.querySelector(".rd-inv").classList.contains("on"), hp: G.player.maxHealth, raid: G.v2.raid, ends: window.__calls.filter((c) => c.method !== "startRaid").length };
  });
  check(refused.card.offer && /not signed/i.test(refused.card.title) && /Too soon/.test(refused.card.why) && refused.card.state === "complete", "a refused sign-on holds the retry and says why", JSON.stringify(refused.card));
  check(refused.state === "playing" && refused.mode === "offbooks" && refused.weapon === "PAC-9 Issue" && refused.damage === 21 && refused.mag === 24 && refused.targets === 0 && !refused.meter && refused.hp === 100 && refused.raid === null, "the raid off the books is the issue rifle with no loot and no invoice", JSON.stringify({ ...refused, card: undefined }));
  await sample(page);
  await page.close();

  // ======================================================================== 2. heavy arrears: a bonded container
  page = await open("", { arrears: 1200 });
  shot = async (name) => shots && (await page.screenshot({ path: `${shots}/${name}.png` }));
  await page.evaluate(() => window.__arm());
  check((await page.evaluate(() => window.__G.raid.prepare())) === "signed", "prepare() signs on without the title's DEPLOY");
  await page.evaluate(() => window.__G.game.start({ skipIntro: true }));
  await playing(page);
  await page.evaluate(() => (window.__G.player.invulnerable = true));
  const owing = await raidOf(page);
  const bonded = await page.evaluate(() => window.__G.raid.state.targets.filter((t) => t.bonded));
  const carriedIn = Math.min(RATE.carryMax, Math.floor((1200 * RATE.carryPct) / 100));
  check(owing.invoiceStart === RATE.entry + carriedIn && bonded.length === 2 && owing.containers.length === 10, "1,200 in arrears: its share is on the meter at the fence, and two bonded containers are on the manifest", JSON.stringify({ at: owing.invoiceStart, carriedIn, bonded: bonded.map((b) => b.what) }));
  if (bonded.length) {
    await page.evaluate((k) => window.__at(k, 1.9), bonded[0].key);
    await page.waitForTimeout(1000);
    await shot("2-bonded-container");
    const plain = await page.evaluate(() => window.__G.raid.state.targets.find((t) => t.kind === "seal" && !t.bonded && t.weight <= 2).key);
    const plainMs = await takeIt(page, plain);
    const bondMs = await takeIt(page, bonded[0].key);
    const lines = (await ev(page, "invoice:changed")).map((e) => e.e.why);
    check((await state(page)).opened.includes(bonded[0].spot) && bondMs > 2900 && bondMs > plainMs * 1.6 && lines.includes("BONDED SEAL"), "a bonded seal takes twice as long to cut", `${(plainMs / 1000).toFixed(1)} s customs, ${(bondMs / 1000).toFixed(1)} s bonded`);
  }
  await sample(page);
  // ---- killed by machines, early: the contract won't log a death younger than 8 s a container, so it is queued ----
  const opened = (await state(page)).opened.length;
  await page.evaluate(() => ((window.__G.player.invulnerable = false), window.__G.player.damage(9999)));
  await page.waitForTimeout(400);
  const queued = await page.evaluate(() => ({ sent: window.__calls.some((c) => c.method === "die"), ledger: [...document.querySelectorAll('.menu [data-s="dead"] .rd-row')].pop()?.textContent ?? "", age: (performance.now() - window.__ev.find((e) => e.name === "raid:started").t) / 1000 }));
  if (queued.age < 8 * opened) check(!queued.sent && /logging in \d+ s/.test(queued.ledger), "a death younger than the contract allows is queued, and the card says so", `${queued.age.toFixed(1)} s old, ${opened} containers opened: "${queued.ledger}"`);
  else console.log(`     (the raid was already ${queued.age.toFixed(0)} s old: nothing to wait for)`);
  await page.waitForFunction(() => window.__ev.some((e) => e.name === "raid:died"), null, { timeout: 40000 }).catch(() => {});
  const fell = await page.evaluate(async () => {
    const G = window.__G;
    const die = window.__calls.find((c) => c.method === "die");
    const started = window.__calls.find((c) => c.method === "startRaid");
    await new Promise((ok) => setTimeout(ok, 300));
    return { age: die ? (die.t - started.t) / 1000 : null, by: die?.args[3], spot: die?.args[2], ev: window.__ev.find((e) => e.name === "raid:died")?.e, rows: [...document.querySelectorAll('.menu [data-s="dead"] .rd-row')].map((x) => `${x.querySelector("dt").textContent}: ${x.querySelector("dd").textContent}`), wrecks: (await G.v2.chain.wrecks()).filter((w) => w.weapon?.serial === window.__gun.serial).length };
  });
  check(fell.age !== null && fell.age >= 8 * opened && fell.by === "machines" && fell.ev?.by === "machines" && fell.ev?.impounded === false, "the death is sent once the raid is old enough, as `machines`", JSON.stringify({ age: fell.age?.toFixed(1), need: 8 * opened, by: fell.by, ev: fell.ev }));
  check(/^Your gun: LEFT IN A WRECK (by the shed|on the quay|by the gate|in the yard) · someone may carry it out$/.test(fell.rows[0] ?? "") && fell.wrecks === 1, "the dead card says the gun is in a wreck, and the mock holds that wreck", JSON.stringify(fell.rows));
  await page.close();

  // ================================================================================ 3. ?invoice=1100: the Bailiff
  page = await open("&invoice=1100");
  shot = async (name) => shots && (await page.screenshot({ path: `${shots}/${name}.png` }));
  await page.evaluate(() => window.__arm());
  await page.evaluate(() => window.__G.raid.prepare());
  await page.evaluate(() => window.__G.game.start({ skipIntro: true }));
  await playing(page);
  const startedAt = Date.now();
  await page.evaluate(() => ((window.__G.player.invulnerable = true), window.__stand(-30, 8))); // beside the rifle crate, not in it
  await page.waitForFunction(() => window.__ev.some((e) => e.name === "bailiff:spawned"), null, { timeout: 6000 }).catch(() => {});
  const hunted = await raidOf(page);
  const th = (await ev(page, "invoice:threshold")).map((e) => e.e);
  const born = await page.evaluate(() => ({ n: window.__G.bailiff.list.length, at: window.__G.bailiff.units[0] && { x: window.__G.bailiff.units[0].handle.pos.x, z: window.__G.bailiff.units[0].handle.pos.z }, total: window.__G.raid.state.total }));
  check(th.length === 2 && th[0].what === "second_notice" && th[0].at === hunted.harbormaster.secondNoticeAt && th[1].what === "bailiff" && th[1].at === hunted.harbormaster.bailiffAt, "past the Bailiff's threshold at the fence: second notice, then final demand, each once", JSON.stringify(th));
  check(born.n === 1 && born.total >= hunted.invoiceStart + 1100 && born.total >= hunted.harbormaster.bailiffAt && born.at && born.at.x > -24 && born.at.x < 16 && born.at.z < -10, "the Bailiff rises in the shed as the meter passes its threshold", JSON.stringify({ ...born, bailiffAt: hunted.harbormaster.bailiffAt }));
  const m2 = await meter(page);
  check(m2.text.endsWith(` · SECOND BAILIFF AT ${n(hunted.harbormaster.secondBailiffAt)}`), "the meter names what is next", m2.text);
  await page.waitForFunction(() => /final demand/i.test(document.querySelector(".rd-inv .h-k")?.textContent ?? ""), null, { timeout: 8000 }).catch(() => {});
  await page.evaluate(() => {
    const u = window.__G.bailiff.units[0];
    window.__stand(u.handle.pos.x + 5.2, u.handle.pos.z + 1.6);
    window.__face(u.handle.pos.x, 1.5, u.handle.pos.z);
    window.__G.player.yaw -= 0.16;
  });
  await page.waitForTimeout(700);
  const flag = await page.evaluate(() => ({ k: document.querySelector(".rd-inv .h-k")?.textContent, warn: document.querySelector(".h-warn")?.textContent }));
  check(/final demand/i.test(flag.k ?? "") && /final demand/i.test(flag.warn ?? ""), "the HUD announces the final demand", JSON.stringify(flag));
  await shot("5-bailiff-final-demand");
  await sample(page);
  // One radio, three voices: the Harbormaster bills on its channel, its officer speaks under its own label.
  await page.waitForFunction(() => window.__radio.some((x) => /officer has been dispatched/.test(x.text)), null, { timeout: 40000 }).catch(() => {});
  const radio = await page.evaluate(() => window.__radio);
  const who = (re) => radio.find((x) => re.test(x.text))?.who;
  const control = radio.find((x) => /Control\./.test(x.text));
  check(who(/trespass surcharge of \d+ scrip/) === "Harbormaster" && who(/officer has been dispatched/) === "Bailiff" && (!control || control.who === "Control"), "the radio labels each voice: Control, the Harbormaster's bill, the Bailiff", JSON.stringify(radio.map((x) => `${x.who}: ${x.text.slice(0, 34)}`)));
  // It kills: vulnerable, nearly dead, standing still in front of it.
  await page.evaluate(() => {
    const G = window.__G;
    G.player.invulnerable = false;
    window.__pin = setInterval(() => {
      const u = G.bailiff.units[0];
      if (!u || !G.player.alive) return;
      G.player.health = Math.min(G.player.health, 30);
      window.__stand(u.handle.pos.x + 1.2, u.handle.pos.z + 0.6);
    }, 100);
  });
  await page.waitForFunction(() => window.__ev.some((e) => e.name === "raid:died"), null, { timeout: 30000 }).catch(() => {});
  await page.evaluate(() => clearInterval(window.__pin));
  const died = (await ev(page, "raid:died"))[0]?.e;
  const dieArgs = await page.evaluate(() => window.__calls.find((c) => c.method === "die")?.args ?? null);
  check(died?.by === "bailiff" && died.impounded === true, "killed by the Bailiff's grab: raid:died says bailiff, and the mock impounds the gun", JSON.stringify(died));
  check(!!dieArgs && dieArgs[0] === hunted.raidId && dieArgs[3] === "bailiff" && Number.isInteger(dieArgs[2]) && dieArgs[2] >= 0 && dieArgs[2] < 16, "chain.die was sent `bailiff` and the nearest spot", JSON.stringify(dieArgs?.slice(2)));
  await page.waitForFunction(() => /Ledger/.test(document.querySelector('.menu [data-s="dead"] .rd-sec')?.textContent ?? "") && !/logging/.test(document.querySelector('.menu [data-s="dead"] .rd-sec')?.textContent ?? ""), null, { timeout: 8000 }).catch(() => {});
  const serial = await page.evaluate(() => window.__gun.serial);
  const deadRows = await page.evaluate(() => [...document.querySelectorAll('.menu [data-s="dead"] .rd-row')].map((x) => `${x.querySelector("dt").textContent}: ${x.querySelector("dd").textContent}`));
  check(deadRows[0] === `Your gun: IMPOUNDED · Stevedore ${serial} · buy it back at the dock within 48 hours` && /^Invoice: [\d,]+ scrip$/.test(deadRows[1] ?? "") && /^Arrears now: [\d,]+ scrip$/.test(deadRows[2] ?? ""), "the dead card says the gun is impounded, with the invoice and the arrears", JSON.stringify(deadRows));
  const pound = await page.evaluate(async () => (await window.__G.v2.chain.impound(window.__G.v2.wallet.accountId())).map((i) => i.weapon.serial));
  check(pound.includes(serial), "the gun is in the mock's impound", JSON.stringify(pound));
  await page.waitForFunction(() => window.__G.game.state === "dead", null, { timeout: 10000 }).catch(() => {});
  await page.waitForTimeout(2600); // the card comes up 1.5 s into the death camera
  await shot("6-dead-impounded");
  // The next raid (the contract wants 30 s between starts): the gun and the gear are gone, so the loadout falls back.
  await page.waitForTimeout(Math.max(0, 32000 - (Date.now() - startedAt)));
  const again = await page.evaluate(async () => {
    const G = window.__G;
    window.__arm();
    const kind = await G.raid.prepare();
    return { kind, weapon: G.ext.weapon.name, sent: window.__calls.filter((c) => c.method === "startRaid").pop()?.args[0] };
  });
  check(again.kind === "signed" && again.weapon === "PAC-9 Issue" && JSON.stringify(again.sent) === JSON.stringify({ weapon: null, plates: 0, charges: 0, mags: 0 }), "the impounded gun's loadout falls back to the issue rifle, and gear no longer held isn't asked for", JSON.stringify(again));
  await page.close();

  // ============================================================================ 4. ?invoice=4000: every threshold
  page = await open("&invoice=4000");
  await page.evaluate(() => window.__arm());
  await page.evaluate(() => window.__G.raid.prepare());
  await page.evaluate(() => window.__G.game.start({ skipIntro: true }));
  await playing(page);
  await page.evaluate(() => ((window.__G.player.invulnerable = true), window.__stand(-30, 8))); // beside the rifle crate, not in it
  await page.waitForFunction(() => !!window.__G.boss?.fight, null, { timeout: 8000 }).catch(() => {});
  await page.waitForTimeout(1500);
  const last = await raidOf(page);
  const all = (await ev(page, "invoice:threshold")).map((e) => e.e.what);
  const yard = await page.evaluate(() => ({ bailiffs: window.__G.bailiff.list.length, boss: !!window.__G.boss?.fight, cores: document.querySelectorAll(".as-cores i").length, blocked: !!window.__G.ext.extractBlocked?.(), meter: document.querySelector(".rd-inv").dataset.text }));
  check(JSON.stringify(all) === JSON.stringify(["second_notice", "bailiff", "second_bailiff", "foreclosure"]), "past 4,000: all four thresholds, once each, in order", JSON.stringify(all));
  check(yard.bailiffs === 2 && yard.boss && yard.cores === 3 + Math.floor(last.harbormaster.strength / 20), "two Bailiffs stand and the Assessor is summoned with 3 + floor(strength / 20) cores", JSON.stringify({ ...yard, strength: last.harbormaster.strength }));
  check(yard.blocked, "the Assessor holds the boat while it stands");
  await page.waitForTimeout(3000);
  await sample(page);
  if (shots) await page.screenshot({ path: `${shots}/7-foreclosure.png` });
  await page.close();

  // =========================================================================== 5. no dock pass: off the books
  page = await open("", { noPass: true });
  await page.evaluate(() => window.__G.game.start());
  await playing(page);
  await page.waitForFunction(() => window.__radio.some((x) => /No dock pass on file/.test(x.text)), null, { timeout: 15000 }).catch(() => {});
  const bare = await page.evaluate(() => {
    const G = window.__G;
    return { mode: G.raid.state.mode, weapon: G.weapon.name, sent: window.__calls.length, cardDown: document.querySelector(".rd-sign").hidden, meter: document.querySelector(".rd-inv").classList.contains("on"), targets: G.raid.state.targets.length, said: window.__radio.find((x) => /No dock pass on file/.test(x.text))?.who ?? null };
  });
  check(bare.mode === "offbooks" && bare.weapon === "PAC-9 Issue" && bare.sent === 0 && bare.cardDown && !bare.meter && bare.targets === 0 && bare.said === "Control", "without a dock pass the raid is off the books: nothing is sent, no card asks twice, and Control says why", JSON.stringify(bare));
  await page.close();

  // ---- throughout ----
  check(Math.min(...fps) >= 50, "fps stays near 60", fps.map((f) => Math.round(f)).join(", "));
  check(errors.length === 0, "no console errors", errors.slice(0, 4).join(" | "));
} finally {
  await browser.close();
}
console.log(failed ? `\n${failed} check(s) failed` : "\nall checks passed");
process.exit(failed ? 1 : 0);
