// Headless smoke test of the kit (src/economy/arsenal) on the offline mock: the breaker charge, the rifle butt, the
// supply lockers and the pickups, in the running game.
//
//   npm run dev -- --port 5304
//   node scripts/smoke-arsenal.mjs [http://127.0.0.1:5304] [--shots DIR]
//
// Pointer lock doesn't work headless, so the run is driven through window.__G: a dock pass is claimed on the mock,
// the player is moved and faced by script, and the two actions are pressed as real key events (KeyG, KeyF) with the
// input module put in gameplay mode, so the keymap hook and the module's own edge detection are both on the path.
// 1. ?mock=1: a run starts with 2 charges and 6 lockers at walkable spots; a thrown charge flies its arc, destroys
//    the gull, hurts and holds the hound for 3 s and says so on emp:detonated; a swing damages the hound in front
//    and not the one behind; walking over an ammo tin, a med injector and a charge adds rounds, health and a charge,
//    the pips follow, and full pockets leave a pickup lying; a locker gives up its shelf; a restart clears it all.
// 2. ?mock=1&noeconomy=1: the baseline, with no kit at all.
// fps and console errors are checked throughout. Exits non-zero if a check failed.
import { mkdirSync } from "node:fs";
import { launch } from "./browser.mjs";

const base = process.argv.find((a) => a.startsWith("http")) || "http://127.0.0.1:5304";
const shotsAt = process.argv.indexOf("--shots");
const shots = shotsAt > 0 ? process.argv[shotsAt + 1] : null;
if (shots) mkdirSync(shots, { recursive: true });

let failed = 0;
const check = (ok, what, detail = "") => {
  console.log(`${ok ? "ok  " : "FAIL"} ${what}${detail ? " — " + detail : ""}`);
  if (!ok) failed++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
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
  await page.goto(`${base}/play/?${query}`, { waitUntil: "load" });
  await page.waitForFunction(() => window.__ready === true, null, { timeout: 90000 });
  return { page, errors };
}

/** Frames per second over about a second and a half of play. */
const fps = (page) =>
  page.evaluate(
    () =>
      new Promise((resolve) => {
        let n = 0;
        const t0 = performance.now();
        const tick = () => (++n, performance.now() - t0 < 1500 ? requestAnimationFrame(tick) : resolve((n * 1000) / (performance.now() - t0)));
        requestAnimationFrame(tick);
      }),
  );

/** Helpers in the page: an open lane to work in, standing and facing, and spawning machines that stay put. */
const helpers = () => {
  const G = window.__G;
  const V = G.THREE.Vector3;
  const P = G.physics;
  // A lane along +x in the yard: `len` metres of clear, level, walkable ground under open sky, 3 m wide.
  window.__lane = (len) => {
    for (let z = 26; z >= -8; z -= 0.5)
      for (let x = -22; x <= 14 - len; x += 0.5) {
        let ok = true;
        for (const h of [0.4, 1.6, 3.2]) for (const dz of [-1.5, 0, 1.5]) if (P.raycast(new V(x, h, z + dz), new V(1, 0, 0), len)) ok = false;
        for (let d = 0; ok && d <= len; d += 1) if (!P.nav.isWalkable(x + d, z) || P.raycast(new V(x + d, 0.5, z), new V(0, 1, 0), 8) || P.groundHeight(x + d, z, 1) > 0.05) ok = false;
        if (ok) return { x, z };
      }
    return null;
  };
  // The game's forward is (-sin yaw, 0, -cos yaw).
  window.__stand = (x, z, tx, ty, tz) => {
    const p = G.player;
    p.pos.set(x, P.groundHeight(x, z, 1), z);
    p.vel.set(0, 0, 0);
    p.yaw = Math.atan2(-(tx - x), -(tz - z));
    p.pitch = Math.atan2(ty - 1.6, Math.hypot(tx - x, tz - z));
  };
  // `opts.hostile`: a real hound, standing guard with its back to the west (where the player is), so it stays put
  // until something wakes it. Otherwise the machine is passive: it takes damage and does nothing about it.
  window.__spawn = (type, x, y, z, opts = {}) =>
    G.enemies.spawn(type, new V(x, y, z), type === "gull" ? { passive: true, hover: y, patrolRadius: 0.02 } : opts.hostile ? { yaw: Math.PI / 2, patrolRadius: 0.02 } : { passive: true, yaw: -1.57, patrolRadius: 0.02 });
  window.__events = [];
  for (const name of ["emp:detonated", "pickup:taken", "weapon:melee", "enemy:killed"])
    G.events.on(name, (e) => window.__events.push({ name, kind: e && e.kind, amount: e && e.amount, radius: e && e.radius, pos: e && e.pos && { x: e.pos.x, y: e.pos.y, z: e.pos.z } }));
};

