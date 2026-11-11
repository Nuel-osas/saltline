// Headless smoke test of in-run salvage on the shared offline mock (src/economy/mock.ts), then a baseline check with
// ?noeconomy. The mock plays by the real run rules (minimum run time, time between runs), so the page's Date.now gets
// a test-only skew (window.__skew, ms) that the test moves forward instead of waiting.
//
//   npm run dev -- --port 5290
//   node scripts/smoke-salvage.mjs [http://127.0.0.1:5290] [--shots DIR]
//
// Pointer lock doesn't work headless, so the run is driven through window.__G: the player is moved to a spot and
// faced at the doors, E is held through the real keyboard (the game's input module reads it), the relays are cut with
// game.debugCut() and the player is moved to the boat. Exits non-zero on the first failed check.
import { mkdirSync } from "node:fs";
import { launch } from "./browser.mjs";

const base = process.argv.find((a) => a.startsWith("http")) || "http://127.0.0.1:5290";
const shotsAt = process.argv.indexOf("--shots");
const shots = shotsAt > 0 ? process.argv[shotsAt + 1] : null;
if (shots) mkdirSync(shots, { recursive: true });

let failed = 0;
const check = (ok, what, detail = "") => {
  console.log(`${ok ? "ok  " : "FAIL"} ${what}${detail ? " — " + detail : ""}`);
  if (!ok) failed++;
};

const browser = await launch();

async function open(query, { economy = false } = {}) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  const errors = [];
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.addInitScript(() => {
    localStorage.clear(); // a fresh mock economy and wallet every time
    const real = Date.now.bind(Date);
    window.__skew = 0;
    Date.now = () => real() + window.__skew;
  });
  await page.goto(`${base}/?${query}`, { waitUntil: "load" });
  await page.waitForFunction(() => window.__ready === true, null, { timeout: 90000 });
  if (economy) {
    // Claim a dock pass on the mock, record the run calls salvage makes, then deploy.
    await page.waitForFunction(() => !!window.__G.economy, null, { timeout: 10000 });
    await page.evaluate(async () => {
      const G = window.__G;
      const r = await G.economy.wallet.claim("SMOKE " + Math.floor(Math.random() * 1e4));
      if (!r.ok) throw new Error("claim failed: " + r.error);
      const c = G.economy.chain;
      c.calls = [];
      for (const m of ["startRun", "extract", "die"]) {
        const f = c[m].bind(c);
        c[m] = (...args) => (c.calls.push({ method: m, args }), f(...args));
      }
      G.game.start({ skipIntro: true });
    });
  }
  return { page, errors };
}

const shot = async (page, name) => shots && (await page.screenshot({ path: `${shots}/${name}.png` }));

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

const fpsNow = (page) => page.evaluate(() => window.__stats().fps);

