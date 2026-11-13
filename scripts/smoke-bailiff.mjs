// Headless smoke test of the Bailiff, the hunter (src/economy/bailiff), on the offline mock.
//
//   npm run dev -- --port 5303
//   node scripts/smoke-bailiff.mjs [http://127.0.0.1:5303] [--shots DIR]
//
// ?bailiff=1 stands one up in the shed at the first uplink cut of any run. Pointer lock doesn't work headless, so the
// run is driven through window.__G: a dock pass is claimed on the mock, a relay is cut with game.debugCut(), the
// player is moved and faced by script, and shots go through the game's own combat.playerShot (the path the rifle
// uses), which asks the Bailiff through the shared shot hook.
// It checks: nothing before the first cut; it rises in the shed, out of sight, and walks after about 2 s; over 12 s
// it closes on the player and every sampled position is walkable and outside every solid box, with no jumps; the
// HUD chip; body and lens shots fill the meter (the lens double), it staggers for 9 s and stands again on time, and
// anyStanding() follows; a breaker charge (emp:detonated) drops it at once; standing still lets it grab (55 damage,
// a 4 m shove); a new run clears it; fps and console errors throughout. Exits non-zero if a check failed.
import { mkdirSync } from "node:fs";
import { launch } from "./browser.mjs";

const base = process.argv.find((a) => a.startsWith("http")) || "http://127.0.0.1:5303";
const shotsAt = process.argv.indexOf("--shots");
const shots = shotsAt > 0 ? process.argv[shotsAt + 1] : null;
if (shots) mkdirSync(shots, { recursive: true });

let failed = 0;
const check = (ok, what, detail = "") => {
  console.log(`${ok ? "ok  " : "FAIL"} ${what}${detail ? " — " + detail : ""}`);
  if (!ok) failed++;
};

