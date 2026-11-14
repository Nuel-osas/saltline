// Headless smoke test of the story layer (src/economy/story) on the offline mock, then the ?noeconomy baseline.
//
//   npm run dev -- --port 5297
//   node scripts/smoke-story.mjs [http://127.0.0.1:5297] [--shots DIR] [--quick]
//
// The mock's ?act=1|2|3 (mock.ts) puts its town at an act. The mock plays by the real run rules (a minimum run time),
// so the page's Date.now gets a test-only skew (window.__skew, ms) that the test moves forward instead of waiting.
// 1. ?act=1, a fresh player: the town is dark from the title camera. The first DEPLOY (after a dock pass claimed on
//    the mock) plays the briefing before the run starts; Esc skips it. The chapter card opens the run, Control's intro
//    calls the player by callsign, then the Chapter 1 line. The Harbormaster bills the trespass surcharge on its own
//    channel, answers a seal cut and the first relay cut in its turn (never within 8 s of its last line), and
//    invoices the haul at the debrief's value once the player is aboard.
//    Then a returning player: BRIEFING replays it, DEPLOY doesn't, and the Town tab names the chapters.
// 2. ?act=3 (strength 62, two extra drones): the Chapter 3 card, Control's once-only lines, the patrol and the first
//    wave carry the extra drones, and the Harbormaster's lines all play on its channel, paced.
// 3. ?act=2: the town is lit from the title camera.
// 4. ?noeconomy=1: no story, no briefing, the baseline plays with the new copy and calls the player Breacher.
// --quick skips waiting for the title camera to reach the quay (about 90 s a page) and frames the shot directly.
// Exits non-zero if a check failed.
import { mkdirSync } from "node:fs";
import { launch } from "./browser.mjs";

const base = process.argv.find((a) => a.startsWith("http")) || "http://127.0.0.1:5297";
const shotsAt = process.argv.indexOf("--shots");
const shots = shotsAt > 0 ? process.argv[shotsAt + 1] : null;
const quick = process.argv.includes("--quick");
if (shots) mkdirSync(shots, { recursive: true });

const intro = (callsign) =>
  `${callsign}, Control. Same as yesterday. Three uplinks, yard, shed, quay. Cut them, take what you can carry, make the boat.`;
const done = (callsign) => `${callsign} is aboard. Saltline is dark. I'm going back to sleep.`;
const ACT1 = "Clinic's down to its last crates of meds. Ines will pay for every box. She'll complain about it.";
const act2 = (callsign) => `Lights on the water, ${callsign}. That's the clinic. Your cargo did that. Don't let it go to your head.`;
const REVEAL = "Control. The Quartermaster's client is the Harbormaster. Every core you sell him, it builds into something. Your call.";
const BRIEFING_3 = "When its owners went bankrupt, it checked the regulations, and impounded the town as unclaimed cargo.";
const trespass = (callsign, fee) =>
  `Good morning, Breacher ${callsign}. Your visit is not authorised. A trespass surcharge of ${fee} scrip has been added to your account.`;
const SEAL = "Tampering with a customs seal. Fee applied. Please retain this message for your records.";
const EVIDENCE = /^You are now carrying \d+ units of evidence\. Thank you\.$/;
const CUT = "That uplink was ours. We have others.";
const INVOICE = /^Removal of goods noted\. An invoice for (\d+) scrip will follow\. It will not be paid\. We will send it anyway\.$/;
const CARD_1 = ["Chapter 1 · Proof of Delivery", "The town needs its cargo. The Harbormaster needs a signature.", "Saltline Terminal · Berth 4 · 05:42"];
const CARD_3 = ["Chapter 3 · Final Notice", "The client has been identified. The client would like its cores back.", "Saltline Terminal · Berth 4 · 05:42"];
/** Every Harbormaster line docs/STORY.md gives, as patterns: anything else on its channel is a mistake. */
const HM_LINE = /^(Good morning, Breacher |Tampering with a customs seal|That uplink was ours|You are now carrying \d+ units of evidence|Removal of goods noted|\d+ of our cores came home|We count \d+ percent|The town has stopped selling)/;
/** The radio's timing (story/radio.ts lineMs): 58 characters a second, then the hold. */
const lineMs = (text, seconds) => (text.length / 58 + seconds) * 1000;
/** The hold story/index.ts gives each of the Harbormaster's lines, in seconds. */
const holdOf = (text) =>
  text === CUT ? 3.8 : EVIDENCE.test(text) ? 4 : text === SEAL ? 4.4 : INVOICE.test(text) ? 4.8 : 4.6;

