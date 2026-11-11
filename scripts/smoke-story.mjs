// Headless smoke test of the story layer (src/economy/story) on the offline mock, then the ?noeconomy baseline.
//
//   npm run dev -- --port 5295
//   node scripts/smoke-story.mjs [http://127.0.0.1:5295] [--shots DIR] [--quick]
//
// The mock's ?act=1|2|3 (mock.ts) puts its town at an act.
// 1. ?act=1, a fresh player: the town is dark from the title camera. The first DEPLOY (after a dock pass claimed on
//    the mock) plays the briefing before the run starts; Esc skips it; Control's new intro line and the Act I line
//    follow. The first wave is counted for comparison. Then a returning player: BRIEFING replays it, DEPLOY doesn't.
// 2. ?act=3 (strength 62, two extra drones): Control's once-only lines, the patrol and the first wave carry the
//    extra drones, and the Harbormaster answers the first relay cut on its own channel.
// 3. ?act=2: the town is lit from the title camera.
// 4. ?noeconomy=1: no story, no briefing, the baseline plays with the new copy.
// --quick skips waiting for the title camera to reach the quay (about 90 s a page) and frames the shot directly.
// Exits non-zero if a check failed.
import { mkdirSync } from "node:fs";
import { launch } from "./browser.mjs";

const base = process.argv.find((a) => a.startsWith("http")) || "http://127.0.0.1:5295";
const shotsAt = process.argv.indexOf("--shots");
const shots = shotsAt > 0 ? process.argv[shotsAt + 1] : null;
const quick = process.argv.includes("--quick");
if (shots) mkdirSync(shots, { recursive: true });

const INTRO =
  "Breacher, Control. The Harbormaster holds the berth. Cut its three uplinks, yard, shed, quay, and bring back what you can carry. The town is counting on the boat.";