const browser = await launch();
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  const errors = [];
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  page.on("pageerror", (e) => errors.push(String(e)));
  const shot = async (name) => shots && (await page.screenshot({ path: `${shots}/${name}.png` }));
  await page.addInitScript(() => {
    localStorage.clear(); // a fresh mock economy, wallet and story memory every time
    localStorage.setItem("saltline.story.v1", JSON.stringify({ v: 1, briefed: true, heard: ["act2", "reveal"], peak: 0 }));
  });
  await page.goto(`${base}/play/?mock=1&bailiff=1&noaudio=1`, { waitUntil: "load" });
  await page.waitForFunction(() => window.__ready === true, null, { timeout: 90000 });
  await page.waitForFunction(() => !!window.__G.economy && !!window.__G.bailiff, null, { timeout: 15000 });
  await page.evaluate(async () => {
    const G = window.__G;
    window.__ev = [];
    window.__radio = [];
    for (const name of ["bailiff:spawned", "bailiff:staggered", "bailiff:recovered", "bailiff:grab", "bailiff:near"])
      G.events.on(name, (e) => window.__ev.push({ name, t: performance.now(), e: JSON.parse(JSON.stringify(e)), hp: G.player.health, at: { x: G.player.pos.x, z: G.player.pos.z } }));
    G.events.on("radio:line", (e) => window.__radio.push({ text: e.text, who: document.querySelector(".comms-who")?.textContent, bf: !!document.querySelector(".comms.bf-voice") }));
    const r = await G.economy.wallet.claim("WRIT");
    if (!r.ok) throw new Error("claim failed: " + r.error);
    G.game.start({ skipIntro: true });
    G.player.invulnerable = true; // drones would end a scripted run
    // The drones are not this test's business: keep the yard empty.
    setInterval(() => G.game.state === "playing" && G.enemies.clear(), 200);
    /** True if (x, z) is on the nav grid and outside every solid box at chest height. */
    window.__clear = (x, z) => {
      if (!G.physics.nav.isWalkable(x, z)) return false;
      for (const b of G.physics.boxes) {
        if (b.playerOnly || b.bulletOnly || b.max.y < 0.5 || b.min.y > 1.6) continue;
        if (x > b.min.x && x < b.max.x && z > b.min.z && z < b.max.z) return false;
      }
      return true;
    };
    window.__face = (tx, ty, tz) => {
      const p = G.player;
      p.yaw = Math.atan2(-(tx - p.pos.x), -(tz - p.pos.z));
      p.pitch = Math.atan2(ty - (p.pos.y + 1.6), Math.hypot(tx - p.pos.x, tz - p.pos.z));
    };
    /** Faces it; `off` (rad) turns a little past it, so it stands left of the rifle in a screenshot. */
    window.__faceIt = (y = 1.7, off = 0) => {
      const u = G.bailiff.units[0];
      if (!u) return;
      window.__face(u.handle.pos.x, u.handle.pos.y + y, u.handle.pos.z);
      G.player.yaw -= off;
    };
    /** One rifle round from the eye at a point, through the game's own path. */
    window.__shoot = (at) => {
      const p = G.player;
      const o = p.eye.clone();
      const d = new G.THREE.Vector3(at.x - o.x, at.y - o.y, at.z - o.z).normalize();
      const hit = G.combat.playerShot(o, d, { damage: 26, range: 200 });
      return hit ? { part: hit.part ?? null, type: hit.enemy?.type ?? null } : null;
    };
  });
  await page.waitForFunction(() => window.__G.game.state === "playing", null, { timeout: 15000 });
  const stand = (x, z) => page.evaluate(([x, z]) => (window.__G.player.pos.set(x, 0, z), window.__G.player.vel.set(0, 0, 0)), [x, z]);
  const state = () =>
    page.evaluate(() => {
      const G = window.__G;
      const b = G.bailiff;
      const u = b.units[0];
      if (!u) return null;
      const p = G.player.pos;
      return {
        state: u.handle.state,
        standing: u.handle.standing,
        any: b.anyStanding(),
        x: u.handle.pos.x,
        z: u.handle.pos.z,
        dist: Math.hypot(u.handle.pos.x - p.x, u.handle.pos.z - p.z),
        near: b.nearest()?.dist ?? null,
        clear: window.__clear(u.handle.pos.x, u.handle.pos.z),
        sees: u.sees,
        meter: u.meter,
        threshold: u.threshold,
        down: u.down,
        fps: window.__stats().fps,
      };
    });
  const events = (name) => page.evaluate((n) => window.__ev.filter((e) => e.name === n), name);
  const chip = () =>
    page.evaluate(() => {
      const c = document.querySelector(".bf-chip");
      return c ? { on: c.classList.contains("on"), text: c.textContent.replace(/\s+/g, " ").trim(), name: c.querySelector(".bf-name")?.textContent, dist: c.querySelector(".bf-dist")?.textContent, arrow: c.querySelector(".bf-arrow")?.style.transform || "" } : null;
    });
  const fpsSamples = [];
  /** Face it and let the rifle's sway from the turn die down, so a screenshot shows the Bailiff and not the gun. */
  const settle = async (y, off = 0) => {
    for (let i = 0; i < 7; i++) {
      await page.evaluate(([y, off]) => window.__faceIt(y, off), [y, off]);
      await page.waitForTimeout(110);
    }
  };

  // ---- the spawn points are good ground ----
  const spots = await page.evaluate(() => {
    const S = window.__G.bailiff.spots;
    const ring = (p) => {
      for (let a = 0; a < 8; a++) if (!window.__clear(p.x + Math.cos((a / 8) * 6.2832), p.z + Math.sin((a / 8) * 6.2832))) return false;
      return window.__clear(p.x, p.z);
    };
    return { shed: ring(S.shed), yard: ring(S.yard), alt: S.shedAlt.map(ring), S };
  });
  check(spots.shed && spots.yard && spots.alt.every(Boolean), "SPAWN.shed, SPAWN.yard and the shed's alternates are walkable with a metre clear all round", JSON.stringify(spots));

  // ---- 1. nothing before the first cut; then it rises in the shed, out of sight ----
  check(await page.evaluate(() => window.__G.bailiff.list.length === 0 && !window.__G.bailiff.anyStanding() && window.__G.bailiff.nearest() === null), "no Bailiff before the first uplink is cut");
  check((await chip())?.on === false, "the HUD chip is hidden with none about");
  await stand(-30, 6);
  await page.evaluate(() => (window.__face(0, 1.6, 6), window.__G.game.debugCut()));
  await page.waitForFunction(() => window.__ev.some((e) => e.name === "bailiff:spawned"), null, { timeout: 3000 }).catch(() => {});
  const born = await state();
  const spawned = await events("bailiff:spawned");
  check(!!born && spawned.length === 1, "the first cut releases one Bailiff (bailiff:spawned)", JSON.stringify(spawned[0]?.e));
  check(!!born && born.x > -24 && born.x < 16 && born.z > -30 && born.z < -10 && born.clear, "it is in the shed, on walkable ground", born && `${born.x.toFixed(1)}, ${born.z.toFixed(1)}`);
  check(!!born && born.state === "rising" && born.standing && born.any && born.dist > 30, "it starts in its crouch, rising, out of the player's sight", born && `${born.state}, ${born.dist.toFixed(0)} m away`);
  // Go and watch it stand (the rise is about 2 s).
  await stand(born.x + 4.2, born.z + 1.2);
  await page.evaluate(() => window.__faceIt(1.0));
  await page.waitForTimeout(1250); // the rifle settles after the turn; the lens is flickering on
  await shot("1-rising");
  await page.waitForFunction(() => window.__G.bailiff.units[0].handle.state !== "rising", null, { timeout: 4000 }).catch(() => {});
  const rose = (await page.evaluate(() => performance.now())) - spawned[0].t;
  check(rose > 1700 && rose < 2900, "it stands up in about 2 s, then walks", `${(rose / 1000).toFixed(2)} s`);

  // ---- 2. it hunts: over 12 s it closes on the player, always on walkable ground, never jumping ----
  await stand(-8, 7); // the yard, south of the lane between the container rows it must come down
  await page.evaluate(() => window.__face(-8, 1.6, -10));
  await page.waitForTimeout(600); // one plan
  const walk = [];
  for (let i = 0; i <= 24; i++) {
    const s = await state();
    walk.push(s);
    fpsSamples.push(s.fps);
    if (i < 24) await page.waitForTimeout(500);
  }
  const hops = walk.slice(1).map((s, i) => Math.hypot(s.x - walk[i].x, s.z - walk[i].z));
  check(walk[0].dist - walk[24].dist > 10, "over 12 s its distance to the player shrinks", `${walk[0].dist.toFixed(1)} m → ${walk[24].dist.toFixed(1)} m`);
  check(walk.every((s) => s.clear), "every sampled position is walkable and outside every container", `${walk.filter((s) => !s.clear).length} bad of ${walk.length}`);
  check(Math.max(...hops) < 2.6 * 0.5 * 1.35, "it never jumps: no half-second step longer than its pace allows", `longest ${Math.max(...hops).toFixed(2)} m`);
  const pace = hops.reduce((a, b) => a + b, 0) / 12;
  check(pace > 1.7 && pace <= 2.65, "it walks at about 2.6 m/s, pivots included", `${pace.toFixed(2)} m/s over the ground`);
  // Walking at the camera down the lane, in the rain, lens red.
  await page.waitForFunction(() => { const u = window.__G.bailiff.units[0]; const p = window.__G.player.pos; return u.sees && Math.hypot(u.handle.pos.x - p.x, u.handle.pos.z - p.z) < 10.5; }, null, { timeout: 15000, polling: 50 }).catch(() => {});
  await settle(1.5);
  await shot("2-walking-rain");
  const seen = await state();
  check(seen.sees && seen.state === "walking", "with a clear line its lens has the player (red)", JSON.stringify({ sees: seen.sees, state: seen.state, dist: +seen.dist.toFixed(1) }));
  const c1 = await chip();
  check(!!c1 && c1.on && c1.name === "BAILIFF" && /^\d+ m$/.test(c1.dist) && Math.abs(parseInt(c1.dist) - seen.dist) <= 2 && /rotate/.test(c1.arrow), "the HUD chip reads BAILIFF, its distance and a direction", JSON.stringify(c1));
  const nears = await events("bailiff:near");
  check(nears.length >= 6 && nears.every((n) => n.e.dist <= 30 && n.e.standing === true), "bailiff:near comes about twice a second inside 30 m", `${nears.length} so far`);

  // ---- 3. shots fill the meter (the lens double); full, it drops for 9 s, then stands again ----
  const before = await state();
  const body = await page.evaluate(() => { const u = window.__G.bailiff.units[0]; return window.__shoot({ x: u.handle.pos.x, y: u.handle.pos.y + 1.75, z: u.handle.pos.z }); });
  const afterBody = await state();
  check(body?.type === "bailiff" && body.part === "body" && Math.abs(afterBody.meter - before.meter - 26) < 0.01, "a body shot sparks off and adds its 26 to the meter", JSON.stringify({ body, meter: afterBody.meter }));
  const lens = await page.evaluate(() => { const u = window.__G.bailiff.units[0]; return window.__shoot(u.lens); });
  const afterLens = await state();
  check(lens?.part === "weak" && Math.abs(afterLens.meter - afterBody.meter - 52) < 0.01, "a lens shot counts double (52)", JSON.stringify({ lens, meter: afterLens.meter }));
  check(afterLens.threshold === 450, "the first stagger takes 450", String(afterLens.threshold));
  const t0 = await page.evaluate(() => {
    const G = window.__G;
    const u = G.bailiff.units[0];
    let n = 0;
    while (u.handle.state !== "staggered" && n++ < 40) window.__shoot({ x: u.handle.pos.x, y: u.handle.pos.y + 1.75, z: u.handle.pos.z });
    return { n, t: performance.now() };
  });
  const downEv = (await events("bailiff:staggered"))[0];
  const down = await state();
  check(t0.n === 15 && down.state === "staggered", "15 more body shots (450 in all) drop it to a knee", `${t0.n} shots, ${down.state}`);
  check(downEv?.e.seconds === 9 && downEv.e.by === "damage", "bailiff:staggered says 9 s, by damage", JSON.stringify(downEv?.e));
  check(down.standing === false && down.any === false, "anyStanding() is false while it is down");
  await page.waitForTimeout(700);
  await page.evaluate(() => { const u = window.__G.bailiff.units[0]; const p = window.__G.player.pos; const d = Math.hypot(p.x - u.handle.pos.x, p.z - u.handle.pos.z) || 1; p.set(u.handle.pos.x + ((p.x - u.handle.pos.x) / d) * 3.6, 0, u.handle.pos.z + ((p.z - u.handle.pos.z) / d) * 3.6); });
  await page.waitForTimeout(900); // the rifle's swing from the move dies down
  await settle(1.1, 0.3);
  await shot("4-staggered");
  const c2 = await chip();
  check(!!c2 && c2.on && /Down \ds/i.test(c2.text), "the chip counts down while it is on its knee", c2?.text);
  await page.waitForFunction(() => window.__ev.some((e) => e.name === "bailiff:recovered"), null, { timeout: 12000 }).catch(() => {});
  const upEv = (await events("bailiff:recovered"))[0];
  const up = await state();
  const downFor = upEv ? (upEv.t - downEv.t) / 1000 : -1;
  check(downFor > 8.7 && downFor < 9.5, "it stands again on time (bailiff:recovered after 9 s)", `${downFor.toFixed(2)} s`);
  check(up.any === true && up.standing === true && up.threshold === 650 && up.meter === 0, "anyStanding() is true again, the meter is empty and the next stagger takes 650", JSON.stringify({ any: up.any, threshold: up.threshold, meter: up.meter }));

  // ---- 4. a breaker charge drops it at once, inside its radius only ----
  await page.waitForFunction(() => window.__G.bailiff.units[0].handle.state === "walking", null, { timeout: 4000 }).catch(() => {});
  await page.evaluate(() => { const G = window.__G; const u = G.bailiff.units[0]; G.events.emit("emp:detonated", { pos: { x: u.handle.pos.x + 9, y: 0, z: u.handle.pos.z }, radius: 3.5 }); });
  check((await state()).state !== "staggered", "a charge that bursts 9 m away leaves it standing");
  await page.evaluate(() => { const G = window.__G; const u = G.bailiff.units[0]; G.events.emit("emp:detonated", { pos: { x: u.handle.pos.x + 2, y: 0, z: u.handle.pos.z }, radius: 3.5 }); });
  const emp = (await events("bailiff:staggered"))[1];
  check((await state()).state === "staggered" && emp?.e.by === "charge" && emp.e.seconds === 8, "a charge that bursts on it drops it at once, for 8 s this time", JSON.stringify(emp?.e));
  // The script can stand it down for as long as it likes, and remove nothing.
  await page.waitForFunction(() => window.__G.bailiff.units[0].handle.state === "walking", null, { timeout: 12000 }).catch(() => {});

  // ---- 5. standing still lets it grab: 55 damage and a 4 m shove ----
  await stand(-8, 5);
  await page.evaluate(() => { const G = window.__G; G.player.invulnerable = false; G.player.health = G.player.maxHealth; window.__faceIt(1.6); });
  const hp0 = await page.evaluate(() => window.__G.player.health);
  await page.evaluate(() => (window.__aim = setInterval(() => window.__faceIt(1.9), 50)));
  await page.waitForFunction(() => window.__G.bailiff.units[0].handle.state === "windup", null, { timeout: 25000, polling: 16 }).catch(() => {});
  await page.waitForTimeout(330);
  await shot("3-windup");
  await page.evaluate(() => clearInterval(window.__aim));
  await page.waitForFunction(() => window.__ev.some((e) => e.name === "bailiff:grab"), null, { timeout: 4000, polling: 16 }).catch(() => {});
  const grab = (await events("bailiff:grab"))[0];
  await page.waitForTimeout(450);
  const after = await page.evaluate(() => ({ x: window.__G.player.pos.x, z: window.__G.player.pos.z, state: window.__G.bailiff.units[0].handle.state, alive: window.__G.player.alive }));
  await page.evaluate(() => (window.__G.player.invulnerable = true));
  check(!!grab && grab.e.damage === 55 && hp0 - grab.hp === 55, "its grab takes 55 health", grab && `${hp0} → ${grab.hp}`);
  const thrown = grab ? Math.hypot(after.x - grab.at.x, after.z - grab.at.z) : 0;
  check(thrown > 3.6 && thrown < 4.4, "and shoves the player 4 m", `${thrown.toFixed(2)} m`);
  check(after.state === "recovering" && after.alive, "then it recovers before it can grab again", after.state);
  await shot("5-hud-chip");
  await page.waitForFunction(() => window.__G.bailiff.units[0].handle.state === "walking", null, { timeout: 4000 }).catch(() => {});
  const cool = grab ? ((await page.evaluate(() => performance.now())) - grab.t) / 1000 : -1;
  check(cool > 2.3 && cool < 3.0, "the recovery lasts 2.5 s", `${cool.toFixed(2)} s`);

  // ---- its lines, on the Harbormaster's channel under its own label ----
  const radio = await page.evaluate(() => window.__radio);
  const mine = radio.filter((r) => r.bf);
  check(mine.some((r) => /^Breacher WRIT\. You are in arrears\. An officer has been dispatched to collect\.$/.test(r.text)), "its release line names the callsign", JSON.stringify(mine.map((r) => r.text)));
  check(mine.length > 0 && mine.every((r) => r.who === "Bailiff"), "its lines are labelled BAILIFF", JSON.stringify(mine.map((r) => r.who)));
  check(radio.filter((r) => !r.bf).every((r) => r.who !== "Bailiff"), "and nobody else's are");
  const once = ["Please remain where you are.", "Service has been interrupted.", "Service of the writ will now resume."];
  check(once.every((t) => radio.filter((r) => r.text === t).length <= 1), "each line plays at most once a run", JSON.stringify(radio.map((r) => r.text).filter((t) => once.includes(t))));

  // ---- 6. a new run clears it ----
  fpsSamples.push((await state()).fps);
  await page.evaluate(() => window.__G.game.start({ skipIntro: true }));
  await page.waitForTimeout(400);
  check(await page.evaluate(() => window.__G.bailiff.list.length === 0 && !window.__G.bailiff.anyStanding() && !window.__G.scene.getObjectByName("bailiff")), "a new run removes it, body and all");
  check((await chip())?.on === false, "and hides the chip");

  const fps = fpsSamples.reduce((a, b) => a + b, 0) / fpsSamples.length;
  check(fps > 50, "fps near 60 with it walking", `${fps.toFixed(1)} average, ${Math.min(...fpsSamples).toFixed(0)} lowest`);
  check(errors.length === 0, "no console errors", errors.slice(0, 5).join(" | "));
} finally {
  await browser.close();
}
console.log(failed ? `\n${failed} check(s) FAILED` : "\nall checks passed");
process.exit(failed ? 1 : 0);