let failed = 0;
const check = (ok, what, detail = "") => {
  console.log(`${ok ? "ok  " : "FAIL"} ${what}${detail ? " — " + detail : ""}`);
  if (!ok) failed++;
};
const shot = async (page, name) => shots && (await page.screenshot({ path: `${shots}/${name}.png` }));

const browser = await launch();

async function open(query, { memory = null } = {}) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  const errors = [];
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.addInitScript((memory) => {
    localStorage.clear(); // a fresh mock economy, wallet and story memory every time
    if (memory) localStorage.setItem("saltline.story.v1", JSON.stringify(memory));
    const real = Date.now.bind(Date);
    window.__skew = 0;
    Date.now = () => real() + window.__skew;
  }, memory);
  await page.goto(`${base}/play/?${query}`, { waitUntil: "load" });
  await page.waitForFunction(() => window.__ready === true, null, { timeout: 90000 });
  await page.evaluate(() => {
    const G = window.__G;
    window.__radio = [];
    window.__runs = 0;
    window.__channel = [];
    G.events.on("radio:line", (e) => {
      window.__radio.push(e.text);
      // The box as the line starts: which channel it's on.
      const at = performance.now();
      queueMicrotask(() => {
        const c = document.querySelector(".comms");
        window.__channel.push({ text: e.text, at, hm: !!c && c.classList.contains("st-hm"), who: c?.querySelector(".comms-who")?.textContent });
      });
    });
    G.events.on("run:start", () => window.__runs++);
    // The game clears the radio at the boat and on a death: whatever was on air ends there.
    for (const ev of ["extraction:reached", "player:dead"]) G.events.on(ev, () => window.__channel.push({ clear: true, at: performance.now() }));
  });
  return { page, errors };
}

/** The title camera's pass along the quay, where the town across the water is in frame. */
async function atQuay(page) {
  if (quick) {
    await page.evaluate(() => window.__setShot({ cam: "27.3,1.8,12,29.6,0.4,20" }));
    await page.waitForTimeout(1200);
    return true;
  }
  return page
    .waitForFunction(() => {
      const p = window.__G.camera.position;
      return window.__G.game.state === "title" && p.x > 27 && p.z > 11.5 && p.z < 13;
    }, null, { timeout: 120000, polling: 100 })
    .then(() => true, () => false);
}

const alive = (page) =>
  page.evaluate(() => {
    const e = window.__G.enemies;
    return e.aliveCount ? e.aliveCount() : e.list.filter((x) => x.alive).length;
  });
const fps = (page) => page.evaluate(() => window.__stats().fps);
const claim = (page, name) =>
  page.evaluate(async (name) => {
    await new Promise((ok) => {
      const poll = () => (window.__G.economy && window.__G.story ? ok() : setTimeout(poll, 100));
      poll();
    });
    const r = await window.__G.economy.wallet.claim(name);
    if (!r.ok) throw new Error("claim failed: " + r.error);
  }, name);
const deploy = (page) => page.click('[data-s="title"] [data-act="deploy"]');
const heard = (page, text, timeout = 15000) =>
  page.waitForFunction((t) => window.__radio.includes(t), text, { timeout }).then(() => true, () => false);
/** Waits for a line matching `re` to start on the radio; returns its text, or null. */
const heardLike = (page, re, timeout = 15000) =>
  page
    .waitForFunction((src) => window.__radio.find((t) => new RegExp(src).test(t)) || null, re.source, { timeout })
    .then((h) => h.jsonValue(), () => null);
/** Waits until the Harbormaster's box is up with this text, typed out; true if it was. */
const onAir = (page, text, timeout = 45000) =>
  page
    .waitForFunction(
      (t) => {
        const c = document.querySelector(".comms");
        return !!c && c.classList.contains("st-hm") && c.classList.contains("on") && c.querySelector(".comms-t").textContent === t;
      },
      text,
      { timeout, polling: 100 },
    )
    .then(() => true, () => false);
const idle = (page, timeout = 30000) =>
  page
    .waitForFunction(() => !document.querySelector(".comms")?.classList.contains("on"), null, { timeout, polling: 100 })
    .then(() => true, () => false);
const look = (page) =>
  page.evaluate(() => {
    const c = document.querySelector(".comms");
    const who = c.querySelector(".comms-who");
    return { who: who.textContent, colour: getComputedStyle(who).color, font: getComputedStyle(c.querySelector(".comms-t")).fontFamily.split(",")[0] };
  });
