// Headless smoke test of the raid, the in-game half of Saltline v2 (src/economy/v2/raid), on the dev fake (or the
// offline mock once it is merged: anything that sets G.v2 with a `mock` chain).
//
//   npm run dev -- --port 5313
//   node scripts/smoke-raid.mjs [http://127.0.0.1:5313] [--shots DIR]
//
// Pointer lock doesn't work headless, so the raid is driven through window.__G: DEPLOY is game.start(), E is held by
// stubbing input.down, the player is moved and faced by script, and machines are destroyed through the game's own
// damage path. Three page loads:
//   1. a raid to the boat: the sign-on card, the Stevedore's numbers in the shooter, a seal (cargo and +80), a hound
//      (+120, and a servo taken by walking over it), a bonded container, a wreck holding a gun, the report the boat
//      sends and the debrief's rows; then a refused sign-on and its off-the-books raid;
//   2. ?invoice=1100: the Bailiff rises as play begins past 1,200, and its grab kills: `bailiff`, impounded;
//   3. ?invoice=4000: every threshold fires once, in order, and the Assessor holds the boat.
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

const browser = await launch();
const errors = [];
const fps = [];

async function open(query) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.addInitScript(() => {
    localStorage.clear();
    localStorage.setItem("saltline.story.v1", JSON.stringify({ v: 1, briefed: true, heard: [], peak: 0 }));
  });
  await page.goto(`${base}/?game=v2&noaudio=1${query}`, { waitUntil: "load" });
  await page.waitForFunction(() => window.__ready === true, null, { timeout: 90000 });
  await page.waitForFunction(() => !!window.__G.raid && !!window.__G.bailiff && !!window.__G.v2, null, { timeout: 15000 });
  await page.evaluate(() => {
    const G = window.__G;
    window.__ev = [];
    for (const name of ["raid:started", "invoice:changed", "invoice:threshold", "raid:extracted", "raid:died", "stash:changed", "bailiff:spawned", "bailiff:grab"])
      G.events.on(name, (e) => window.__ev.push({ name, t: performance.now(), e: JSON.parse(JSON.stringify(e ?? {})) }));
    window.__radio = [];
    G.events.on("radio:line", (e) => window.__radio.push({ text: e.text, who: document.querySelector(".comms-who")?.textContent }));
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
    window.__calm = setInterval(() => window.__quiet && G.game.state === "playing" && G.enemies.clear(), 150);
    window.__quiet = true;
  });
  return page;
}
const ev = (page, name) => page.evaluate((n) => window.__ev.filter((e) => e.name === n), name);
const state = (page) => page.evaluate(() => JSON.parse(JSON.stringify(window.__G.raid.state)));
const meter = (page) => page.evaluate(() => ({ on: document.querySelector(".rd-inv")?.classList.contains("on"), text: document.querySelector(".rd-inv")?.dataset.text ?? "", lines: [...document.querySelectorAll(".rd-line")].map((l) => l.textContent) }));
const playing = (page) => page.waitForFunction(() => window.__G.game.state === "playing", null, { timeout: 20000 });
const sample = async (page) => fps.push(await page.evaluate(() => window.__stats().fps));
/** Holds E on a target until it is taken. */
async function takeIt(page, key) {
  await page.evaluate((k) => (window.__at(k), (window.__hold = true)), key);
  await page.waitForFunction((k) => !window.__G.raid.state.targets.some((t) => t.key === k), key, { timeout: 8000 }).catch(() => {});
  await page.evaluate(() => (window.__hold = false));
}