/** A real key press, held for a few frames (the input module ignores keys outside gameplay mode). */
async function press(page, code) {
  await page.evaluate((code) => window.dispatchEvent(new KeyboardEvent("keydown", { code, bubbles: true })), code);
  await sleep(90);
  await page.evaluate((code) => window.dispatchEvent(new KeyboardEvent("keyup", { code, bubbles: true })), code);
}
const pips = (page) => page.evaluate(() => document.querySelectorAll(".ar-pips i:not(.off)").length);
const feedText = (page) => page.evaluate(() => [...document.querySelectorAll(".h-feed .h-fl")].map((e) => e.textContent.toUpperCase()));

// ---- 1. the kit --------------------------------------------------------------------------------------------------
{
  const { page, errors } = await open("mock=1&noaudio=1");
  await page.waitForFunction(() => !!window.__G.economy && !!window.__G.arsenal, null, { timeout: 15000 });
  const strip = await page.evaluate(() => [...document.querySelectorAll(".m-legend .ar-copy")].map((e) => e.textContent.trim()));
  check(strip.length === 2 && /Breaker charge/.test(strip[0]) && /Rifle butt/.test(strip[1]), "the title's controls strip names both keys", strip.join(" | "));
  await page.evaluate(async () => {
    const G = window.__G;
    const r = await G.economy.wallet.claim("KIT");
    if (!r.ok) throw new Error("claim failed: " + r.error);
    G.game.start({ skipIntro: true });
  });
  await page.waitForFunction(() => window.__G.game.state === "playing", null, { timeout: 15000 });
  await page.evaluate(helpers);
  await page.evaluate(() => {
    const G = window.__G;
    G.player.invulnerable = true;
    G.enemies.clear();
    G.input.setGameplay(true);
  });

  // A run's defaults: 2 charges, 6 lockers, each at a walkable spot with a pickup on its shelf.
  const start = await page.evaluate(() => {
    const G = window.__G;
    const nav = G.physics.nav;
    return {
      charges: G.arsenal.charges(),
      // 1.5 m out: once a locker stands, the nav grid shades the cells against its own collider (within about 0.7 m).
      lockers: G.arsenal.lockers.map((l) => ({ ...l, front: nav.isWalkable(l.x + Math.sin(l.yaw) * 1.5, l.z + Math.cos(l.yaw) * 1.5), path: (() => {
        const to = new G.THREE.Vector3(l.x + Math.sin(l.yaw), 0, l.z + Math.cos(l.yaw));
        const p = nav.findPath(G.level.playerStart.pos, to);
        const end = p && p[p.length - 1];
        return !!end && Math.hypot(end.x - to.x, end.z - to.z) < 0.75;
      })() })),
      shelved: G.arsenal.pickups.filter((p) => p.locker !== null).length,
    };
  });
  check(start.charges === 2, "a run starts with 2 charges", `charges ${start.charges}`);
  check(start.lockers.length === 6 && new Set(start.lockers.map((l) => l.id)).size === 6, "six lockers stand on six different spots", start.lockers.map((l) => `L${l.id}:${l.kind}`).join(" "));
  check(start.lockers.every((l) => l.front && l.path), "every locker's front is walkable and reachable from the start", start.lockers.filter((l) => !l.front || !l.path).map((l) => `L${l.id} front ${l.front} path ${l.path}`).join(", "));
  check(start.shelved === 6, "each locker holds one pickup", `${start.shelved} on shelves`);
  check((await pips(page)) === 2, "the HUD shows two charge pips");
  const yard = start.lockers.find((l) => l.x > -24 && l.x < 16 && l.z > -10) || start.lockers[0];
  await page.evaluate(([x, z, yaw]) => window.__stand(x + Math.sin(yaw) * 3.4 - Math.cos(yaw) * 0.9, z + Math.cos(yaw) * 3.4 + Math.sin(yaw) * 0.9, x, 1.0, z), [yard.x, yard.z, yard.yaw]);
  await sleep(700);
  await shot(page, "locker-yard");

  // The charge: thrown on G from 14 m, it lands between a gull and a hound.
  const lane = await page.evaluate(() => (window.__L = window.__lane(17)));
  check(!!lane, "an open lane to throw down", lane ? `x ${lane.x}, z ${lane.z}` : "none");
  await page.evaluate(() => {
    const L = window.__L;
    window.__stand(L.x + 1, L.z, L.x + 15, 1.6, L.z);
    window.__gull = window.__spawn("gull", L.x + 14.5, 2.4, L.z - 1);
    window.__hound = window.__spawn("hound", L.x + 15, 0, L.z + 1.2, { hostile: true });
    window.__far = window.__spawn("hound", L.x + 15, 0, L.z + 6.5);
  });
  await sleep(600);
  await shot(page, "hud-pips");
  await press(page, "KeyG");
  check((await page.evaluate(() => window.__G.arsenal.flights)) === 1 && (await pips(page)) === 1, "G throws a charge and a pip goes out");
  await sleep(250);
  const mid = await page.evaluate(() => window.__G.scene.getObjectByName("arsenal").children.length);
  check(mid >= 2, "the charge and its trail are in the air");
  await shot(page, "charge-flight");
  await page.waitForFunction(() => window.__G.arsenal.flights === 0, null, { timeout: 4000, polling: "raf" });
  await shot(page, "charge-burst");
  const burst = await page.evaluate(() => {
    const G = window.__G,
      L = window.__L;
    const e = window.__events.find((x) => x.name === "emp:detonated");
    return { e, d: e && Math.hypot(e.pos.x - (L.x + 1), e.pos.z - L.z), gull: window.__gull.alive, hp: window.__hound.hp, held: G.arsenal.heldFor(window.__hound), farHp: window.__far.hp, farHeld: G.arsenal.heldFor(window.__far), at: { x: window.__hound.pos.x, z: window.__hound.pos.z } };
  });
  check(!!burst.e && burst.e.radius === 3.5, "emp:detonated carries the burst and its 3.5 m radius");
  check(burst.d > 13 && burst.d < 15, "a level throw bursts 14 m out", `${burst.d?.toFixed(2)} m`);
  check(burst.gull === false, "the gull in the burst is destroyed");
  check(burst.hp === 60 && burst.held > 2, "the hound in it takes 80 and is held", `hp ${burst.hp}, held ${burst.held.toFixed(2)} s`);
  check(burst.farHp === 140 && burst.farHeld === 0, "the hound outside it is untouched");
  // A held hound stays put: it does not come for the player it has just been hit by.
  await sleep(1500);
  const held = await page.evaluate(([x, z]) => ({ moved: Math.hypot(window.__hound.pos.x - x, window.__hound.pos.z - z), mode: window.__hound.mode, left: window.__G.arsenal.heldFor(window.__hound) }), [burst.at.x, burst.at.z]);
  check(held.moved < 0.35 && held.mode === "patrol" && held.left > 0, "the held hound stands where it was", `moved ${held.moved.toFixed(2)} m, ${held.left.toFixed(2)} s left`);
  await page.evaluate(() => window.__stand(window.__L.x + 10.5, window.__L.z, window.__L.x + 15, 0.7, window.__L.z + 1.2));
  await sleep(300);
  await shot(page, "hound-held");
  await page.waitForFunction(() => window.__G.arsenal.heldFor(window.__hound) === 0, null, { timeout: 5000 });
  await sleep(400);
  const woke = await page.evaluate(() => ({ mode: window.__hound.mode, passive: window.__hound.passive }));
  check(woke.mode !== "patrol" && woke.passive === false, "after 3 s it wakes and comes looking", `mode ${woke.mode}`);

  // The rifle butt: one hound in front, one behind.
  await page.evaluate(() => {
    const G = window.__G,
      L = window.__L;
    G.enemies.clear();
    window.__events.length = 0;
    window.__stand(L.x + 6, L.z, L.x + 12, 1.2, L.z);
    window.__front = window.__spawn("hound", L.x + 7.7, 0, L.z);
    window.__back = window.__spawn("hound", L.x + 4.3, 0, L.z);
  });
  await sleep(500);
  await shot(page, "swing-before");
  await press(page, "KeyF");
  await shot(page, "swing");
  await sleep(350);
  const swing = await page.evaluate(() => ({ front: window.__front.hp, back: window.__back.hp, x: window.__front.pos.x - window.__L.x, melee: window.__events.filter((e) => e.name === "weapon:melee").length }));
  check(swing.front === 70 && swing.melee === 1, "F swings once: the hound in front takes 70", `hp ${swing.front}, ${swing.melee} weapon:melee`);
  check(swing.back === 140, "the hound behind is untouched", `hp ${swing.back}`);
  check(swing.x > 8.3, "the hit hound is knocked back", `${(swing.x - 7.7).toFixed(2)} m`);
  await page.evaluate(() => window.__stand(window.__front.pos.x - 1.7, window.__L.z, window.__front.pos.x + 4, 1.2, window.__L.z)); // it was knocked out of reach
  await sleep(150);
  await press(page, "KeyF");
  await sleep(300);
  const dead = await page.evaluate(() => ({ alive: window.__front.alive, killed: window.__events.filter((e) => e.name === "enemy:killed").length }));
  check(dead.alive === false && dead.killed === 1, "a second swing finishes it");

  // Pickups: walk over a tin, an injector and a charge.
  await page.evaluate(() => {
    const G = window.__G,
      L = window.__L;
    G.enemies.clear();
    window.__events.length = 0;
    // The west end of the lane, clear of anything the dead machines dropped further up it.
    window.__loose = G.arsenal.pickups.filter((p) => p.locker === null).length;
    window.__stand(L.x, L.z, L.x + 12, 0.3, L.z);
    G.weapon.reserve = 100;
    G.arsenal.setCharges(1);
    G.arsenal.spawnPickup("ammo", { x: L.x + 3.6, z: L.z - 1.1 });
    G.arsenal.spawnPickup("med", { x: L.x + 3.6, z: L.z });
    G.arsenal.spawnPickup("charge", { x: L.x + 3.6, z: L.z + 1.1 });
  });
  await sleep(700);
  await shot(page, "pickups");
  const before = await page.evaluate(() => ({ n: window.__G.arsenal.pickups.filter((p) => p.locker === null).length - window.__loose, reserve: window.__G.weapon.reserve }));
  check(before.n === 3 && before.reserve === 100, "three pickups lie on the ground, out of reach at 3.6 m");
  // A real hit, so the baseline's regeneration (4 s after the last hit) is not what heals.
  await page.evaluate(() => {
    const p = window.__G.player;
    p.invulnerable = false;
    p.damage(60);
    p.invulnerable = true;
  });
  for (const dz of [-1.1, 0, 1.1]) {
    await page.evaluate((dz) => window.__stand(window.__L.x + 3, window.__L.z + dz, window.__L.x + 12, 1, window.__L.z + dz), dz);
    await sleep(250);
  }
  const got = await page.evaluate(() => ({ reserve: window.__G.weapon.reserve, health: window.__G.player.health, charges: window.__G.arsenal.charges(), taken: window.__events.filter((e) => e.name === "pickup:taken").map((e) => `${e.kind}+${e.amount}`), left: window.__G.arsenal.pickups.filter((p) => p.locker === null).length - window.__loose }));
  check(got.reserve === 130, "the tin adds 30 rounds", `reserve ${got.reserve}`);
  check(got.health === 75, "the injector adds 35 health", `health ${got.health}`);
  check(got.charges === 2 && (await pips(page)) === 2, "the charge adds one and the pips follow", `charges ${got.charges}`);
  check(got.taken.join(" ") === "ammo+30 med+35 charge+1" && got.left === 0, "pickup:taken says what each was", got.taken.join(" "));
  const feed = await feedText(page);
  check(["+30 ROUNDS", "+35 HEALTH", "+1 BREAKER CHARGE"].every((t) => feed.includes(t)), "the HUD feed names each", feed.join(" | "));
  await shot(page, "feed");

  // Full pockets: nothing is taken.
  await page.evaluate(() => {
    const G = window.__G,
      L = window.__L;
    G.player.health = G.player.maxHealth;
    G.weapon.reserve = 240;
    G.arsenal.setCharges(3);
    for (const kind of ["ammo", "med", "charge"]) G.arsenal.spawnPickup(kind, { x: L.x + 1, z: L.z + 1.4 });
    window.__stand(L.x + 1, L.z + 1.4, L.x + 12, 1, L.z);
  });
  await sleep(300);
  const fullUp = await page.evaluate(() => ({ left: window.__G.arsenal.pickups.filter((p) => p.locker === null).length - window.__loose, reserve: window.__G.weapon.reserve, pips: document.querySelectorAll(".ar-pips i:not(.off)").length }));
  check(fullUp.left === 3 && fullUp.reserve === 240 && fullUp.pips === 3, "at full health, a full reserve and three charges they stay on the ground");

  // A locker gives up its shelf.
  const locker = start.lockers.find((l) => l.kind === "ammo");
  await page.evaluate(([x, z, yaw]) => ((window.__G.weapon.reserve = 90), window.__stand(x + Math.sin(yaw) * 0.75, z + Math.cos(yaw) * 0.75, x, 1.0, z)), [locker.x, locker.z, locker.yaw]);
  await sleep(300);
  const shelf = await page.evaluate((id) => ({ reserve: window.__G.weapon.reserve, taken: window.__G.arsenal.lockers.find((l) => l.id === id).taken }), locker.id);
  check(shelf.reserve === 120 && shelf.taken, "walking up to a locker takes the tin off its shelf", `reserve ${shelf.reserve}`);

  const rate = await fps(page);
  check(rate > 50, "fps near 60 with the kit in the world", rate.toFixed(1));

  // A restart clears the run's kit and deals the next.
  await page.evaluate(() => window.__G.game.start({ skipIntro: true }));
  await sleep(500);
  const again = await page.evaluate(() => ({ charges: window.__G.arsenal.charges(), lockers: window.__G.arsenal.lockers.length, loose: window.__G.arsenal.pickups.filter((p) => p.locker === null).length, taken: window.__G.arsenal.lockers.filter((l) => l.taken).length, boxes: window.__G.scene.getObjectByName("arsenal").children.length }));
  check(again.charges === 2 && again.lockers === 6 && again.loose === 0 && again.taken === 0, "a new run starts clean: 2 charges, 6 full lockers, nothing on the ground", JSON.stringify(again));
  check(errors.length === 0, "no console errors", errors.slice(0, 3).join(" | "));
  await page.close();
}