try {
  // ---- 1. a run with salvage on the offline mock ----
  // (?noaudio needs a value: the game tests it for truthiness.)
  const { page, errors } = await open("noaudio=1", { economy: true });
  const fps = [];
  await page.waitForFunction(() => window.__G.game.state === "playing", null, { timeout: 20000 });
  await page.evaluate(() => (window.__G.player.invulnerable = true)); // drones would end a scripted run

  // 2. a manifest appears
  await page.waitForFunction(() => window.__G.salvage && window.__G.salvage.state.status === "live", null, {
    timeout: 10000,
  });
  const m = await page.evaluate(() => {
    const G = window.__G;
    return {
      runId: G.economy.manifest.runId,
      containers: G.economy.manifest.containers.length,
      wrecks: G.economy.manifest.wrecks.length,
      startRun: G.economy.chain.calls.filter((c) => c.method === "startRun").length,
    };
  });
  check(m.containers === 8 && m.startRun === 1, "a manifest arrives from the mock chain", JSON.stringify(m));
  check(await page.evaluate(() => !!document.querySelector(".sv-cargo.on")), "the cargo readout is on the HUD");

  // 3. go to a sealed container (shut doors) and cut its seal
  const seal = await page.evaluate(() => {
    const t = window.__G.salvage.state.targets.filter((t) => t.kind === "seal");
    return t.map((e) => ({ key: e.key, spot: e.spot, at: e.at, out: e.out, items: e.items }));
  });
  const first = seal.find((t) => t.at.y > 1) || seal[0];
  // A step back first, for the picture: the seal from 3 m out and a little to the side.
  await stand(
    page,
    first.at.x + first.out.x * 3 - first.out.z * 0.8,
    first.at.z + first.out.z * 3 + first.out.x * 0.8,
    first.at.x,
    first.at.z,
    -0.06,
  );
  await page.waitForTimeout(700);
  await shot(page, "1-sealed-container");
  await stand(page, first.at.x + first.out.x * 1.2, first.at.z + first.out.z * 1.2, first.at.x, first.at.z, -0.12);
  await page.waitForTimeout(250);
  const prompt = await page.evaluate(() => document.querySelector(".h-prompt.on .h-plabel")?.textContent || null);
  check(!!prompt && prompt.includes("Cut seal"), "the prompt offers the seal", prompt || "no prompt");
  const t0 = Date.now();
  await page.keyboard.down("e");
  await page
    .waitForFunction((spot) => window.__G.salvage.state.opened.includes(spot), first.spot, { timeout: 5000 })
    .catch(() => {});
  const cutMs = Date.now() - t0;
  await page.keyboard.up("e");
  const after = await page.evaluate(() => {
    const G = window.__G;
    return { opened: G.salvage.state.opened, carried: G.economy.carried, scale: G.ext.speedScale };
  });
  check(
    after.opened.includes(first.spot),
    "holding E cuts the seal",
    `${cutMs} ms, carried ${JSON.stringify(after.carried)}`,
  );

  // 4. the weight slows the player
  const W = { copper: 1, meds: 1, chips: 1, fuel: 2, core: 1 };
  const weight = Object.entries(after.carried).reduce((w, [k, n]) => w + W[k] * n, 0);
  check(
    Math.abs(after.scale - (1 - 0.06 * weight)) < 1e-9 && after.scale < 1,
    "G.ext.speedScale follows the weight",
    `weight ${weight} → ${after.scale}`,
  );
  await stand(
    page,
    first.at.x + first.out.x * 1.2,
    first.at.z + first.out.z * 1.2,
    first.at.x + first.out.x * 9,
    first.at.z + first.out.z * 9,
  );
  await page.keyboard.down("w");
  await page.waitForTimeout(700);
  const speed = await page.evaluate(() => window.__G.player.speed);
  await page.keyboard.up("w");
  check(Math.abs(speed - 3.8 * after.scale) < 0.15, "the player walks slower", `${speed.toFixed(2)} m/s (3.8 unladen)`);
  fps.push(await fpsNow(page));

  // a wreck with its callsign, then recover it
  const wreck = await page.evaluate(() => window.__G.salvage.state.targets.find((t) => t.kind === "wreck") || null);
  check(!!wreck, "the manifest lays out a wreck", wreck ? wreck.callsign : "none");
  if (wreck) {
    // Out in front and a little to the side, so the rifle doesn't cover it.
    const sx = -wreck.out.z * 0.9,
      sz = wreck.out.x * 0.9;
    await stand(
      page,
      wreck.at.x + wreck.out.x * 3.4 + sx,
      wreck.at.z + wreck.out.z * 3.4 + sz,
      wreck.at.x,
      wreck.at.z,
      -0.3,
    );
    await page.waitForTimeout(700);
    await shot(page, "3-wreck");
    await stand(page, wreck.at.x + wreck.out.x * 1.3, wreck.at.z + wreck.out.z * 1.3, wreck.at.x, wreck.at.z, -0.3);
    await page.waitForTimeout(200);
    await page.keyboard.down("e");
    await page
      .waitForFunction((id) => window.__G.salvage.state.wrecks.includes(id), wreck.wreckId, { timeout: 5000 })
      .catch(() => {});
    await page.keyboard.up("e");
    check(
      await page.evaluate((id) => window.__G.salvage.state.wrecks.includes(id), wreck.wreckId),
      "holding E recovers the wreck",
    );
  }
  fps.push(await fpsNow(page));

  // The HUD mid-cut on another seal that fits: the prompt's ring, the cargo readout, the markers.
  const next = await page.evaluate(() => {
    const G = window.__G;
    const W = { copper: 1, meds: 1, chips: 1, fuel: 2, core: 1 };
    const carried = Object.entries(G.economy.carried).reduce((w, [k, n]) => w + W[k] * n, 0);
    return (
      G.salvage.state.targets.find(
        (t) => t.kind === "seal" && t.at.y > 1 && carried + W[t.items[0].tokenId] * t.items[0].amount <= 6,
      ) || null
    );
  });
  if (next) {
    await stand(
      page,
      next.at.x + next.out.x * 1.5 - next.out.z * 0.35,
      next.at.z + next.out.z * 1.5 + next.out.x * 0.35,
      next.at.x,
      next.at.z,
      0.02,
    );
    await page.waitForTimeout(250);
    await page.keyboard.down("e");
    await page.waitForTimeout(900);
    await shot(page, "2-hud-cargo");
    await page
      .waitForFunction((spot) => window.__G.salvage.state.opened.includes(spot), next.spot, { timeout: 5000 })
      .catch(() => {});
    await page.keyboard.up("e");
  }

  // 5. cut the relays and go to the boat
  const sent = await page.evaluate(() => {
    const G = window.__G;
    for (let i = 0; i < 3; i++) G.game.debugCut();
    const s = G.salvage.state;
    return { runId: s.runId, opened: s.opened, wrecks: s.wrecks };
  });
  await page.waitForTimeout(300);
  await page.evaluate(() => (window.__skew += 120_000)); // past the minimum run time, instead of waiting it out
  const boat = await page.evaluate(() => window.__G.level.extraction.pos);
  await stand(page, boat.x, boat.z, boat.x + 1, boat.z);
  await page.waitForFunction(() => window.__G.game.state === "complete", null, { timeout: 8000 }).catch(() => {});

  // 6. extraction calls extract with the run's bookkeeping
  const ex = await page.evaluate(() => window.__G.economy.chain.calls.filter((c) => c.method === "extract"));
  check(
    ex.length === 1 && JSON.stringify(ex[0].args) === JSON.stringify([sent.runId, sent.opened, sent.wrecks]),
    "extract gets (runId, opened, wrecks)",
    JSON.stringify(ex.map((c) => c.args)),
  );

  // 7. the debrief shows the haul
  await page
    .waitForFunction(() => document.querySelector('.menu[data-screen="complete"]'), null, { timeout: 8000 })
    .catch(() => {});
  await page
    .waitForFunction(() => !/settling/.test(document.querySelector(".sv-sec")?.textContent || "settling"), null, {
      timeout: 8000,
    })
    .catch(() => {});
  await page.waitForTimeout(600);
  const debrief = await page.evaluate(() =>
    [...document.querySelectorAll(".sv-sec .sv-row")].map((r) => r.textContent),
  );
  check(
    debrief.length === 3 && /Haul/.test(debrief[0]) && /×\d/.test(debrief[0]) && /scrip|unknown/.test(debrief[1]),
    "the debrief shows the haul, its value and the ledger",
    JSON.stringify(debrief),
  );
  await shot(page, "4-debrief");

  // a second run, and a death with cargo: die gets the bookkeeping and the dead card names what was lost
  await page.evaluate(() => (window.__skew += 60_000)); // past the gap between runs
  await page.evaluate(() => window.__G.game.start({ skipIntro: true }));
  await page.evaluate(() => (window.__G.player.invulnerable = true));
  await page.waitForFunction(
    () =>
      window.__G.salvage.state.status === "live" &&
      window.__G.economy.chain.calls.filter((c) => c.method === "startRun").length === 2,
    null,
    { timeout: 10000 },
  );
  const s2 = await page.evaluate(() => window.__G.salvage.state.targets.find((t) => t.kind === "seal"));
  await stand(page, s2.at.x + s2.out.x * 1.2, s2.at.z + s2.out.z * 1.2, s2.at.x, s2.at.z, -0.12);
  await page.waitForTimeout(200);
  await page.keyboard.down("e");
  await page
    .waitForFunction((spot) => window.__G.salvage.state.opened.includes(spot), s2.spot, { timeout: 5000 })
    .catch(() => {});
  await page.keyboard.up("e");
  const fell = await page.evaluate(() => {
    const G = window.__G;
    const st = G.salvage.state;
    const sent = { runId: st.runId, opened: st.opened, wrecks: st.wrecks };
    G.player.invulnerable = false;
    G.player.damage(999, null);
    return sent;
  });
  const die = await page.evaluate(() =>
    window.__G.economy.chain.calls.filter((c) => c.method === "die").map((c) => c.args),
  );
  check(
    die.length === 1 &&
      JSON.stringify(die[0].slice(0, 3)) === JSON.stringify([fell.runId, fell.opened, fell.wrecks]) &&
      Number.isInteger(die[0][3]),
    "death sends die(runId, opened, wrecks, spot)",
    JSON.stringify(die),
  );
  await page
    .waitForFunction(() => document.querySelector('.menu[data-screen="dead"]'), null, { timeout: 8000 })
    .catch(() => {});
  await page.waitForTimeout(800);
  const lostRow = await page.evaluate(() => document.querySelector('[data-s="dead"] .sv-row')?.textContent || null);
  check(
    !!lostRow && /Cargo lost.*\u00d7\d \u2014 left as a wreck/.test(lostRow),
    "the dead card names the cargo lost",
    lostRow || "no row",
  );
  await shot(page, "5-dead-card");

  // 8. frame rate and console
  check(Math.min(...fps) >= 50, "fps stays near 60", fps.map((f) => f.toFixed(1)).join(", "));
  check(errors.length === 0, "no console errors", errors.slice(0, 3).join(" | "));
  await page.close();

  // ---- the baseline: ?noeconomy attaches nothing ----
  const b = await open("autostart=1&noaudio=1&noeconomy=1");
  await b.page.waitForFunction(() => window.__G.game.state === "playing", null, { timeout: 20000 });
  await b.page.waitForTimeout(1500);
  const base0 = await b.page.evaluate(() => {
    const G = window.__G;
    return {
      salvage: !!G.salvage,
      economy: !!G.economy,
      ext: JSON.stringify(G.ext),
      readout: !!document.querySelector(".sv-cargo"),
      maxHealth: G.player.maxHealth,
      mag: G.weapon.magSize,
      fps: window.__stats().fps,
    };
  });
  check(
    !base0.salvage &&
      !base0.economy &&
      base0.ext === '{"speedScale":1,"gear":{}}' &&
      !base0.readout &&
      base0.maxHealth === 100 &&
      base0.mag === 30,
    "?noeconomy plays the baseline",
    JSON.stringify(base0),
  );
  // The baseline's numbers: walk 3.8 m/s, a relay in 2.4 s, the relay prompt as before.
  await b.page.evaluate(() => (window.__G.player.invulnerable = true));
  const relay = await b.page.evaluate(() => window.__G.level.objectives[0].pos);
  await stand(b.page, relay.x - 6, relay.z + 1.2, relay.x + 6, relay.z + 1.2);
  await b.page.keyboard.down("w");
  await b.page.waitForTimeout(700);
  const walk = await b.page.evaluate(() => window.__G.player.speed);
  await b.page.keyboard.up("w");
  await stand(b.page, relay.x, relay.z + 1.2, relay.x, relay.z, -0.1);
  await b.page.waitForTimeout(250);
  const relayPrompt = await b.page.evaluate(
    () => document.querySelector(".h-prompt.on .h-plabel")?.textContent || null,
  );
  const r0 = Date.now();
  await b.page.keyboard.down("e");
  await b.page.waitForFunction(() => window.__G.game.run.cut >= 1, null, { timeout: 6000 }).catch(() => {});
  const relayMs = Date.now() - r0;
  await b.page.keyboard.up("e");
  check(
    Math.abs(walk - 3.8) < 0.05 && relayMs > 2300 && relayMs < 2900 && relayPrompt === "Hold E — Cut relay A",
    "baseline: walk speed, relay cut time and prompt unchanged",
    `${walk.toFixed(2)} m/s, relay ${relayMs} ms, "${relayPrompt}"`,
  );
  check(b.errors.length === 0, "baseline: no console errors", b.errors.slice(0, 3).join(" | "));
  await b.page.close();
} finally {
  await browser.close();
}
console.log(failed ? `${failed} check(s) failed` : "all checks passed");
process.exit(failed ? 1 : 0);