try {
  // ================================================================================================= 1. to the boat
  let page = await open("");
  const shot = async (name) => shots && (await page.screenshot({ path: `${shots}/${name}.png` }));
  const fake = await page.evaluate(() => window.__G.v2.chain.network);
  console.log(`     G.v2 chain: ${fake}`);

  // ---- signing on ----
  check(await page.evaluate(() => window.__G.ext.weapon.name === "PAC-9 Issue" && window.__G.ext.gateRetries === true), "before any sign-on the shooter would get the issue rifle");
  await page.evaluate(() => window.__G.game.start());
  await page.waitForFunction(() => !document.querySelector(".rd-sign").hidden, null, { timeout: 3000 }).catch(() => {});
  const card = await page.evaluate(() => ({ up: !document.querySelector(".rd-sign").hidden, title: document.querySelector(".rd-sign-t").textContent, sub: document.querySelector(".rd-sign-s").textContent, state: window.__G.game.state }));
  check(card.up && /over the fence/i.test(card.title) && card.state === "title", "DEPLOY shows the sign-on card and holds the run", JSON.stringify(card));
  await shot("0-sign-on");
  await page.waitForFunction(() => window.__G.game.state === "intro", null, { timeout: 8000 });
  const loc = await page.evaluate(() => document.querySelector(".loc-card")?.textContent ?? "");
  check(/Raid \d+ · Saltline Terminal/i.test(loc) && /On the invoice at the fence: 175/.test(loc), "the raid card names the raid and what is on the invoice at the fence", loc.replace(/\s+/g, " "));
  await playing(page);
  await page.evaluate(() => (window.__G.player.invulnerable = true));
  const gun = await page.evaluate(() => {
    const G = window.__G;
    const w = G.weapon;
    return { name: w.name, damage: w.damage, rpm: w.rpm, mag: w.magSize, ammo: w.ammo, reserve: w.reserve, range: w.range, reload: w.reloadScale, recoil: w.recoilScale, hud: document.querySelector(".h-wname")?.textContent, maxHealth: G.player.maxHealth, charges: G.arsenal.charges(), raid: G.v2.raid?.raidId, calls: G.v2.calls?.map((c) => c.method), callsign: G.ext.callsign, bonus: G.ext.waveBonus, drones: G.v2.raid?.harbormaster.bonusDrones };
  });
  check(gun.bonus && gun.bonus.alive === gun.drones && gun.bonus.gull + gun.bonus.hound === gun.drones, "the Harbormaster's extra Inspection Units feed the patrol and every wave", JSON.stringify({ bonusDrones: gun.drones, waveBonus: gun.bonus }));
  check(gun.damage === 20 && gun.rpm === 970 && gun.mag === 40 && gun.range === 172 && gun.reload === 0.85 && gun.recoil === 0.8, "the raid starts with the Stevedore's numbers in the shooter", JSON.stringify(gun));
  check(gun.reserve === (3 + 2) * 40 && gun.ammo === 40, "the reserve is (3 + 2 brought) × 40", `${gun.ammo} + ${gun.reserve}`);
  check(/Stevedore/.test(gun.name) && /Stevedore/.test(gun.hud ?? ""), "the HUD names the gun", gun.hud);
  check(gun.maxHealth === 140 && gun.charges === 2, "the plate gives +40 health and the charges are on the belt", `${gun.maxHealth} hp, ${gun.charges} charges`);
  check(gun.raid != null && gun.callsign === "ROOK", "G.v2.raid is the raid in play and Control has the callsign", `raid ${gun.raid}, ${gun.callsign}`);
  check((await ev(page, "raid:started")).length === 1, "raid:started is emitted once");
  const m0 = await meter(page);
  check(m0.on && /^INVOICE 1\d\d · SECOND NOTICE AT 600$/.test(m0.text), "the invoice meter is on the HUD from the fence", m0.text);

  // ---- a seal: cargo and +80 ----
  const before = (await state(page)).total;
  await takeIt(page, "s4"); // chips ×1
  const s1 = await state(page);
  const changes = (await ev(page, "invoice:changed")).filter((e) => e.e.why !== "TIME ON SITE" && e.e.why !== "AT THE FENCE");
  check(s1.opened.includes(4) && s1.weight === 1, "holding E cuts the seal and the cargo is carried", JSON.stringify({ opened: s1.opened, weight: s1.weight }));
  check(changes.some((c) => c.e.added === 80 && c.e.why === "CUSTOMS SEAL") && changes.some((c) => c.e.added === 40 && /CARGO · 1 WT/.test(c.e.why)), "the seal adds 80 and its cargo 40 a unit of weight", JSON.stringify(changes.map((c) => `+${c.e.added} ${c.e.why}`)));
  check(s1.total - before >= 120 && s1.total - before <= 124, "the meter rose by 120 (and the clock)", `${before} → ${s1.total}`);
  check(await page.evaluate(() => Math.abs(window.__G.ext.speedScale - 0.94) < 1e-9), "a unit of weight slows the player to 94%");
  await page.waitForTimeout(250);
  const m1 = await meter(page);
  check(m1.lines.some((l) => /\+80\s*CUSTOMS SEAL/.test(l)), "the line item shows under the meter", JSON.stringify(m1.lines));
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
      const h = G.enemies.spawn("hound", at, { state: "alert" });
      await new Promise((ok) => setTimeout(ok, 120));
      h.damage(9999, new G.THREE.Vector3(at.x, 0.6, at.z), new G.THREE.Vector3(0, 0.3, -1), "body", "test");
      await new Promise((ok) => setTimeout(ok, 120));
      out.kills = G.raid.state.kills.hound;
    }
    out.drops = G.raid.state.drops.length;
    window.__quiet = true;
    return out;
  });
  const kills = (await ev(page, "invoice:changed")).filter((e) => e.e.why === "HOUND DESTROYED");
  check(drop.kills >= 1 && kills.length === drop.kills && kills.every((k) => k.e.added === 120), "a destroyed hound adds 120 to the invoice", `${drop.kills} destroyed`);
  check(drop.drops >= 1, "a destroyed hound can drop a servo", `${drop.drops} on the ground after ${drop.kills}`);
  if (drop.drops) {
    await page.evaluate(() => {
      const d = window.__G.raid.state.drops[0];
      window.__stand(d.at.x, d.at.z);
    });
    await page.waitForFunction(() => window.__G.raid.state.parts.servo >= 1, null, { timeout: 3000 }).catch(() => {});
    const s2 = await state(page);
    check(s2.parts.servo === 1 && s2.weight === 2, "walking over the servo takes it", JSON.stringify({ parts: s2.parts, weight: s2.weight }));
  }

  // ---- a bonded container and a wreck holding a gun ----
  await page.evaluate(() => window.__at("s12", 2.6));
  await page.waitForTimeout(900);
  await shot("2-bonded-container");
  const t0 = Date.now();
  await takeIt(page, "s12"); // bonded: core ×2
  const bondMs = Date.now() - t0;
  const s3 = await state(page);
  check(s3.opened.includes(12) && bondMs > 2800, "a bonded seal takes twice as long to cut", `${(bondMs / 1000).toFixed(1)} s`);
  await page.evaluate(() => window.__at("w301", 2.2));
  await page.waitForTimeout(900);
  await shot("3-wreck-with-gun");
  const prompt = await page.evaluate(async () => {
    window.__at("w301");
    await new Promise((ok) => setTimeout(ok, 200));
    return document.querySelector(".h-prompt, .h-int")?.textContent ?? document.querySelector("[class*=prompt]")?.textContent ?? "";
  });
  check(/Recover wreck · MARLOWE · PAC-9M Pilot · C/.test(prompt), "the wreck's prompt names its owner and the gun it holds", prompt.replace(/\s+/g, " ").trim());
  await takeIt(page, "w301"); // the Pilot: 2 weight, to the limit
  const s4 = await state(page);
  const gunLine = (await ev(page, "invoice:changed")).filter((e) => /RECOVERED GUN/.test(e.e.why));
  check(s4.wrecks.includes(301) && s4.weight === 6 && gunLine.length === 1 && gunLine[0].e.added === 80, "holding E takes the wreck's gun: 2 weight, on the invoice", JSON.stringify({ wrecks: s4.wrecks, weight: s4.weight, line: gunLine[0]?.e }));
  check(await page.evaluate(() => /GUN ×1/.test(document.querySelector(".rd-cargo .sv-items")?.textContent ?? "") && document.querySelector(".rd-cargo .sv-load b")?.textContent === "6/6"), "the cargo readout shows what is carried", await page.evaluate(() => document.querySelector(".rd-cargo")?.textContent ?? ""));
  await page.evaluate(() => (window.__at("s0"), (window.__hold = true)));
  await page.waitForTimeout(2200);
  const heavy = await page.evaluate(() => document.querySelector(".h-prompt, .h-int")?.textContent ?? document.querySelector("[class*=prompt]")?.textContent ?? "");
  await page.evaluate(() => (window.__hold = false));
  const s5 = await state(page);
  check(!s5.opened.includes(0) && s5.weight === 6, "over the limit a seal is refused", heavy.replace(/\s+/g, " ").trim());
  await sample(page);

  // The Harbormaster waits its turn (8 s between its lines): give it time for the greeting and one bill.
  await page.waitForFunction(() => window.__radio.filter((r) => r.who === "Harbormaster").length >= 2, null, { timeout: 45000 }).catch(() => {});

  // ---- the boat ----
  await page.evaluate(async () => {
    const G = window.__G;
    for (let i = 0; i < 3; i++) (G.game.debugCut(), await new Promise((ok) => setTimeout(ok, 300)));
    const b = G.level.extraction.pos;
    window.__stand(b.x, b.z);
  });
  await page.waitForFunction(() => window.__G.game.state === "complete", null, { timeout: 20000 });
  await page.waitForFunction(() => window.__ev.some((e) => e.name === "raid:extracted"), null, { timeout: 90000 });
  const sent = await page.evaluate(() => window.__G.v2.calls?.find((c) => c.method === "extract")?.args ?? null);
  const s6 = await state(page);
  if (sent) {
    const r = sent[1];
    check(JSON.stringify(r.opened) === "[4,12]" && JSON.stringify(r.wrecks) === "[301]" && r.uplinks === 3, "the boat reports the seals opened, the wreck recovered and three uplinks", JSON.stringify(r));
    check(r.parts.servo === s6.parts.servo && r.parts.servo <= r.kills.hound && r.kills.hound === drop.kills && r.kills.gull === 0, "parts and kills are reported as they happened, parts never over kills", JSON.stringify({ parts: r.parts, kills: r.kills }));
    check(r.used.plates === 1 && r.used.charges === 0 && r.used.mags === 0, "gear used: the plate, no charges, no brought magazines", JSON.stringify(r.used));
  } else check(fake !== "mock" || false, "the extract call was recorded (dev fake only)");
  const out = (await ev(page, "raid:extracted"))[0]?.e;
  check(out?.ok === true && typeof out.invoice === "number" && typeof out.arrears === "number", "raid:extracted carries the contract's invoice and arrears", JSON.stringify(out));
  check((await ev(page, "stash:changed")).length === 1, "stash:changed follows the confirmed extraction");
  const bills = await page.evaluate(() => window.__radio.filter((r) => r.who === "Harbormaster").map((r) => r.text));
  const midRaid = /Tampering with a customs seal|Inspection Unit has been written off|units of evidence|Second notice/;
  check(/trespass surcharge of 175 scrip/.test(bills[0] ?? "") && bills.slice(1).some((t) => midRaid.test(t)) && /Removal of goods noted\. An invoice for \d+ scrip/.test(bills[bills.length - 1] ?? ""), "the Harbormaster bills on its channel: the fence first, what was done, then the boat", JSON.stringify(bills.map((t) => t.slice(0, 44))));
  const rows = await page.evaluate(() => [...document.querySelectorAll('.menu [data-s="complete"] .rd-row')].map((r) => `${r.querySelector("dt").textContent}: ${r.querySelector("dd").textContent}`));
  check(rows.length === 6 && /^Haul: .*CORE ×2/.test(rows[0]) && /^Your gun: Stevedore S-000007 · B · condition 95/.test(rows[1]) && /^Guns recovered: Pilot S-000023 · C · condition 49/.test(rows[2]) && /^Invoice: [\d,]+ scrip/.test(rows[3]) && /^Arrears now: [\d,]+ scrip/.test(rows[4]) && /^Ledger/.test(rows[5]), "the debrief shows the haul, the gun and its wear, guns recovered, the invoice, arrears and the ledger", JSON.stringify(rows));
  check(await page.evaluate(() => window.__G.bailiff.list.length === 0 && window.__G.v2.raid === null && !document.querySelector(".rd-inv").classList.contains("on")), "after the boat the yard is cleared and the meter is off");
  await page.waitForTimeout(600);
  await shot("4-debrief");

  // ---- a refused sign-on, and the raid off the books ----
  const refused = await page.evaluate(async () => {
    const G = window.__G;
    if (!("refuseNext" in G.v2)) return null;
    G.v2.refuseNext = "Too soon after your last raid. The fence is watched.";
    G.game.start({ quick: true }); // "Go again" on the debrief
    await new Promise((ok) => setTimeout(ok, 1800));
    const card = { offer: document.querySelector(".rd-sign").classList.contains("offer"), title: document.querySelector(".rd-sign-t").textContent, why: document.querySelector(".rd-sign-s").textContent, state: G.game.state };
    document.querySelector(".rd-yes").click();
    await new Promise((ok) => setTimeout(ok, 2600));
    return { card, state: G.game.state, mode: G.raid.state.mode, weapon: G.weapon.name, damage: G.weapon.damage, mag: G.weapon.magSize, targets: G.raid.state.targets.length, meter: document.querySelector(".rd-inv").classList.contains("on"), hp: G.player.maxHealth };
  });
  if (refused) {
    check(refused.card.offer && /not signed/i.test(refused.card.title) && /Too soon/.test(refused.card.why) && refused.card.state === "complete", "a refused sign-on holds the retry and says why", JSON.stringify(refused.card));
    check(refused.state === "playing" && refused.mode === "offbooks" && refused.weapon === "PAC-9 Issue" && refused.damage === 21 && refused.mag === 24 && refused.targets === 0 && !refused.meter && refused.hp === 100, "the raid off the books is the issue rifle with no loot and no invoice", JSON.stringify(refused));
  }
  await sample(page);
  await page.close();

  // ================================================================================ 2. ?invoice=1100: the Bailiff
  page = await open("&invoice=1100");
  const shot2 = async (name) => shots && (await page.screenshot({ path: `${shots}/${name}.png` }));
  check((await page.evaluate(() => window.__G.raid.prepare())) === "signed", "prepare() signs on without the title's DEPLOY");
  await page.evaluate(() => window.__G.game.start({ skipIntro: true }));
  await playing(page);
  await page.evaluate(() => ((window.__G.player.invulnerable = true), window.__stand(-30, 6)));
  await page.waitForFunction(() => window.__ev.some((e) => e.name === "bailiff:spawned"), null, { timeout: 6000 }).catch(() => {});
  const th = (await ev(page, "invoice:threshold")).map((e) => e.e);
  const born = await page.evaluate(() => ({ n: window.__G.bailiff.list.length, at: window.__G.bailiff.units[0] && { x: window.__G.bailiff.units[0].handle.pos.x, z: window.__G.bailiff.units[0].handle.pos.z }, total: window.__G.raid.state.total }));
  check(th.length === 2 && th[0].what === "second_notice" && th[0].at === 600 && th[1].what === "bailiff" && th[1].at === 1200, "past 1,200 at the fence: second notice, then final demand, each once", JSON.stringify(th));
  check(born.n === 1 && born.total >= 1275 && born.at && born.at.x > -24 && born.at.x < 16 && born.at.z < -10, "the Bailiff rises in the shed as the meter passes 1,200", JSON.stringify(born));
  const m2 = await meter(page);
  check(/^INVOICE 1,2\d\d · SECOND BAILIFF AT 2,400$/.test(m2.text), "the meter names what is next", m2.text);
  await page.evaluate(() => {
    const u = window.__G.bailiff.units[0];
    window.__stand(u.handle.pos.x + 4.4, u.handle.pos.z + 1.4);
    window.__face(u.handle.pos.x, 1.3, u.handle.pos.z);
  });
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
  await shot2("5-bailiff-final-demand");
  await sample(page);
  // One radio, three voices: the Harbormaster bills on its channel, its officer speaks under its own label.
  await page.waitForFunction(() => window.__radio.some((r) => /officer has been dispatched/.test(r.text)), null, { timeout: 40000 }).catch(() => {});
  const radio = await page.evaluate(() => window.__radio);
  const who = (re) => radio.find((r) => re.test(r.text))?.who;
  const control = radio.find((r) => /Control\./.test(r.text));
  check(who(/trespass surcharge of 175 scrip/) === "Harbormaster" && who(/officer has been dispatched/) === "Bailiff" && (!control || control.who === "Control"), "the radio labels each voice: Control, the Harbormaster's bill, the Bailiff", JSON.stringify(radio.map((r) => `${r.who}: ${r.text.slice(0, 34)}`)));
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
  const dieArgs = await page.evaluate(() => window.__G.v2.calls?.find((c) => c.method === "die")?.args ?? null);
  check(died?.by === "bailiff" && died.impounded === true, "killed by the Bailiff's grab: raid:died says bailiff, impounded", JSON.stringify(died));
  if (dieArgs) check(dieArgs[3] === "bailiff" && Number.isInteger(dieArgs[2]) && dieArgs[2] >= 0 && dieArgs[2] < 16, "chain.die was sent `bailiff` and the nearest spot", JSON.stringify(dieArgs.slice(2)));
  await page.waitForFunction(() => /Ledger/.test(document.querySelector('.menu [data-s="dead"]')?.textContent ?? "") && !/logging/.test(document.querySelector('.menu [data-s="dead"] .rd-sec')?.textContent ?? ""), null, { timeout: 8000 }).catch(() => {});
  const deadRows = await page.evaluate(() => [...document.querySelectorAll('.menu [data-s="dead"] .rd-row')].map((r) => `${r.querySelector("dt").textContent}: ${r.querySelector("dd").textContent}`));
  check(/^Your gun: IMPOUNDED · Stevedore S-000007 · buy it back at the dock within 48 hours$/.test(deadRows[0] ?? ""), "the dead card says the gun is impounded", JSON.stringify(deadRows));
  await page.waitForFunction(() => window.__G.game.state === "dead", null, { timeout: 10000 }).catch(() => {});
  await page.waitForTimeout(2600); // the card comes up 1.5 s into the death camera
  await shot2("6-dead-impounded");
  // The next raid: the gun is gone from the stash, so the loadout falls back to the issue rifle.
  const again = await page.evaluate(async () => {
    const G = window.__G;
    const kind = await G.raid.prepare();
    return { kind, weapon: G.ext.weapon.name, sent: G.v2.calls?.filter((c) => c.method === "startRaid").pop()?.args[0] };
  });
  check(again.kind === "signed" && again.weapon === "PAC-9 Issue" && (!again.sent || again.sent.weapon === null), "the impounded gun's loadout falls back to the issue rifle", JSON.stringify(again));
  await page.close();

  // ============================================================================ 3. ?invoice=4000: every threshold
  page = await open("&invoice=4000");
  await page.evaluate(() => window.__G.raid.prepare());
  await page.evaluate(() => window.__G.game.start({ skipIntro: true }));
  await playing(page);
  await page.evaluate(() => ((window.__G.player.invulnerable = true), window.__stand(-30, 6)));
  await page.waitForFunction(() => !!window.__G.boss?.fight, null, { timeout: 8000 }).catch(() => {});
  await page.waitForTimeout(1500);
  const all = (await ev(page, "invoice:threshold")).map((e) => e.e.what);
  const yard = await page.evaluate(() => ({ bailiffs: window.__G.bailiff.list.length, boss: !!window.__G.boss?.fight, cores: document.querySelectorAll(".as-cores i").length, blocked: !!window.__G.ext.extractBlocked?.(), meter: document.querySelector(".rd-inv").dataset.text }));
  check(JSON.stringify(all) === JSON.stringify(["second_notice", "bailiff", "second_bailiff", "foreclosure"]), "past 4,000: all four thresholds, once each, in order", JSON.stringify(all));
  check(yard.bailiffs === 2 && yard.boss && yard.cores === 3 + Math.floor(30 / 20), "two Bailiffs stand and the Assessor is summoned with 3 + floor(strength / 20) cores", JSON.stringify(yard));
  check(yard.blocked, "the Assessor holds the boat while it stands");
  await page.waitForTimeout(3000);
  await sample(page);
  if (shots) await page.screenshot({ path: `${shots}/7-foreclosure.png` });
  await page.close();

  // ---- throughout ----
  check(Math.min(...fps) >= 50, "fps stays near 60", fps.map((f) => Math.round(f)).join(", "));
  check(errors.length === 0, "no console errors", errors.slice(0, 4).join(" | "));
} finally {
  await browser.close();
}
console.log(failed ? `\n${failed} check(s) failed` : "\nall checks passed");
process.exit(failed ? 1 : 0);