// ---- 2. the baseline -----------------------------------------------------------------------------------------------
{
  const { page, errors } = await open("mock=1&noeconomy=1&noaudio=1");
  await page.evaluate(() => window.__G.game.start({ skipIntro: true }));
  await page.waitForFunction(() => window.__G.game.state === "playing", null, { timeout: 15000 });
  await page.evaluate(() => {
    window.__G.player.invulnerable = true;
    window.__G.input.setGameplay(true);
  });
  const boxes = await page.evaluate(() => window.__G.physics.boxes.length);
  await press(page, "KeyG");
  await press(page, "KeyF");
  await sleep(300);
  const base0 = await page.evaluate(() => ({
    arsenal: "arsenal" in window.__G,
    pips: document.querySelectorAll(".ar-charges, .ar-copy, .ar-flash").length,
    group: !!window.__G.scene.getObjectByName("arsenal"),
    boxes: window.__G.physics.boxes.length,
    reserve: window.__G.weapon.reserve,
    ammo: window.__G.weapon.ammo,
    state: window.__G.game.state,
  }));
  check(!base0.arsenal && base0.pips === 0 && !base0.group, "?noeconomy=1 has no kit: no G.arsenal, no pips, no props");
  check(base0.boxes === boxes && base0.reserve === 150 && base0.ammo === 30 && base0.state === "playing", "G and F do nothing in the baseline and the run plays on");
  const rate = await fps(page);
  check(rate > 50, "baseline fps near 60", rate.toFixed(1));
  check(errors.length === 0, "no console errors in the baseline", errors.slice(0, 3).join(" | "));
  await page.close();
}

await browser.close();
console.log(failed ? `\n${failed} check(s) failed` : "\nall checks passed");
process.exit(failed ? 1 : 0);
