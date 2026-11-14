// Headless smoke test of the coach (src/economy/v2/coach): the rifle in its crate and a first raid's checklist, on
// the offline mock.
//
//   npm run dev -- --port 5322
//   node scripts/smoke-coach.mjs [http://127.0.0.1:5322] [--shots DIR]
//
// Pointer lock doesn't work headless, so the raid is driven through window.__G as scripts/smoke-raid.mjs drives it:
// E is held by stubbing input.down, the trigger by a getter over input.fire, the player is walked and faced by
// script, a machine is destroyed through the game's own damage path. Four page loads:
//   1. a new player: starts with empty hands (the rifle hidden, the ammo block held back, the trigger dead), takes
//      the rifle from the crate, and each line of the checklist ticks in order through a whole raid to the boat; the
//      first wreck in sight and the first debrief say their line once; a second raid has a crate and no checklist;
//      a death shows its card's line, and the retry takes the rifle at the press;
//   2. ?invoice=1100: the first Bailiff's line;
//   3. ?game=v1 and 4. ?noeconomy=1: no coach, the rifle in hand from the start, as before.
// fps and console errors throughout. Exits non-zero if a check failed.
import { mkdirSync } from "node:fs";
import { launch } from "./browser.mjs";

const base = process.argv.find((a) => a.startsWith("http")) || "http://127.0.0.1:5322";
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

async function open(query, { pass = true, storage = null } = {}) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.addInitScript((storage) => {
    if (sessionStorage.getItem("smoke.kept")) return; // a reload keeps what the first load wrote
    sessionStorage.setItem("smoke.kept", "1");
    localStorage.clear();
    localStorage.setItem("saltline.story.v1", JSON.stringify({ v: 1, briefed: true, heard: [], peak: 0 }));
    if (storage) for (const [k, v] of Object.entries(storage)) localStorage.setItem(k, v);
  }, storage);
  await page.goto(`${base}/play/?${query}&noaudio=1`, { waitUntil: "load" });
  await page.waitForFunction(() => window.__ready === true, null, { timeout: 90000 });
  if (/game=v2/.test(query)) await page.waitForFunction(() => !!window.__G.raid && !!window.__G.bailiff && !!window.__G.v2 && !!window.__G.coach, null, { timeout: 15000 });
  await page.evaluate(async (pass) => {
    const G = window.__G;
    window.__ev = [];
    for (const name of ["weapon:fire", "raid:extracted", "raid:died", "bailiff:spawned", "radio:line", "extraction:reached"]) G.events.on(name, (e) => window.__ev.push({ name, t: performance.now(), text: e?.text }));
    // E and the trigger, held by script.
    window.__hold = false;
    window.__fire = false;
    const down = G.input.down.bind(G.input);
    G.input.down = (a) => (a === "interact" && window.__hold) || down(a);
    let fire = false;
    Object.defineProperty(G.input, "fire", { get: () => window.__fire || fire, set: (v) => (fire = v), configurable: true });
    window.__face = (tx, ty, tz) => {
      const p = G.player;
      p.yaw = Math.atan2(-(tx - p.pos.x), -(tz - p.pos.z));
      p.pitch = Math.atan2(ty - (p.pos.y + 1.6), Math.hypot(tx - p.pos.x, tz - p.pos.z));
    };
    window.__stand = (x, z) => (G.player.pos.set(x, 0, z), G.player.vel.set(0, 0, 0));
    window.__at = (key, back = 0) => {
      const t = G.raid.state.targets.find((x) => x.key === key);
      if (!t) return false;
      const d = (t.kind === "seal" ? 1.3 : 1.5) + back;
      window.__stand(t.at.x + t.out.x * d, t.at.z + t.out.z * d);
      window.__face(t.at.x, t.at.y + (back ? 0.4 : 0), t.at.z);
      if (back) G.player.yaw -= 0.2;
      return true;
    };
    window.__prompt = () => (document.querySelector(".h-prompt.on")?.textContent ?? "").replace(/\s+/g, " ").trim();
    window.__quiet = true;
    setInterval(() => window.__quiet && G.game.state === "playing" && G.enemies.clear(), 150);
    if (!G.v2) return;
    // Every line the panel shows, in the order it showed them.
    window.__lines = [];
    const watch = () => {
      const c = G.coach?.state;
      const key = c && (c.moment ? "moment:" + c.moment : c.step);
      if (key && window.__lines[window.__lines.length - 1] !== key) window.__lines.push(key);
      requestAnimationFrame(watch);
    };
    requestAnimationFrame(watch);
    if (pass) {
      const c = await G.v2.wallet.claim("COACH1");
      if (!c.ok) throw new Error("claim failed: " + c.error);
      const gun = G.v2.chain.debug.giveGun("stevedore", { grade: "B" });
      G.v2.chain.debug.give({ charge: 2, ammo: 2 });
      G.v2.chain.debug.addWreck({ spot: 1, frame: "pilot", grade: "C" });
      window.__gun = gun;
      window.__arm = () => (G.v2.loadout = { weapon: gun.serial, plates: 0, charges: 2, mags: 2 });
    }
  }, pass);
  return page;
}
const coach = (page) => page.evaluate(() => JSON.parse(JSON.stringify(window.__G.coach.state)));
const panel = (page) =>
  page.evaluate(() => {
    const p = document.querySelector(".co-panel");
    return { on: !!p?.classList.contains("on"), lines: p ? p.querySelectorAll(".co-line").length : 0, kicker: p?.querySelector(".h-k")?.textContent ?? "", text: window.__G.coach.state.text, ticked: !!p?.querySelector(".co-line.ticked") };
  });