const cardText = (page) => page.evaluate(() => [...document.querySelectorAll(".loc-card b, .loc-card em, .loc-card span")].map((n) => n.textContent));

/** Catches the chapter card on screen at the start of a run, fully drawn. */
async function chapterCard(page, name) {
  const up = await page.waitForSelector(".loc-card.on", { timeout: 10000 }).then(() => true, () => false);
  const text = await cardText(page);
  await page.waitForTimeout(1300); // the kicker types in over 1.1 s, the line fades in after it
  await shot(page, name);
  return { up, text };
}

/** The Harbormaster's lines as they played: each on its own channel, and never within 8 s of the last one ending. */
async function channelChecks(page, label) {
  const all = (await page.evaluate(() => window.__channel)).sort((a, b) => a.at - b.at);
  const channel = all.filter((l) => !l.clear);
  const wrong = channel.filter((l) => l.hm !== HM_LINE.test(l.text));
  check(wrong.length === 0, `${label}: each line plays on its speaker's channel`, wrong.map((l) => `${l.hm ? "HM" : "Control"}: ${l.text.slice(0, 40)}`).join(" | "));
  const hm = channel.filter((l) => l.hm);
  const close = [];
  for (let i = 1; i < hm.length; i++) {
    // When the previous line ended: its time on air at the hold story/index.ts gives it, or sooner if the next line or
    // a clear of the radio came first.
    const prev = hm[i - 1];
    const next = all.find((e) => e.at > prev.at);
    const end = Math.min(prev.at + lineMs(prev.text, holdOf(prev.text)), next ? next.at : Infinity);
    const gap = hm[i].at - end;
    if (gap < 8000 - 100) close.push(`${hm[i].text.slice(0, 24)} ${Math.round(gap)} ms after`);
  }
  check(hm.length > 0 && close.length === 0, `${label}: the Harbormaster's lines never stack within 8 s`, close.join(" | ") || `${hm.length} lines`);
  return channel;
}

/** Stand at (x, z) facing (tx, tz); the game's forward is (-sin yaw, 0, -cos yaw). */
const stand = (page, x, z, tx, tz, pitch = -0.05) =>
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

/** Cuts the first sealed container's seal with E, as a player would. */
async function cutSeal(page) {
  await page.waitForFunction(() => window.__G.salvage && window.__G.salvage.state.status === "live", null, { timeout: 15000 });
  const seal = await page.evaluate(() => {
    const t = window.__G.salvage.state.targets.filter((t) => t.kind === "seal");
    return t.map((e) => ({ spot: e.spot, at: e.at, out: e.out }));
  });
  const first = seal.find((t) => t.at.y > 1) || seal[0];
  await stand(page, first.at.x + first.out.x * 1.2, first.at.z + first.out.z * 1.2, first.at.x, first.at.z, -0.12);
  await page.waitForTimeout(250);
  await page.keyboard.down("e");
  const ok = await page
    .waitForFunction((spot) => window.__G.salvage.state.opened.includes(spot), first.spot, { timeout: 6000 })
    .then(() => true, () => false);
  await page.keyboard.up("e");
  return ok;
}

