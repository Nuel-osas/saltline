// Headless smoke test of the score (src/economy/score), with the game's audio on, on the offline mock.
//
//   npm run dev -- --port 5305
//   node scripts/smoke-score.mjs [http://127.0.0.1:5305]
//
// Chrome is launched with --autoplay-policy=no-user-gesture-required so the game's AudioContext runs without a
// click. An AnalyserNode is put on the score's own output (G.score.debug().output, before the game's music bus) and
// read every animation frame.
// 1. ?mock=1: the score is on the music bus and has faded the baseline's baked loops out. Each state is pinned in
//    turn with G.score.hold(): it must be heard (RMS over a floor), stay under a peak cap, change without a step
//    discontinuity (the largest sample-to-sample jump, through every crossfade), keep to its node budget, and
//    announce itself on score:state. Then the game's own events drive it: a run, an alert, a Bailiff nearby.
//    Volume 0 silences it and bringing the volume back restores it. Frame times are compared with the score on and
//    off (disposed).
// 2. ?mock=1&noaudio=1: the state still follows the game, and nothing is built or played.
// Exits non-zero if a check failed.
import { launch } from "./browser.mjs";

const base = process.argv.find((a) => a.startsWith("http")) || "http://127.0.0.1:5305";
const FLOOR = 0.006; // RMS: about -44 dBFS
const CAP = 0.45; // peak, at the score's output
const STEP = 0.2; // the largest jump between two samples; a click at these levels is 0.3 and up
const NODES = 42;
const STATES = ["title", "infiltrate", "combat", "stalker", "setpiece", "boss", "clear", "debrief", "dead", "ending"];

let failed = 0;
const check = (ok, what, detail = "") => {
  console.log(`${ok ? "ok  " : "FAIL"} ${what}${detail ? " — " + detail : ""}`);
  if (!ok) failed++;
};
const db = (x) => (x > 0 ? (20 * Math.log10(x)).toFixed(1) : "-inf");

const browser = await launch(["--autoplay-policy=no-user-gesture-required"]);

async function open(query) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  const errors = [];
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.addInitScript(() => {
    localStorage.clear();
    localStorage.setItem("saltline.story.v1", JSON.stringify({ v: 1, briefed: true, heard: ["act2", "reveal"], peak: 0 }));
  });
  await page.goto(`${base}/play/?${query}`, { waitUntil: "load" });
  await page.waitForFunction(() => window.__ready === true, null, { timeout: 90000 });
  await page.waitForFunction(() => !!window.__G.economy && !!window.__G.score, null, { timeout: 15000 });
  await page.evaluate(() => {
    window.__states = [];
    window.__G.events.on("score:state", (e) => window.__states.push(e.state));
  });
  return { page, errors };
}

/** Frame time over `ms`, in milliseconds a frame. */
const frames = (page, ms) =>
  page.evaluate(
    (ms) =>
      new Promise((resolve) => {
        const t0 = performance.now();
        let n = 0;
        const loop = (t) => (t - t0 < ms ? (n++, requestAnimationFrame(loop)) : resolve((t - t0) / Math.max(1, n)));
        requestAnimationFrame(loop);
      }),
    ms,
  );
const meter = (page, what) => page.evaluate((what) => window.__meter[what](), what);
const wait = (page, ms) => page.waitForTimeout(ms);