const step = (page, id, ms = 15000) => page.waitForFunction((id) => window.__G.coach.state.step === id && !window.__G.coach.state.ticked, id, { timeout: ms, polling: 50 }).then(() => true, () => false);
const playing = (page) => page.waitForFunction(() => window.__G.game.state === "playing", null, { timeout: 20000 });
const sample = async (page) => fps.push(await page.evaluate(() => window.__stats().fps));
const deploy = async (page) => {
  await page.evaluate(() => window.__arm?.());
  const kind = await page.evaluate(() => window.__G.raid.prepare());
  await page.evaluate(() => window.__G.game.start({ skipIntro: true }));
  await playing(page);
  await page.evaluate(() => (window.__G.player.invulnerable = true));
  return kind;
};
/** What the shooter is doing with the rifle. */
const hands = (page) =>
  page.evaluate(() => {
    const G = window.__G;
    return { unarmed: !!G.ext.unarmed, visible: G.weapon.root.visible, ammo: G.weapon.ammo, hudAmmo: getComputedStyle(document.querySelector(".h-ammo")).opacity, armed: G.coach?.state.armed };
  });
const faceCrate = (page) => page.evaluate(() => (window.__stand(window.__G.level.playerStart.pos.x, window.__G.level.playerStart.pos.z), window.__face(window.__G.coach.state.crate.x, 0.25, window.__G.coach.state.crate.z)));