// ---- 1. a fresh player: dark town, the briefing on the first DEPLOY, the chapter card, the billing ----
let baseline;
{
  const { page, errors } = await open("mock=1&noaudio=1&act=1");
  await page.waitForFunction(() => !!window.__G.story && !!window.__G.story.town.last, null, { timeout: 10000 });
  const lights = await page.evaluate(() => ({ state: window.__G.story.lights?.state, read: window.__G.story.town.last?.status, act: window.__G.story.town.last?.view?.act }));
  check(lights.read === "ok" && lights.act === 1 && lights.state && !lights.state.clinic && !lights.state.generators, "the town is dark in Chapter 1", JSON.stringify(lights));
  check(await atQuay(page), "the title camera reaches the quay");
  await shot(page, "title-dark");
  if (quick) await page.evaluate(() => window.__setShot({ cam: "" })); // hand the camera back to the game

  await claim(page, "BRIEF");
  await deploy(page);
  await page.waitForSelector(".st-brief.on .st-card.in", { timeout: 10000 });
  await page.waitForFunction(() => window.__G.story.briefing.card === 2, null, { timeout: 15000 });
  await page.waitForTimeout(900);
  await shot(page, "briefing-3");
  const card3 = await page.evaluate(() => document.querySelector(".st-brief .st-t")?.textContent);
  check(card3 === BRIEFING_3, "the briefing's third card is the impound", card3);
  const held = await page.evaluate(() => ({ state: window.__G.game.state, runs: window.__runs }));
  check(held.state === "title" && held.runs === 0, "the briefing plays before the run starts", JSON.stringify(held));
  const t0 = Date.now();
  await page.keyboard.press("Escape");
  const card = await chapterCard(page, "chapter-1");
  check(card.up && JSON.stringify(card.text) === JSON.stringify(CARD_1), "the Chapter 1 card opens the run", JSON.stringify(card.text));
  await page.waitForFunction(() => window.__G.game.state === "playing", null, { timeout: 10000 });
  const after = await page.evaluate(() => ({
    runs: window.__runs,
    up: window.__G.story.briefing.active,
    memory: JSON.parse(localStorage.getItem("saltline.story.v1") || "null"),
  }));
  check(!after.up && after.runs === 1 && after.memory?.briefed === true, "Esc skips it, the run starts once, and it's remembered", `${Date.now() - t0} ms`);
  await page.evaluate(() => (window.__G.player.invulnerable = true)); // drones would end a scripted run
  const patrol = await alive(page);
  check(await heard(page, intro("BRIEF")), "Control's intro calls the player by callsign");
  check(await heard(page, ACT1), "Control's Chapter 1 line follows it");

  // The surcharge: a fresh pass has no extractions, so 150 scrip.
  const bill = trespass("BRIEF", 150);
  const billed = await onAir(page, bill);
  await page.waitForTimeout(300);
  await shot(page, "harbormaster-bill");
  const lk = await look(page);
  check(billed && lk.who === "Harbormaster" && lk.colour !== "rgb(255, 179, 71)", "the Harbormaster bills the trespass surcharge on its own channel", JSON.stringify(lk));

  // A seal: the Harbormaster notes the tampering (or counts the evidence, if that one box was past 4).
  check(await cutSeal(page), "holding E cuts a seal");
  const sealLine = await heardLike(page, new RegExp(`^(${SEAL.replace(/\./g, "\\.")}|${EVIDENCE.source.slice(1, -1)})$`), 30000);
  check(!!sealLine, "the Harbormaster answers the seal in its turn", sealLine || "not heard");

  // The first relay, once the radio's quiet: Control, then the Harbormaster.
  await idle(page);
  const cutAt = Date.now();
  await page.evaluate(() => window.__G.game.debugCut());
  check(await heard(page, "One uplink dark. It's filing a complaint. Machines inbound.", 10000), "Control's line for the first cut");
  check(await heard(page, CUT, 25000), "the Harbormaster answers the first relay cut");
  await page.waitForTimeout(Math.max(0, 12000 - (Date.now() - cutAt))); // the wave's drones come in about a second apart
  baseline = { patrol, after: await alive(page) };
  check(baseline.patrol >= 1 && baseline.after > baseline.patrol, "the baseline first wave spawns", JSON.stringify(baseline));
  const f = await fps(page);
  check(f >= 50, "fps stays near 60 in the run", f.toFixed(1));

  // The boat: Control signs off by callsign, and the Harbormaster invoices the haul at the debrief's value.
  await page.evaluate(() => {
    const G = window.__G;
    for (let i = 0; i < 2; i++) G.game.debugCut();
  });
  await page.waitForTimeout(300);
  await page.evaluate(() => (window.__skew += 120_000)); // past the minimum run time, instead of waiting it out
  const boat = await page.evaluate(() => window.__G.level.extraction.pos);
  await stand(page, boat.x, boat.z, boat.x + 1, boat.z);
  await page.waitForFunction(() => window.__G.game.state === "complete", null, { timeout: 10000 }).catch(() => {});
  check(await heard(page, done("BRIEF"), 5000), "Control signs off by callsign");
  const invoice = await heardLike(page, INVOICE, 35000);
  const value = await page.evaluate(() => [...document.querySelectorAll(".sv-sec .sv-row")].map((r) => r.textContent).find((t) => /scrip/.test(t)) || "");
  const billedAt = invoice ? INVOICE.exec(invoice)[1] : null;
  check(!!invoice && value.includes(`${billedAt} scrip`), "the Harbormaster invoices the haul at the debrief's value", `${invoice} / ${value}`);
  if (invoice) {
    await onAir(page, invoice, 8000);
    await page.waitForTimeout(300);
    await shot(page, "harbormaster-invoice");
  }
  await channelChecks(page, "Chapter 1");
  check(errors.length === 0, "no console errors", errors.slice(0, 3).join(" | "));
  await page.close();
}
{
  const { page, errors } = await open("mock=1&noaudio=1&act=1", { memory: { v: 1, briefed: true, heard: [], peak: 0 } });
  await claim(page, "AGAIN");
  await page.click('[data-s="title"] .st-replay');
  await page.waitForSelector(".st-brief.on", { timeout: 5000 });
  await page.mouse.click(640, 360);
  await page.waitForFunction(() => !window.__G.story.briefing.active, null, { timeout: 5000 });
  check((await page.evaluate(() => window.__G.game.state)) === "title", "BRIEFING replays it from the title, a click skips, no run starts");
  // The Town tab names the chapters.
  await page.waitForFunction(() => !!window.__dock?.dockside, null, { timeout: 10000 });
  await page.evaluate(async () => (await window.__dock.dockside.open("title"), window.__dock.dockside.tab("town")));
  await page.waitForSelector('.dk-town[data-state="ok"]', { timeout: 10000 });
  await page.waitForTimeout(1500);
  await shot(page, "town-chapter-1");
  const tw = await page.evaluate(() => ({
    k: [...document.querySelectorAll(".dk-tw-act-k")].map((e) => e.firstChild?.nextSibling?.textContent ?? e.textContent),
    n: [...document.querySelectorAll(".dk-tw-act-n")].map((e) => e.textContent),
    chip: document.querySelector(".dk-tab-act")?.textContent,
  }));
  check(
    JSON.stringify(tw.n) === JSON.stringify(["Proof of Delivery", "Bill of Lading", "Final Notice"]) && tw.chip === "Ch 1",
    "the Town tab names the chapters",
    JSON.stringify(tw),
  );
  await page.evaluate(() => window.__dock.dockside.close?.());
  await page.waitForTimeout(500);
  await deploy(page);
  await page.waitForFunction(() => window.__runs === 1, null, { timeout: 10000 });
  check(!(await page.evaluate(() => window.__G.story.briefing.active)), "a returning player's DEPLOY goes straight in");
  check(errors.length === 0, "no console errors", errors.slice(0, 3).join(" | "));
  await page.close();
}

