// Headless smoke test of the Assessor, Chapter 3's boss (src/economy/boss), on the offline mock.
//
//   npm run dev -- --port 5298
//   node scripts/smoke-boss.mjs [http://127.0.0.1:5298] [--shots DIR]
//
// ?mock=1&act=3 puts the town in Chapter 3 at strength 62, so the Assessor carries 3 + floor(62 / 20) = 6 cores.
// Pointer lock doesn't work headless, so the run is driven through window.__G: a dock pass is claimed on the mock,
// the relays are cut with game.debugCut(), the player is moved and faced by script, and shots go through the game's
// own combat.playerShot (the path the rifle uses), which asks the boss's G.ext.raycast hook.
// 1. ?act=3: three relays cut, the Assessor arrives with its HUD bar; the boat is blocked; its lamp builds an
//    assessment on a player in the open; every core is shot out (hitmarkers, the calls at each third, its lines);
//    it slumps, the boat comes in and extraction works. fps and console errors are checked throughout.
// 2. ?act=3 again: a player who dies to it hears the Harbormaster log the remains, and a retry starts clean.
// 3. ?act=1: no boss; the boat takes the player as before.
// Exits non-zero if a check failed.
import { mkdirSync } from "node:fs";
import { launch } from "./browser.mjs";

const base = process.argv.find((a) => a.startsWith("http")) || "http://127.0.0.1:5298";
const shotsAt = process.argv.indexOf("--shots");
const shots = shotsAt > 0 ? process.argv[shotsAt + 1] : null;
if (shots) mkdirSync(shots, { recursive: true });

const BAR = "THE ASSESSOR · FINAL NOTICE";
const LINES = {
  death: /^Thank you for your cooperation\. Your remains have been logged as cargo\.$/,
  arrival: /^Breacher BOSS\. We have assessed your conduct\. The Assessor will now deliver our findings in person\.$/,
  firstCore: /^That component is town property, purchased in good faith from our Quartermaster\.$/,
  lastCore: /^This will be reflected in your file\.$/,
  defeat: /^Claim denied\. Claim denied\. Cla$/,
};

let failed = 0;
const check = (ok, what, detail = "") => {
  console.log(`${ok ? "ok  " : "FAIL"} ${what}${detail ? " — " + detail : ""}`);
  if (!ok) failed++;
};
const shot = async (page, name) => shots && (await page.screenshot({ path: `${shots}/${name}.png` }));

const browser = await launch();

async function open(query) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  const errors = [];
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.addInitScript(() => {
    localStorage.clear(); // a fresh mock economy, wallet and story memory every time
    localStorage.setItem("saltline.story.v1", JSON.stringify({ v: 1, briefed: true, heard: ["act2", "reveal"], peak: 0 }));
  });
  await page.goto(`${base}/?${query}`, { waitUntil: "load" });
  await page.waitForFunction(() => window.__ready === true, null, { timeout: 90000 });
  await page.waitForFunction(() => !!window.__G.economy && !!window.__G.story && "boss" in window.__G, null, { timeout: 15000 });
  await page.evaluate(async () => {
    const G = window.__G;
    window.__radio = [];
    window.__hits = [];
    G.events.on("radio:line", (e) => window.__radio.push(e.text));
    G.events.on("player:hitEnemy", (e) => window.__hits.push({ part: e.part, killed: e.killed, type: e.enemy && e.enemy.type }));
    const r = await G.economy.wallet.claim("BOSS");
    if (!r.ok) throw new Error("claim failed: " + r.error);
    G.game.start({ skipIntro: true });
  });
  await page.waitForFunction(() => window.__G.game.state === "playing" && !!window.__G.boss && !!window.__G.boss.read, null, {
    timeout: 15000,
  });
  return { page, errors };
}

/** Stand at (x, z) looking at (tx, ty, tz). The game's forward is (-sin yaw, 0, -cos yaw). */
const stand = (page, x, z, tx, ty, tz) =>
  page.evaluate(
    ([x, z, tx, ty, tz]) => {
      const p = window.__G.player;
      p.pos.set(x, 0, z);
      p.vel.set(0, 0, 0);
      p.yaw = Math.atan2(-(tx - x), -(tz - z));
      p.pitch = Math.atan2(ty - 1.6, Math.hypot(tx - x, tz - z));
    },
    [x, z, tx, ty, tz],
  );
const fps = (page) => page.evaluate(() => window.__stats().fps);
const heardCount = (page, re) => page.evaluate((src) => window.__radio.filter((t) => new RegExp(src).test(t)).length, re.source);