const ACT1 = "Clinic's on its last crates of meds. Ines will pay for every box.";
const ACT2 = "Lights on the water, Breacher. That's the clinic. Your cargo did that.";
const REVEAL = "Control. The Quartermaster's client is the Harbormaster. Every core you sell him builds it back. Your call.";
const CUT = "That uplink was mine. I have others.";

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
  }, memory);
  await page.goto(`${base}/?${query}`, { waitUntil: "load" });
  await page.waitForFunction(() => window.__ready === true, null, { timeout: 90000 });
  await page.evaluate(() => {
    const G = window.__G;
    window.__radio = [];
    window.__runs = 0;
    window.__channel = [];
    G.events.on("radio:line", (e) => {
      window.__radio.push(e.text);
      // The box as the line starts: which channel it's on.
      queueMicrotask(() => {
        const c = document.querySelector(".comms");
        window.__channel.push({ text: e.text, hm: !!c && c.classList.contains("st-hm"), who: c?.querySelector(".comms-who")?.textContent });
      });
    });
    G.events.on("run:start", () => window.__runs++);
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

/** Cuts the first relay once the run is on and counts the drones alive once the wave has had time to spawn. */
async function firstWave(page) {
  await page.waitForFunction(() => window.__G.game.state === "playing", null, { timeout: 15000 });
  await page.evaluate(() => (window.__G.player.invulnerable = true)); // drones would end a scripted run
  const patrol = await alive(page);
  await page.evaluate(() => window.__G.game.debugCut());
  await page.waitForTimeout(12000); // the wave's drones come in one by one, about a second apart
  return { patrol, after: await alive(page), state: await page.evaluate(() => window.__G.game.state) };
}

// ---- 1. a fresh player: dark town, the briefing on the first DEPLOY, the new lines ----
let baseline;
{
  const { page, errors } = await open("noaudio=1&act=1");
  await page.waitForFunction(() => !!window.__G.story && !!window.__G.story.town.last, null, { timeout: 10000 });
  const lights = await page.evaluate(() => ({ state: window.__G.story.lights?.state, read: window.__G.story.town.last?.status, act: window.__G.story.town.last?.view?.act }));
  check(lights.read === "ok" && lights.act === 1 && lights.state && !lights.state.clinic && !lights.state.generators, "the town is dark in Act I", JSON.stringify(lights));
  check(await atQuay(page), "the title camera reaches the quay");
  await shot(page, "title-dark");
  if (quick) await page.evaluate(() => window.__setShot({ cam: "" })); // hand the camera back to the game

  await claim(page, "BRIEF");
  await deploy(page);
  await page.waitForSelector(".st-brief.on .st-card.in", { timeout: 10000 });
  await page.waitForFunction(() => window.__G.story.briefing.card === 1, null, { timeout: 10000 });
  await page.waitForTimeout(700);
  await shot(page, "briefing");
  const held = await page.evaluate(() => ({ state: window.__G.game.state, runs: window.__runs }));
  check(held.state === "title" && held.runs === 0, "the briefing plays before the run starts", JSON.stringify(held));
  const t0 = Date.now();
  await page.keyboard.press("Escape");
  await page.waitForFunction(() => window.__G.game.state === "playing", null, { timeout: 10000 });
  const after = await page.evaluate(() => ({
    runs: window.__runs,
    up: window.__G.story.briefing.active,
    memory: JSON.parse(localStorage.getItem("saltline.story.v1") || "null"),
  }));
  check(!after.up && after.runs === 1 && after.memory?.briefed === true, "Esc skips it, the run starts once, and it's remembered", `${Date.now() - t0} ms`);
  check(await heard(page, INTRO), "Control's intro line is the story's");
  check(await heard(page, ACT1), "Control's Act I line follows it");
  baseline = await firstWave(page);
  check(baseline.patrol >= 1 && baseline.after > baseline.patrol, "the baseline first wave spawns", JSON.stringify(baseline));
  const f = await fps(page);
  check(f >= 50, "fps stays near 60 in the run", f.toFixed(1));
  check(errors.length === 0, "no console errors", errors.slice(0, 3).join(" | "));

  // A second visit: no briefing on DEPLOY; the title's BRIEFING button replays it.
  await page.evaluate(() => {
    window.__G.player.invulnerable = false;
    window.__G.game.pause();
  });
  await page.close();
}
{
  const { page, errors } = await open("noaudio=1&act=1", { memory: { v: 1, briefed: true, heard: [], peak: 0 } });
  await claim(page, "AGAIN");
  await page.click('[data-s="title"] .st-replay');
  await page.waitForSelector(".st-brief.on", { timeout: 5000 });
  await page.mouse.click(640, 360);
  await page.waitForFunction(() => !window.__G.story.briefing.active, null, { timeout: 5000 });
  check((await page.evaluate(() => window.__G.game.state)) === "title", "BRIEFING replays it from the title, a click skips, no run starts");
  await deploy(page);
  await page.waitForFunction(() => window.__runs === 1, null, { timeout: 10000 });
  check(!(await page.evaluate(() => window.__G.story.briefing.active)), "a returning player's DEPLOY goes straight in");
  check(errors.length === 0, "no console errors", errors.slice(0, 3).join(" | "));
  await page.close();
}

// ---- 2. Act III: the Harbormaster's channel and its drones ----
{
  const { page, errors } = await open("noaudio=1&act=3", { memory: { v: 1, briefed: true, heard: [], peak: 0 } });
  await claim(page, "ACT THREE");
  await deploy(page);
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
  const wave = await firstWave(page);
  check(wave.patrol === baseline.patrol + bonus.ext.alive, "the patrol carries the extra drones", `${wave.patrol} vs ${baseline.patrol}`);
  check(wave.after === baseline.after + 2 * bonus.ext.alive, "the first wave carries the extra drones", `${wave.after} alive vs ${baseline.after}`);
  check(await heard(page, ACT2, 20000), "Control says the lights are back (first sight of Act II or later)");
  check(await heard(page, REVEAL, 20000), "Control gives the reveal");
  // The Harbormaster answers the first cut on its own channel, after Control's line for it.
  const hm = await page
    .waitForFunction(
      (t) => {
        const c = document.querySelector(".comms");
        return c && c.classList.contains("st-hm") && c.classList.contains("on") && c.querySelector(".comms-t").textContent === t;
      },
      CUT,
      { timeout: 60000 },
    )
    .then(() => true, () => false);
  await page.waitForTimeout(400);
  await shot(page, "harbormaster");
  const look = await page.evaluate(() => {
    const c = document.querySelector(".comms");
    const who = c.querySelector(".comms-who");
    return { who: who.textContent, colour: getComputedStyle(who).color, font: getComputedStyle(c.querySelector(".comms-t")).fontFamily.split(",")[0] };
  });
  check(hm && look.who === "Harbormaster" && look.colour !== "rgb(255, 179, 71)", "the Harbormaster answers the first relay cut on its own channel", JSON.stringify(look));
  // Every line on the right channel: the Harbormaster's on its own, everyone else's on Control's.
  const channel = await page.evaluate(() => window.__channel);
  const hmTexts = new Set(["That uplink was mine. I have others."]);
  const wrong = channel.filter((l) => l.hm !== (hmTexts.has(l.text) || /^Breacher\. \d+ of my cores|^I count \d+ percent|^The town has stopped selling/.test(l.text)));
  check(wrong.length === 0, "each line plays on its speaker's channel", wrong.map((l) => l.text.slice(0, 30)).join(" | "));
  const runLines = await page.evaluate(() => window.__G.story.run.lines.map((l) => `${l.who}: ${l.text}`));
  console.log(`     run-start lines: ${runLines.join(" / ")}`);
  const f = await fps(page);
  check(f >= 50, "fps stays near 60 with the extra drones", f.toFixed(1));
  check(errors.length === 0, "no console errors", errors.slice(0, 3).join(" | "));
  await page.close();
}

// ---- 3. Act II: the town is lit ----
{
  const { page, errors } = await open("noaudio=1&act=2");
  await page.waitForFunction(() => !!window.__G.story, null, { timeout: 10000 });
  check(await atQuay(page), "the title camera reaches the quay");
  const lights = await page.evaluate(() => ({ state: window.__G.story.lights.state, level: window.__G.story.lights.level }));
  check(lights.state.clinic && lights.state.generators && lights.level.generators === 1, "the clinic and the generators are lit in Act II", JSON.stringify(lights));
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
  await deploy(page);
  const ok = await page.waitForFunction(() => window.__G.game.state === "playing", null, { timeout: 10000 }).then(() => true, () => false);
  const s = await page.evaluate(() => ({ story: !!window.__G.story, economy: !!window.__G.economy, brief: !!document.querySelector(".st-brief"), bonus: window.__G.ext.waveBonus ?? null }));
  check(ok && !s.story && !s.economy && !s.brief && s.bonus === null, "?noeconomy plays the baseline: no story, no briefing, no bonus", JSON.stringify(s));
  check(await heard(page, INTRO), "the baseline speaks the story's Control lines too");
  const wave = await firstWave(page);
  check(wave.patrol === baseline.patrol, "the baseline patrol is unchanged", `${wave.patrol}`);
  check(errors.length === 0, "no console errors", errors.slice(0, 3).join(" | "));
  await page.close();
}

await browser.close();
console.log(failed ? `\n${failed} check(s) failed` : "\nall story checks passed");
process.exit(failed ? 1 : 0);