// ---- 2. Chapter 3: the card, the Harbormaster's channel and its drones ----
{
  const { page, errors } = await open("mock=1&noaudio=1&act=3", { memory: { v: 1, briefed: true, heard: [], peak: 0 } });
  await claim(page, "ACT THREE");
  await deploy(page);
  const card = await chapterCard(page, "chapter-3");
  check(card.up && JSON.stringify(card.text) === JSON.stringify(CARD_3), "the Chapter 3 card opens the run", JSON.stringify(card.text));
  await page.waitForFunction(() => window.__runs === 1 && !!window.__G.story.run.read, null, { timeout: 10000 });
  const bonus = await page.evaluate(async () => ({
    ext: window.__G.ext.waveBonus,
    town: (await window.__G.economy.chain.town()).harbormaster,
  }));
  check(
    bonus.ext.alive === Math.min(4, bonus.town.bonusDrones) && bonus.ext.alive > 0 && bonus.ext.hound * 2 <= bonus.ext.gull,
    "the town's bonus_drones become extra drones a wave, at most a hound per two gulls",
    JSON.stringify(bonus),
  );
  await page.waitForFunction(() => window.__G.game.state === "playing", null, { timeout: 15000 });
  await page.evaluate(() => (window.__G.player.invulnerable = true));
  const patrol = await alive(page);
  check(patrol === baseline.patrol + bonus.ext.alive, "the patrol carries the extra drones", `${patrol} vs ${baseline.patrol}`);
  check(await heard(page, act2("ACT THREE"), 20000), "Control says the lights are back, by callsign (first sight of Chapter 2 or later)");
  check(await heard(page, REVEAL, 20000), "Control gives the reveal");
  const runLines = await page.evaluate(() => window.__G.story.run.lines.map((l) => ({ who: l.who, text: l.text })));
  console.log(`     run-start lines: ${runLines.map((l) => `${l.who}: ${l.text}`).join(" / ")}`);
  const hmStart = runLines.filter((l) => l.who === "harbormaster").map((l) => l.text);
  check(hmStart[0] === trespass("ACT THREE", 150), "the surcharge opens the Harbormaster's run-start lines", hmStart[0]);
  for (const t of hmStart) check(await heard(page, t, 50000), "the Harbormaster says its run-start line in its turn", t.slice(0, 60));
  await idle(page);
  const cutAt = Date.now();
  await page.evaluate(() => window.__G.game.debugCut());
  const answered = await onAir(page, CUT, 30000);
  await page.waitForTimeout(400);
  await shot(page, "harbormaster");
  const lk = await look(page);
  check(answered && lk.who === "Harbormaster" && lk.colour !== "rgb(255, 179, 71)", "the Harbormaster answers the first relay cut on its own channel", JSON.stringify(lk));
  await page.waitForTimeout(Math.max(0, 12000 - (Date.now() - cutAt)));
  const wave = await alive(page);
  check(wave === baseline.after + 2 * bonus.ext.alive, "the first wave carries the extra drones", `${wave} alive vs ${baseline.after}`);
  await channelChecks(page, "Chapter 3");
  const f = await fps(page);
  check(f >= 50, "fps stays near 60 with the extra drones", f.toFixed(1));
  check(errors.length === 0, "no console errors", errors.slice(0, 3).join(" | "));
  await page.close();
}
{
  // The Town tab in Chapter 3.
  const { page, errors } = await open("mock=1&noaudio=1&act=3", { memory: { v: 1, briefed: true, heard: [], peak: 0 } });
  await claim(page, "ACT THREE");
  await page.waitForFunction(() => !!window.__dock?.dockside, null, { timeout: 10000 });
  await page.evaluate(async () => (await window.__dock.dockside.open("title"), window.__dock.dockside.tab("town")));
  await page.waitForSelector('.dk-town[data-state="ok"][data-act="3"]', { timeout: 10000 });
  await page.waitForTimeout(1500);
  await shot(page, "town-chapter-3");
  const line = await page.evaluate(() => document.querySelector(".dk-tw-sees .dk-tw-line")?.textContent);
  check(line === CARD_3[1], "the Town tab carries Chapter 3's line", line);
  check(errors.length === 0, "no console errors", errors.slice(0, 3).join(" | "));
  await page.close();
}