try {
  // ---- 1. Chapter 3: the Assessor ----
  const { page, errors } = await open("mock=1&act=3&noaudio=1");
  const samples = [];
  const sample = async () => samples.push(await fps(page));
  await page.evaluate(() => (window.__G.player.invulnerable = true)); // drones would end a scripted run
  const read = await page.evaluate(() => ({ status: window.__G.boss.read.status, act: window.__G.boss.read.view?.act, strength: window.__G.boss.read.view?.harbormaster?.strength }));
  check(read.status === "ok" && read.act === 3, "the run reads Chapter 3 from the town", JSON.stringify(read));
  check(await page.evaluate(() => window.__G.boss.fight === null && !document.querySelector(".as-bar.on")), "no Assessor before the third relay");

  // Watch the north containers from the quay as the third relay goes.
  await stand(page, 24.5, -4, 23, 6.5, -27);
  await page.evaluate(() => {
    const G = window.__G;
    G.game.debugCut();
    G.game.debugCut();
  });
  check(await page.evaluate(() => window.__G.boss.fight === null), "no Assessor after two relays");
  await page.evaluate(() => {
    window.__G.game.debugCut();
    window.__G.enemies.clear();
  });
  await page.waitForFunction(() => !!window.__G.boss.fight, null, { timeout: 3000 }).catch(() => {});
  const arrived = await page.evaluate(() => {
    const f = window.__G.boss.fight;
    const bar = document.querySelector(".as-bar");
    return {
      fight: !!f,
      phase: f?.phase,
      cores: f?.cores,
      bar: !!bar && bar.classList.contains("on") && bar.querySelector(".as-name")?.textContent,
      pips: bar ? bar.querySelectorAll(".as-cores i").length : 0,
      reserve: window.__G.weapon.reserve,
    };
  });
  check(arrived.fight && arrived.phase === "arriving", "the third relay brings the Assessor", JSON.stringify(arrived));
  check(arrived.bar === BAR && arrived.pips === 6, "its HUD bar reads THE ASSESSOR · FINAL NOTICE with a pip per core", `${arrived.bar} · ${arrived.pips} pips`);
  check(arrived.cores === 6, "strength 62 gives 3 + floor(62 / 20) = 6 cores", String(arrived.cores));
  check(arrived.reserve >= 240, "the reserve is topped up for the fight", String(arrived.reserve));
  await page.waitForTimeout(3000);
  await page.evaluate(() => window.__G.enemies.clear());
  await shot(page, "1-arrival");
  await sample();

  // The boat is blocked while it stands.
  const boat = await page.evaluate(() => window.__G.level.extraction.pos);
  await stand(page, boat.x, boat.z, boat.x + 1, 1, boat.z);
  await page.waitForTimeout(1200);
  const blocked = await page.evaluate(() => ({
    state: window.__G.game.state,
    blocked: window.__G.ext.extractBlocked(),
    // The boat stands off the quay while it's blocked.
    off: +Math.hypot(window.__G.backdrop.boat.position.x - window.__G.backdrop.boatBase.x, window.__G.backdrop.boat.position.z - window.__G.backdrop.boatBase.z).toFixed(1),
  }));
  check(blocked.state === "playing" && blocked.blocked === true && blocked.off > 3, "the boat stands off and won't take the player while it stands", JSON.stringify(blocked));

  // It plants itself between the player and the boat.
  await page.waitForFunction(() => window.__G.boss.fight.phase === "fighting", null, { timeout: 25000 }).catch(() => {});
  const planted = await page.evaluate(() => {
    const f = window.__G.boss.fight;
    const c = f.core(0);
    return { phase: f.phase, x: +c.x.toFixed(1), z: +c.z.toFixed(1) };
  });
  check(planted.phase === "fighting" && planted.z > 6 && planted.z < 19, "it plants itself on the quay between the player and the boat", JSON.stringify(planted));
  await sample();

  // The lamp: standing in the open in front of it builds an assessment, and a full one fires a volley.
  await page.evaluate(() => window.__G.enemies.clear());
  await stand(page, 12, 8.5, 23.5, 7.5, 14.5);
  const lamp = await page
    .waitForFunction(() => window.__G.boss.fight.assess > 0.35, null, { timeout: 14000, polling: 50 })
    .then(() => true, () => false);
  await shot(page, "2-lamp-sweep");
  check(lamp, "its lamp builds an assessment on a player in the open", (await page.evaluate(() => window.__G.boss.fight.assess)).toFixed(2));
  const volley = await page
    .waitForFunction(() => ["lock", "volley", "cool"].includes(window.__G.boss.fight.beam), null, { timeout: 14000, polling: 50 })
    .then(() => true, () => false);
  check(volley, "a full assessment locks on and fires a volley", await page.evaluate(() => window.__G.boss.fight.beam));
  await sample();

  // Shoot out every core through the game's own combat.playerShot.
  const fire = (i) =>
    page.evaluate((i) => {
      const G = window.__G;
      const f = G.boss.fight;
      const c = f.core(i);
      const p = G.player;
      const eye = p.eye.clone();
      const dir = new G.THREE.Vector3(c.x - eye.x, c.y - eye.y, c.z - eye.z).normalize();
      p.yaw = Math.atan2(-dir.x, -dir.z);
      p.pitch = Math.asin(dir.y);
      const hit = G.combat.playerShot(eye, dir, { damage: 26, range: 300 });
      return { hit: hit && hit.part, hp: f.hp[i], phase: f.phase };
    }, i);
  // Its arrival line goes out once Control's lines for the cuts are done (they come back to back here).
  const arrivalHeard = await page
    .waitForFunction((src) => window.__radio.some((t) => new RegExp(src).test(t)), LINES.arrival.source, { timeout: 45000 })
    .then(() => true, () => false);
  check(arrivalHeard, "its arrival line plays on the Harbormaster's channel", "Breacher BOSS. We have assessed your conduct…");
  await stand(page, 12, 8.5, 23.5, 8.5, 14.5);
  const cores = await page.evaluate(() => window.__G.boss.fight.cores);
  /** A player takes a few seconds a core: give each of its beats the time to go out, as a fight would. */
  const beat = (re, ms) =>
    page.waitForFunction((src) => window.__radio.some((t) => new RegExp(src).test(t)), re.source, { timeout: ms }).then(() => true, () => false);
  let weakShots = 0;
  let missed = 0;
  for (let i = 0; i < cores; i++) {
    for (let n = 0; n < 40; n++) {
      await page.evaluate(() => window.__G.enemies.clear()); // its Inspection Units would take the rounds
      const r = await fire(i);
      if (r.hit === "weak") weakShots++;
      else missed++;
      if (i === 0 && n === 1) {
        await page.waitForTimeout(30);
        await shot(page, "3-core-hit");
      }
      if (r.hp <= 0) break;
      await page.waitForTimeout(r.hit === "weak" ? 70 : 140);
      await page.evaluate(() => window.__G.enemies.clear());
    }
    if (i === 1) await sample();
    if (i === 0) await beat(LINES.firstCore, 20000);
    if (i === cores - 2) await beat(LINES.lastCore, 20000);
  }
  const afterShots = await page.evaluate(() => ({
    hp: window.__G.boss.fight.hp,
    phase: window.__G.boss.fight.phase,
    calls: window.__G.boss.fight.calls,
    hits: window.__hits.filter((h) => h.type === "relay core").length,
    weak: window.__hits.filter((h) => h.part === "weak").length,
    kills: window.__hits.filter((h) => h.killed && h.type === "relay core").length,
  }));
  check(afterShots.hp.every((h) => h <= 0), "every core can be shot out", `${weakShots} core hits, ${missed} not on a core`);
  check(afterShots.weak >= cores * 7 && afterShots.kills === cores, "core hits land as weak points and each core's last hit as a kill", JSON.stringify(afterShots));
  check(afterShots.calls === 2, "it calls a pair of Inspection Units at each third", String(afterShots.calls));
  const body = await page.evaluate(() => {
    const G = window.__G;
    return G.boss.fight.phase;
  });
  check(body === "dying" || body === "dead", "the last core dark brings it down", body);

  await stand(page, 10.5, 7, 25, 5, 15);
  await page.waitForTimeout(1300);
  await shot(page, "4-slump");
  await page.waitForFunction(() => window.__G.boss.fight.phase === "dead", null, { timeout: 8000 }).catch(() => {});
  await page.waitForTimeout(2600);
  await shot(page, "5-wreck");
  await page.waitForFunction(() => !window.__G.ext.extractBlocked(), null, { timeout: 10000 }).catch(() => {});
  const berth = await page.evaluate(() => ({
    blocked: window.__G.ext.extractBlocked(),
    off: +Math.hypot(window.__G.backdrop.boat.position.x - window.__G.backdrop.boatBase.x, window.__G.backdrop.boat.position.z - window.__G.backdrop.boatBase.z).toFixed(2),
  }));
  check(!berth.blocked && berth.off < 0.5, "the boat comes back in once it's down", JSON.stringify(berth));

  // Its lines, once each, on the Harbormaster's channel.
  await page.waitForFunction((src) => window.__radio.some((t) => new RegExp(src).test(t)), LINES.defeat.source, { timeout: 30000 }).catch(() => {});
  for (const [id, re] of Object.entries(LINES).filter(([id]) => id !== "death")) {
    const n = await heardCount(page, re);
    check(n === 1, `it says its ${id} line once`, String(n));
  }

  // Extraction works.
  await stand(page, boat.x, boat.z, boat.x + 1, 1, boat.z);
  const done = await page
    .waitForFunction(() => window.__G.game.state === "complete", null, { timeout: 8000 })
    .then(() => true, () => false);
  check(done, "the player extracts once it's down", await page.evaluate(() => window.__G.game.state));
  const lo = Math.min(...samples);
  check(lo >= 50, "fps stays near 60 through the fight", samples.map((f) => f.toFixed(0)).join(", "));
  check(errors.length === 0, "no console errors", errors.slice(0, 3).join(" | "));
  await page.close();

  // ---- 2. Chapter 3 again: the player dies to it ----
  {
    const { page, errors } = await open("mock=1&act=3&noaudio=1");
    await page.evaluate(() => {
      const G = window.__G;
      G.player.invulnerable = true;
      for (let i = 0; i < 3; i++) G.game.debugCut();
    });
    await page.waitForFunction(() => !!window.__G.boss.fight, null, { timeout: 5000 }).catch(() => {});
    await page.waitForTimeout(1500);
    await page.evaluate(() => {
      const G = window.__G;
      G.player.invulnerable = false;
      G.player.damage(500, { x: 23.5, y: 8, z: 14 });
    });
    const logged = await page
      .waitForFunction((src) => window.__radio.some((t) => new RegExp(src).test(t)), LINES.death.source, { timeout: 15000 })
      .then(() => true, () => false);
    check(logged, "a player who dies to it is logged as cargo", await page.evaluate(() => window.__G.game.state));
    check((await heardCount(page, LINES.death)) === 1, "once");
    // Retry: a fresh run clears it away, and the boat waits for the relays again.
    await page.evaluate(() => window.__G.game.start({ skipIntro: true }));
    await page.waitForFunction(() => window.__G.game.state === "playing", null, { timeout: 10000 });
    const fresh = await page.evaluate(() => ({ fight: !!window.__G.boss.fight, bar: !!document.querySelector(".as-bar.on"), blocked: window.__G.ext.extractBlocked() }));
    check(!fresh.fight && !fresh.bar && !fresh.blocked, "a retry starts without it", JSON.stringify(fresh));
    check(errors.length === 0, "no console errors", errors.slice(0, 3).join(" | "));
    await page.close();
  }

  // ---- 3. Chapter 1: no boss ----
  {
    const { page, errors } = await open("mock=1&act=1&noaudio=1");
    await page.evaluate(() => (window.__G.player.invulnerable = true));
    await page.evaluate(() => {
      const G = window.__G;
      for (let i = 0; i < 3; i++) G.game.debugCut();
    });
    await page.waitForTimeout(1500);
    const s = await page.evaluate(() => ({
      read: window.__G.boss.read?.status,
      act: window.__G.boss.read?.view?.act,
      fight: !!window.__G.boss.fight,
      bar: !!document.querySelector(".as-bar.on"),
      blocked: window.__G.ext.extractBlocked(),
    }));
    check(s.read === "ok" && s.act === 1 && !s.fight && !s.bar && !s.blocked, "a Chapter 1 run has no Assessor", JSON.stringify(s));
    await stand(page, boat.x, boat.z, boat.x + 1, 1, boat.z);
    const out = await page
      .waitForFunction(() => window.__G.game.state === "complete", null, { timeout: 8000 })
      .then(() => true, () => false);
    check(out, "and the boat takes the player as before");
    check(errors.length === 0, "no console errors", errors.slice(0, 3).join(" | "));
    await page.close();
  }
} catch (e) {
  console.error(e);
  failed++;
}

await browser.close();
console.log(failed ? `\n${failed} check(s) failed` : "\nall boss checks passed");
process.exit(failed ? 1 : 0);