try {
  // ---- 1. audio on ----
  {
    const { page, errors } = await open("mock=1");
    await page.mouse.click(4, 4); // belt and braces: the game also resumes its context on the first gesture
    await page.waitForFunction(() => window.__G.audio.ctx && window.__G.audio.ctx.state === "running", null, { timeout: 10000 });
    await page.waitForFunction(() => !!window.__G.score.debug().output, null, { timeout: 10000 });
    await page.evaluate(() => {
      const G = window.__G;
      const ctx = G.audio.ctx;
      const an = ctx.createAnalyser();
      an.fftSize = 2048;
      G.score.debug().output.connect(an);
      const buf = new Float32Array(an.fftSize);
      const m = { sq: 0, n: 0, peak: 0, step: 0 };
      const loop = () => {
        an.getFloatTimeDomainData(buf);
        for (let i = 0; i < buf.length; i++) {
          const v = buf[i];
          m.sq += v * v;
          if (Math.abs(v) > m.peak) m.peak = Math.abs(v);
          if (i && Math.abs(v - buf[i - 1]) > m.step) m.step = Math.abs(v - buf[i - 1]);
        }
        m.n += buf.length;
        requestAnimationFrame(loop);
      };
      requestAnimationFrame(loop);
      window.__meter = {
        /** Starts a new RMS window; the peak and the largest step keep running until `clear`. */
        mark: () => ((m.sq = 0), (m.n = 0)),
        clear: () => ((m.sq = 0), (m.n = 0), (m.peak = 0), (m.step = 0)),
        read: () => ({ rms: m.n ? Math.sqrt(m.sq / m.n) : 0, peak: m.peak, step: m.step }),
      };
    });

    // The baseline's own music: its loops start once their buffers are made; the score must then have taken them.
    await page.waitForFunction(() => window.__G.audio.debug().music === true, null, { timeout: 60000 }).catch(() => {});
    await wait(page, 300);
    const route = await page.evaluate(() => ({ ...window.__G.score.debug(), output: null, bed: window.__G.audio.debug().music }));
    check(route.route === "music", "the score plays into the game's music bus", `route ${route.route}`);
    check(route.bed && route.tookBed, "the baseline's baked music loops are running, and faded out under the score", `baseline loops ${route.bed}, taken ${route.tookBed}`);

    // Pinned silent first: the music stops, and every state after it is a change that has to be announced.
    await page.evaluate(() => window.__G.score.hold("silent"));
    await wait(page, 5500);
    await meter(page, "clear");
    await wait(page, 1000);
    const hush = await meter(page, "read");
    check((await page.evaluate(() => window.__G.score.state())) === "silent" && hush.peak < 0.01, "pinned silent: the music fades away", `peak ${hush.peak.toFixed(4)}`);

    const table = [];
    for (const state of STATES) {
      await meter(page, "clear");
      await page.evaluate((s) => window.__G.score.hold(s), state);
      await wait(page, 3200); // the half-bar line (up to 1.7 s) and the crossfade
      await meter(page, "mark");
      await wait(page, 3600); // a bar and a bit of the state itself
      const m = await meter(page, "read");
      const d = await page.evaluate(() => ({ ...window.__G.score.debug(), output: null, said: window.__G.score.state(), heard: window.__states.slice() }));
      const want = state === "stalker" ? "infiltrate" : state;
      table.push(`${state.padEnd(11)} rms ${db(m.rms).padStart(6)} dBFS  peak ${db(m.peak).padStart(6)} dBFS  max step ${m.step.toFixed(3)}  nodes ${d.nodes}`);
      check(d.said === state && d.where?.state === want && d.heard.includes(state), `${state}: pinned, playing and announced`, `state() ${d.said}, engine ${d.where?.state}`);
      check(m.rms > FLOOR, `${state}: audible`, `rms ${db(m.rms)} dBFS`);
      check(m.peak < CAP, `${state}: under the peak cap`, `peak ${m.peak.toFixed(3)}`);
      check(m.step < STEP, `${state}: no click going in`, `largest step ${m.step.toFixed(3)}`);
      check(d.nodes <= NODES, `${state}: within the node budget`, `${d.nodes} nodes`);
    }
    console.log(table.map((l) => "     " + l).join("\n"));

    // The game's own events, nothing pinned.
    await page.evaluate(async () => {
      const G = window.__G;
      G.score.hold(null);
      const r = await G.economy.wallet.claim("SCORE");
      if (!r.ok) throw new Error("claim failed: " + r.error);
      G.game.start({ skipIntro: true });
    });
    await page.waitForFunction(() => window.__G.game.state === "playing", null, { timeout: 15000 });
    await page.evaluate(() => (window.__G.player.invulnerable = true));
    // The first seconds of a run may already have a drone alerted; either is a run's music.
    const run = await page.evaluate(() => window.__G.score.state());
    check(run === "infiltrate" || run === "combat", "a run starts on its own music", run);
    await page.evaluate(() => window.__G.events.emit("enemy:alert", { enemy: { type: "gull", pos: { x: 0, y: 4, z: 0 } } }));
    check((await page.evaluate(() => window.__G.score.state())) === "combat", "an alert brings in combat");
    await page.evaluate(() => {
      window.__near = setInterval(() => window.__G.events.emit("bailiff:near", { id: 1, dist: 7, standing: true }), 400);
      window.__G.events.emit("bailiff:near", { id: 1, dist: 7, standing: true });
    });
    await meter(page, "clear");
    await wait(page, 4000);
    const st = await page.evaluate(() => ({ s: window.__G.score.state(), r: window.__G.score.debug().reading }));
    const sm = await meter(page, "read");
    check(st.s === "stalker" && st.r.heartBpm > 100, "a standing Bailiff at 7 m lays its layer over the run", `${st.s} over ${st.r.base}, heart ${Math.round(st.r.heartBpm)} bpm`);
    check(sm.rms > FLOOR && sm.peak < CAP && sm.step < STEP, "the run's music is heard, capped and clean", `rms ${db(sm.rms)} dBFS, peak ${sm.peak.toFixed(3)}, step ${sm.step.toFixed(3)}`);
    await page.evaluate(() => clearInterval(window.__near));

    // Volume 0, and back.
    const setVolume = (v) =>
      page.evaluate((v) => {
        const G = window.__G;
        G.game.menus.settings.volume = v;
        G.audio.setVolume(v);
      }, v);
    await setVolume(0);
    await wait(page, 1500);
    await meter(page, "clear");
    await wait(page, 1500);
    const quiet = await meter(page, "read");
    check(quiet.peak < 1e-3, "volume 0: the score is silent at its own output", `peak ${quiet.peak.toExponential(1)}`);
    await setVolume(0.8);
    await wait(page, 2500);
    await meter(page, "clear");
    await wait(page, 2500);
    const back = await meter(page, "read");
    check(back.rms > FLOOR, "the volume back up: it returns", `rms ${db(back.rms)} dBFS`);

    // Cost: frame time in a run with the score playing its busiest state, then with it disposed.
    await page.evaluate(() => window.__G.score.hold("boss"));
    await wait(page, 2500);
    const c0 = await page.evaluate(() => ({ ...window.__G.score.debug().cost, t: performance.now() }));
    const withScore = await frames(page, 6000);
    const c1 = await page.evaluate(() => ({ ...window.__G.score.debug().cost, t: performance.now() }));
    // Its own main-thread time (the 50 ms timer), spread over 60 frames a second.
    const perFrame = (c1.ms - c0.ms) / (((c1.t - c0.t) / 1000) * 60);
    check(perFrame < 0.2, "its scheduler takes well under 1 ms a frame", `${perFrame.toFixed(4)} ms a frame, ${((c1.ms - c0.ms) / Math.max(1, c1.ticks - c0.ticks)).toFixed(3)} ms a tick`);
    await page.evaluate(() => window.__G.score.dispose());
    await wait(page, 1000);
    const without = await frames(page, 6000);
    check(Math.abs(withScore - without) < 1, "the score costs under 1 ms a frame", `${withScore.toFixed(2)} ms with, ${without.toFixed(2)} ms without`);
    check(errors.length === 0, "no console errors with audio on", errors.slice(0, 3).join(" | "));
    await page.close();
  }

  // ---- 2. ?noaudio ----
  {
    const { page, errors } = await open("mock=1&noaudio=1");
    await wait(page, 1500);
    const d = await page.evaluate(() => {
      const G = window.__G;
      const before = G.score.state();
      G.score.hold("ending");
      const held = G.score.state();
      G.score.hold(null);
      return { before, held, ...G.score.debug(), output: !!G.score.debug().output, heard: window.__states.slice() };
    });
    check(d.before === "title" && d.held === "ending" && d.heard.includes("ending"), "?noaudio: the state still follows the game and a hold", `${d.before}, held ${d.held}`);
    check(!d.audible && !d.output && d.nodes === 0, "?noaudio: nothing is built and nothing plays", `audible ${d.audible}, nodes ${d.nodes}`);
    check(errors.length === 0, "no console errors with ?noaudio", errors.slice(0, 3).join(" | "));
    await page.close();
  }
} finally {
  await browser.close();
}
console.log(failed ? `\n${failed} check(s) failed` : "\nall checks passed");
process.exit(failed ? 1 : 0);