// ---- 3. Chapter 2: the town is lit ----
{
  const { page, errors } = await open("mock=1&noaudio=1&act=2");
  await page.waitForFunction(() => !!window.__G.story, null, { timeout: 10000 });
  check(await atQuay(page), "the title camera reaches the quay");
  const lights = await page.evaluate(() => ({ state: window.__G.story.lights.state, level: window.__G.story.lights.level }));
  check(lights.state.clinic && lights.state.generators && lights.level.generators === 1, "the clinic and the generators are lit in Chapter 2", JSON.stringify(lights));
  await shot(page, "title-lit");
  const f = await fps(page);
  check(f >= 50, "fps stays near 60 on the title", f.toFixed(1));
  check(errors.length === 0, "no console errors", errors.slice(0, 3).join(" | "));
  await page.close();
}

// ---- 4. the baseline: ?noeconomy attaches no story ----
{
  const { page, errors } = await open("noaudio=1&noeconomy=1");
  await page.waitForTimeout(1500);
  const premise = await page.evaluate(() => document.querySelector(".m-premise")?.textContent);
  check(
    premise === "The port’s machine kept the only ledger. Then it impounded the town. Cut its uplinks, haul out the cargo, and ignore the invoices.",
    "the title's premise is the story's",
    premise,
  );
  await deploy(page);
  const ok = await page.waitForFunction(() => window.__G.game.state === "playing", null, { timeout: 10000 }).then(() => true, () => false);
  const s = await page.evaluate(() => ({ story: !!window.__G.story, economy: !!window.__G.economy, brief: !!document.querySelector(".st-brief"), bonus: window.__G.ext.waveBonus ?? null }));
  check(ok && !s.story && !s.economy && !s.brief && s.bonus === null, "?noeconomy plays the baseline: no story, no briefing, no bonus", JSON.stringify(s));
  check(await heard(page, intro("Breacher")), "the baseline speaks the story's Control lines, to Breacher");
  const loc = await cardText(page);
  check(loc[0] === "Saltline Terminal · Berth 4 · 05:42", "the baseline keeps its location card", JSON.stringify(loc));
  await page.evaluate(() => (window.__G.player.invulnerable = true));
  const patrol = await alive(page);
  check(patrol === baseline.patrol, "the baseline patrol is unchanged", `${patrol}`);
  check(errors.length === 0, "no console errors", errors.slice(0, 3).join(" | "));
  await page.close();
}

await browser.close();
console.log(failed ? `\n${failed} check(s) failed` : "\nall story checks passed");
process.exit(failed ? 1 : 0);