try {
  // ============================================================================================ 1. a new player
  let page = await open("game=v2&mock=1");
  let shot = async (name) => shots && (await page.screenshot({ path: `${shots}/${name}.png` }));
  check(await page.evaluate(() => !!window.__G.coach && /How to play/i.test(document.querySelector(".co-howto")?.textContent ?? "") && document.querySelector(".co-howto").getAttribute("aria-pressed") === "true"), "the title has HOW TO PLAY, on for a new player");
  const keys = await page.evaluate(() => [...document.querySelectorAll('[data-pane="controls"] dl.keys dt')].map((d) => d.textContent.trim()));
  check(keys.filter((k) => k === "Breaker charge").length === 1 && keys.filter((k) => k === "Rifle butt").length === 1, "the pause card's controls already list G and F once each (the kit's own rows): the coach adds none", keys.join(", "));
  check((await deploy(page)) === "signed", "the raid is signed");

  // ---- empty hands ----
  await page.waitForTimeout(300);
  const h0 = await hands(page);
  check(h0.unarmed && !h0.visible && h0.hudAmmo === "0" && h0.armed === false, "a new player starts with empty hands: the rifle hidden and the ammo block held back", JSON.stringify(h0));
  await page.evaluate(() => (window.__fire = true));
  await page.waitForTimeout(600);
  await page.evaluate(() => (window.__fire = false));
  const h1 = await hands(page);
  check(h1.ammo === h0.ammo && (await page.evaluate(() => window.__ev.filter((e) => e.name === "weapon:fire").length)) === 0, "pulling the trigger does nothing", `${h1.ammo} rounds, no weapon:fire`);
  check(await page.evaluate(() => window.__G.arsenal.swing() === false && window.__G.arsenal.throwCharge() === false && window.__G.arsenal.charges() === 2), "nothing is swung or thrown with empty hands");

  // ---- the crate ----
  const c0 = await coach(page);
  const start = await page.evaluate(() => ({ x: window.__G.level.playerStart.pos.x, z: window.__G.level.playerStart.pos.z }));
  const ahead = Math.hypot(c0.crate.x - start.x, c0.crate.z - start.z);
  check(Math.abs(ahead - 2) < 0.05 && c0.coached && !c0.instant, "the crate stands 2 m in front of the player's start", `${ahead.toFixed(2)} m`);
  await faceCrate(page);
  await page.waitForFunction(() => /take the rifle/i.test(window.__prompt()), null, { timeout: 4000 }).catch(() => {});
  const p0 = await panel(page);
  check(/^Hold E . Take the rifle$/i.test(await page.evaluate(() => document.querySelector(".h-plabel").textContent)), "the prompt reads HOLD E — TAKE THE RIFLE", await page.evaluate(() => window.__prompt()));
  check(p0.on && p0.lines === 1 && /first raid/i.test(p0.kicker) && p0.text === "TAKE THE RIFLE — hold E at the crate", "the checklist's first line is the rifle", JSON.stringify(p0));
  await page.waitForTimeout(500);
  await shot("1-crate-rifle-prompt");
  // From the side, to look at the prop itself.
  await page.evaluate(() => {
    const c = window.__G.coach.state.crate;
    window.__stand(c.x - 1.1, c.z + 1.25);
    window.__face(c.x, 0.2, c.z);
  });
  await page.waitForTimeout(500);
  await shot("1b-crate-close");
  await faceCrate(page);
  await page.waitForTimeout(200);
  const t0 = Date.now();
  await page.evaluate(() => (window.__hold = true));
  await page.waitForFunction(() => window.__G.coach.state.armed, null, { timeout: 4000, polling: 16 }).catch(() => {});
  const held = Date.now() - t0;
  await page.evaluate(() => (window.__hold = false));
  check(held > 450 && held < 1500, "holding E for about 0.6 s takes it", `${held} ms`);
  await page.waitForTimeout(900);
  const h2 = await hands(page);
  check(!h2.unarmed && h2.visible && h2.armed && Number(h2.hudAmmo) > 0.9, "the rifle is in hand and the HUD's ammo is up", JSON.stringify(h2));
  check(await page.evaluate(() => window.__G.weapon.name === "PAC-9K Stevedore · B" && window.__G.raid.state.gun.serial === window.__gun.serial), "it is the gun the loadout named");
  if (shots) {
    // The rifle part-way up, posed with the draw's own offset so the frame can be looked at.
    await page.evaluate(() => (window.__G.ext.draw = 0.45));
    await page.waitForTimeout(120);
    await shot("2-rifle-coming-up");
    await page.evaluate(() => (window.__G.ext.draw = 0));
  }
  await page.evaluate(() => (window.__fire = true));
  await page.waitForTimeout(350);
  await page.evaluate(() => (window.__fire = false));
  check((await hands(page)).ammo < h0.ammo, "and now it fires");
  await sample(page);

  // ---- the checklist, line by line ----
  check(await step(page, "move"), "2. MOVE comes up once the rifle is taken", (await panel(page)).text);
  check((await panel(page)).text === "MOVE — W A S D · LOOK — mouse", "MOVE names the keyboard and mouse", (await panel(page)).text);
  await shot("3-checklist-move");
  for (let i = 0; i < 9; i++) {
    await page.evaluate((i) => window.__stand(window.__G.level.playerStart.pos.x + 0.6 + i * 0.8, window.__G.level.playerStart.pos.z + 1.6), i);
    await page.waitForTimeout(70);
  }
  check(await step(page, "seal"), "3. A SEALED CONTAINER comes up after walking 6 m", (await panel(page)).text);
  // Control's line waits its turn behind the Harbormaster's greeting on the one radio.
  await page.waitForFunction(() => window.__ev.some((e) => e.name === "radio:line" && /on your papers now/.test(e.text ?? "")), null, { timeout: 25000 }).catch(() => {});
  const said = await page.evaluate(() => window.__ev.filter((e) => e.name === "radio:line").map((e) => ({ text: e.text, who: document.querySelector(".comms-who")?.textContent })));
  check(said.some((s) => /on your papers now/.test(s.text ?? "")), "Control says the raid's first line once the rifle is up", JSON.stringify(said.map((s) => (s.text ?? "").slice(0, 40))));
  const lead = await page.evaluate(() => ({ markers: document.querySelectorAll(".h-wm.lead").length, compass: document.querySelectorAll(".h-cm.lead").length }));
  check(lead.markers === 1 && lead.compass === 1, "one marker leads to the nearest sealed container", JSON.stringify(lead));
  const first = await page.evaluate(() => {
    const G = window.__G;
    const p = G.player.pos;
    return [...G.raid.state.targets].filter((t) => t.kind === "seal" && !t.bonded).sort((a, b) => Math.hypot(a.at.x - p.x, a.at.z - p.z) - Math.hypot(b.at.x - p.x, b.at.z - p.z))[0];
  });
  await page.evaluate((k) => window.__at(k, 5), first.key);
  await page.waitForTimeout(700);
  await shot("4-checklist-seal-marker");
  await page.evaluate((k) => (window.__at(k), (window.__hold = true)), first.key);
  await page.waitForFunction((k) => !window.__G.raid.state.targets.some((t) => t.key === k), first.key, { timeout: 8000, polling: 50 }).catch(() => {});
  await page.evaluate(() => (window.__hold = false));
  check(await step(page, "invoice"), "4. THE INVOICE comes up when the seal is cut", (await panel(page)).text);
  const bailiffAt = await page.evaluate(() => window.__G.v2.raid.harbormaster.bailiffAt);
  const p4 = await panel(page);
  const arrow = await page.evaluate(() => ({ point: document.querySelector(".rd-inv").classList.contains("co-point"), arrow: !!document.querySelector(".rd-inv .co-arrow") }));
  check(p4.text === `EVERYTHING GOES ON THE INVOICE — at ${bailiffAt.toLocaleString("en-US")} it sends the Bailiff` && arrow.point && arrow.arrow, "it names this raid's threshold, and the meter pulses with an arrow to it", JSON.stringify({ text: p4.text, ...arrow }));
  await page.waitForTimeout(450);
  await shot("5-invoice-arrow");
  check(await step(page, "cargo", 8000), "5. CARGO comes up after the invoice has been read for 4 s", (await panel(page)).text);
  check(await page.evaluate(() => !document.querySelector(".rd-inv").classList.contains("co-point") && !document.querySelector(".co-arrow")), "the arrow leaves with its line");
  await shot("6-checklist-cargo");
  check(await step(page, "fire", 8000), "6. FIRE comes up after the first seal", (await panel(page)).text);
  check((await panel(page)).text === "FIRE — left mouse · AIM — right mouse · RELOAD — R", "FIRE names the mouse and R");
  await page.waitForTimeout(450);
  await shot("7-checklist-fire");
  await page.evaluate(async () => {
    const G = window.__G;
    window.__quiet = false;
    const at = new G.THREE.Vector3(G.player.pos.x + 3, 0, G.player.pos.z + 3);
    const hound = G.enemies.spawn("hound", at, { state: "alert" });
    await new Promise((ok) => setTimeout(ok, 150));
    hound.damage(9999, new G.THREE.Vector3(at.x, 0.6, at.z), new G.THREE.Vector3(0, 0.3, -1), "body", "test");
    window.__quiet = true;
  });
  check(await step(page, "kit"), "7. THE KIT comes up at the first kill", (await panel(page)).text);
  check((await panel(page)).text === "G — BREAKER CHARGE · F — RIFLE BUTT", "the kit's line names G and F");
  check(await page.evaluate(() => window.__G.arsenal.swing() === true), "the rifle butt swings now the rifle is in hand");
  check(await step(page, "uplinks"), "8. THE UPLINKS come up once the kit is used", (await panel(page)).text);
  await sample(page);

  // ---- the first wreck in sight: one line outside the list, once ----
  const wreck = await page.evaluate(() => window.__G.raid.state.targets.find((t) => t.kind === "wreck")?.key ?? null);
  if (wreck) {
    await page.evaluate((k) => window.__at(k, 2.4), wreck);
    await page.waitForFunction(() => window.__G.coach.state.moment === "wreck", null, { timeout: 4000 }).catch(() => {});
    const pw = await panel(page);
    check(pw.on && pw.lines === 1 && /a wreck/i.test(pw.kicker) && pw.text === "ANOTHER BREACHER'S WRECK — hold E to take what they lost", "the first wreck in sight says its line, alone on the panel", JSON.stringify(pw));
    await page.waitForTimeout(500);
    await shot("8-first-wreck");
    await page.waitForFunction(() => window.__G.coach.state.moment === null && window.__G.coach.state.step === "uplinks", null, { timeout: 12000 }).catch(() => {});
    check((await panel(page)).text === "CUT THE THREE UPLINKS — hold E at each", "then the checklist's line is back", (await panel(page)).text);
  } else check(false, "the manifest has a wreck");

  // ---- out of the way in a fight ----
  await page.evaluate(() => window.__G.events.emit("player:hit", { fromPos: window.__G.player.pos, amount: 1 }));
  await page.waitForTimeout(600);
  check(await page.evaluate(() => document.querySelector(".co-panel").classList.contains("dim")), "the panel dims while the player is being hit");

  // ---- the uplinks, then the boat ----
  await page.evaluate(async () => {
    for (let i = 0; i < 3; i++) (window.__G.game.debugCut(), await new Promise((ok) => setTimeout(ok, 300)));
  });
  check(await step(page, "boat"), "9. THE BOAT comes up at the third uplink", (await panel(page)).text);
  await page.waitForTimeout(2700);
  await shot("9-checklist-boat");
  await page.evaluate(() => window.__stand(window.__G.level.extraction.pos.x, window.__G.level.extraction.pos.z));
  await page.waitForFunction(() => window.__G.game.state === "complete", null, { timeout: 20000 });
  const lines = await page.evaluate(() => window.__lines);
  // The wreck's moment may cut into any line (wherever the player first sees one): the checklist's own order is what
  // is left when it is taken out.
  const listed = lines.filter((l) => !l.startsWith("moment:")).filter((l, i, a) => l !== a[i - 1]);
  check(JSON.stringify(listed) === JSON.stringify(["rifle", "move", "seal", "invoice", "cargo", "fire", "kit", "uplinks", "boat"]) && lines.filter((l) => l === "moment:wreck").length === 1, "every line showed once, in order, and the wreck's moment once", lines.join(" → "));
  const end = await coach(page);
  check(end.done && !end.coached && !(await panel(page)).on, "the panel leaves with the raid, and the first raid is done", JSON.stringify({ done: end.done, coached: end.coached }));
  await page.waitForFunction(() => !!document.querySelector('.menu [data-s="complete"] .co-dock'), null, { timeout: 8000 }).catch(() => {});
  const deb = await page.evaluate(() => ({ line: document.querySelector('.menu [data-s="complete"] .co-dock')?.textContent ?? "", pointed: !!document.querySelector('.menu [data-s="complete"] .d2-entry.co-pointed'), next: document.querySelector('.menu [data-s="complete"] .co-dock')?.nextElementSibling?.className ?? "" }));
  check(/SELL AND BUILD AT THE DOCK/.test(deb.line) && deb.pointed && /d2-entry/.test(deb.next), "the first debrief points at the DOCK button", JSON.stringify(deb));
  await page.waitForTimeout(700);
  await shot("10-first-debrief");
  await page.waitForFunction(() => window.__ev.some((e) => e.name === "raid:extracted"), null, { timeout: 150000 });
  await sample(page);

  // ---- a second raid: the crate, no checklist ----
  check((await deploy(page)) === "signed", "a second raid is signed");
  const s2 = await coach(page);
  const h3 = await hands(page);
  check(!s2.coached && s2.step === null && h3.unarmed && !h3.visible && !s2.instant, "the second raid starts at the crate with no checklist", JSON.stringify({ coached: s2.coached, unarmed: h3.unarmed, instant: s2.instant }));
  await faceCrate(page);
  await page.evaluate(() => (window.__hold = true));
  await page.waitForFunction(() => window.__G.coach.state.armed, null, { timeout: 4000, polling: 16 }).catch(() => {});
  await page.evaluate(() => (window.__hold = false));
  await page.waitForTimeout(1500);
  check((await hands(page)).armed && !(await panel(page)).on && (await page.evaluate(() => document.querySelector('.menu [data-s="complete"] .co-dock') === null)), "the rifle is taken the same way, and no line comes up");
  const second = Date.now();
  // ---- a death: its card's line, once; the retry takes the rifle at the press ----
  await page.evaluate(() => ((window.__G.player.invulnerable = false), window.__G.player.damage(9999)));
  await page.waitForFunction(() => !!document.querySelector('.menu [data-s="dead"] .co-card'), null, { timeout: 5000 }).catch(() => {});
  const card = await page.evaluate(() => document.querySelector('.menu [data-s="dead"] .co-card')?.textContent ?? "");
  check(card === `STEVEDORE ${await page.evaluate(() => window.__gun.serial)} STAYS WHERE YOU FELL — whoever carries it to the boat keeps it. Build or buy the next one at the DOCK.`, "the first death's card says what became of the gun", card);
  await page.waitForFunction(() => window.__G.game.menus.screen === "dead", null, { timeout: 8000 }).catch(() => {});
  await page.waitForTimeout(600);
  await shot("11-first-death");
  await page.waitForFunction(() => window.__ev.some((e) => e.name === "raid:died"), null, { timeout: 40000 }).catch(() => {});
  await page.waitForTimeout(Math.max(0, 32000 - (Date.now() - second)));
  await deploy(page);
  const s3 = await coach(page);
  check(s3.instant && !s3.armed && (await page.evaluate(() => document.querySelector('.menu [data-s="dead"] .co-card') === null)), "the retry starts at the crate again, and the card's line is gone", JSON.stringify({ instant: s3.instant, armed: s3.armed }));
  await faceCrate(page);
  await page.waitForFunction(() => /take the rifle/i.test(window.__prompt()), null, { timeout: 4000 }).catch(() => {});
  const t1 = Date.now();
  await page.evaluate(() => (window.__hold = true));
  await page.waitForFunction(() => window.__G.coach.state.armed, null, { timeout: 4000, polling: 16 }).catch(() => {});
  const tap = Date.now() - t1;
  await page.evaluate(() => (window.__hold = false));
  check(tap < 250, "after a death the rifle is taken at the press", `${tap} ms`);
  await page.evaluate(() => ((window.__G.player.invulnerable = false), window.__G.player.damage(9999)));
  await page.waitForTimeout(600);
  check(await page.evaluate(() => document.querySelector('.menu [data-s="dead"] .co-card') === null), "a second death's card has no line");
  const mem = await page.evaluate(() => JSON.parse(localStorage.getItem("saltline.coach.v1")));
  check(mem.done === true && ["wreck", "debrief", "death"].every((m) => mem.seen.includes(m)), "what was taught and seen is kept in localStorage", JSON.stringify(mem));
  // HOW TO PLAY turns it back on for the next raid.
  await page.reload({ waitUntil: "load" });
  await page.waitForFunction(() => window.__ready === true && !!window.__G.coach, null, { timeout: 90000 });
  const how = await page.evaluate(() => {
    const b = document.querySelector(".co-howto");
    const before = { pressed: b.getAttribute("aria-pressed"), done: window.__G.coach.state.done };
    b.click();
    return { before, pressed: b.getAttribute("aria-pressed"), done: window.__G.coach.state.done, text: b.textContent };
  });
  check(how.before.pressed === "false" && how.before.done && how.pressed === "true" && !how.done, "after a reload the checklist is still off, and HOW TO PLAY turns it on for the next raid", JSON.stringify(how));
  await page.waitForTimeout(1500); // the boot card clears
  await shot("12-title-how-to-play");
  await page.close();

  // ======================================================================================= 2. the first Bailiff
  page = await open("game=v2&mock=1&invoice=1100");
  shot = async (name) => shots && (await page.screenshot({ path: `${shots}/${name}.png` }));
  await deploy(page);
  await faceCrate(page);
  await page.evaluate(() => (window.__hold = true));
  await page.waitForFunction(() => window.__G.coach.state.armed, null, { timeout: 4000, polling: 16 }).catch(() => {});
  await page.evaluate(() => (window.__hold = false));
  await page.waitForFunction(() => window.__G.coach.state.moment === "bailiff", null, { timeout: 12000 }).catch(() => {});
  const pb = await panel(page);
  check(pb.on && pb.lines === 1 && /the bailiff/i.test(pb.kicker) && pb.text === "IT CAN'T BE DESTROYED — drop it with fire or a charge, then run", "the first Bailiff says its line, alone on the panel", JSON.stringify(pb));
  await page.evaluate(() => {
    const u = window.__G.bailiff.units[0];
    if (!u) return;
    window.__stand(u.handle.pos.x + 5.2, u.handle.pos.z + 1.6);
    window.__face(u.handle.pos.x, 1.5, u.handle.pos.z);
    window.__G.player.yaw -= 0.16;
  });
  await page.waitForTimeout(900);
  await shot("13-first-bailiff");
  await sample(page);
  await page.waitForFunction(() => window.__G.coach.state.moment === null, null, { timeout: 12000 }).catch(() => {});
  check((await coach(page)).seen.includes("bailiff") && (await panel(page)).lines === 1, "it is said once, and the checklist's line takes the panel back", JSON.stringify((await panel(page)).text));
  await page.close();

  // ================================================================================== 3, 4. v1 and no economy
  for (const [query, name] of [
    ["game=v1&mock=1", "?game=v1"],
    ["noeconomy=1", "?noeconomy=1"],
  ]) {
    page = await open(query, { pass: false });
    await page.waitForTimeout(1500);
    await page.evaluate(() => window.__G.game.start({ skipIntro: true }));
    await playing(page);
    await page.evaluate(() => (window.__G.player.invulnerable = true));
    await page.waitForTimeout(400);
    const before = await page.evaluate(() => window.__G.weapon.ammo);
    await page.evaluate(() => (window.__fire = true));
    await page.waitForTimeout(400);
    await page.evaluate(() => (window.__fire = false));
    const plain = await page.evaluate(() => ({ coach: !!window.__G.coach, unarmed: !!window.__G.ext.unarmed, draw: window.__G.ext.draw ?? 0, visible: window.__G.weapon.root.visible, ammo: window.__G.weapon.ammo, panel: !!document.querySelector(".co-panel"), how: !!document.querySelector(".co-howto"), hudAmmo: getComputedStyle(document.querySelector(".h-ammo")).opacity }));
    check(!plain.coach && !plain.unarmed && !plain.draw && plain.visible && plain.ammo < before && !plain.panel && !plain.how && plain.hudAmmo === "1", `${name} is untouched: no coach, the rifle in hand and firing from the start`, JSON.stringify(plain));
    await sample(page);
    await page.close();
  }

  // ---- throughout ----
  check(Math.min(...fps) >= 50, "fps stays near 60", fps.map((f) => Math.round(f)).join(", "));
  check(errors.length === 0, "no console errors", errors.slice(0, 4).join(" | "));
} finally {
  await browser.close();
}
console.log(failed ? `\n${failed} check(s) failed` : "\nall checks passed");
process.exit(failed ? 1 : 0);
