// Generates src/economy/arsenal/spots.ts: the checked ground positions a mission's supply lockers are dealt from
// (docs/CAMPAIGN.md → The kit). Run it against a dev server and commit the output; the spots are static data, so the
// game and the tests agree on them without loading the level.
//
//   npm run dev -- --port 5304
//   node scripts/gen-locker-spots.mjs [http://127.0.0.1:5304] [--dry]
//
// A locker is 0.9 m wide, 0.5 m deep and 1.9 m tall, and stands with its back to something solid so it never sits in
// a lane the hounds path through. The level is sampled on a 0.5 m grid, facing each of the four axes. A position
// qualifies when:
//   - there is a wall at least 1.6 m tall straight behind it (rays at 0.3 m and 1.6 m stop within 0.9 m), and the
//     locker is set 4 cm off that wall;
//   - its footprint touches no collider and stands on level ground (within 5 cm at its four corners) with open sky
//     or a roof at least 3.2 m up (so never inside a container);
//   - the 2.2 m in front of it is clear at shin and chest height across its width, and walkable on the nav grid;
//   - nav.findPath from the player start ends within 0.75 m of the point 1 m in front of it; and
//   - it keeps its distance from the relays (4 m), the boat (5 m), the start (6 m), the drone spawns (3 m) and the
//     salvage spots' doors (3 m).
// From everything that qualifies the script keeps 16, spread by zone (yard 6, shed 4, quay 4, gate 2), each pick
// the candidate farthest from those already chosen, and never within 6 m of another.
import { readFileSync, writeFileSync } from "node:fs";
import { launch } from "./browser.mjs";

const url = process.argv.find((a) => a.startsWith("http")) || "http://127.0.0.1:5304";
const dry = process.argv.includes("--dry");
const OUT = new URL("../src/economy/arsenal/spots.ts", import.meta.url);
const QUOTA = { yard: 6, shed: 4, quay: 4, gate: 2 };
const MIN_APART = 6;

// The salvage spots' doors, read from the generated table (kept clear so a seal and a locker never share a wall).
const salvage = [...readFileSync(new URL("../src/economy/salvage/spots.ts", import.meta.url), "utf8").matchAll(/x: (-?[\d.]+), z: (-?[\d.]+), yaw/g)].map(
  (m) => ({ x: +m[1], z: +m[2] }),
);

const browser = await launch();
try {
  const page = await browser.newPage({ viewport: { width: 640, height: 360 } });
  await page.goto(url + "/?noeconomy=1&noaudio=1&q=low", { waitUntil: "load" });
  await page.waitForFunction(() => window.__ready === true, null, { timeout: 90000 });
  const found = await page.evaluate((salvage) => {
    const G = window.__G;
    const V = G.THREE.Vector3;
    const P = G.physics;
    const nav = P.nav;
    const start = G.level.playerStart.pos;
    const W = 0.9,
      D = 0.5,
      H = 1.9;
    const zoneOf = (x, z) => (G.level.zones.find((q) => x >= q.min[0] && x < q.max[0] && z >= q.min[1] && z < q.max[1]) || { name: "?" }).name;
    const keep = [
      ...G.level.objectives.map((o) => ({ x: o.pos.x, z: o.pos.z, r: 4 })),
      { x: G.level.extraction.pos.x, z: G.level.extraction.pos.z, r: 5 },
      { x: start.x, z: start.z, r: 6 },
      ...(G.level.enemySpawns || []).map((s) => ({ x: (s.pos || s).x, z: (s.pos || s).z, r: 3 })),
      ...salvage.map((s) => ({ x: s.x, z: s.z, r: 3 })),
    ];
    const ray = (x, y, z, dx, dz, max) => P.raycast(new V(x, y, z), new V(dx, 0, dz), max);
    const solids = P.boxes.filter((b) => !b.bulletOnly);
    const out = [];
    for (let gx = -39; gx <= 39; gx += 0.5)
      for (let gz = -29; gz <= 29; gz += 0.5) {
        if (!nav.isWalkable(gx, gz)) continue;
        for (let k = 0; k < 4; k++) {
          const yaw = [0, Math.PI / 2, Math.PI, -Math.PI / 2][k];
          const fx = Math.round(Math.sin(yaw)),
            fz = Math.round(Math.cos(yaw));
          // A wall behind, at shin and head height, at about the same distance.
          const lo = ray(gx, 0.3, gz, -fx, -fz, 0.9),
            hi = ray(gx, 1.6, gz, -fx, -fz, 0.9);
          if (!lo || !hi || Math.abs(lo.dist - hi.dist) > 0.08) continue;
          const x = gx - fx * (lo.dist - D / 2 - 0.04),
            z = gz - fz * (lo.dist - D / 2 - 0.04);
          // The wall is as wide as the locker.
          const sx = fz,
            sz = -fx; // the locker's right
          const edge = (s) => ray(x + sx * s, 1.0, z + sz * s, -fx, -fz, 0.6);
          const l = edge(-W / 2 + 0.05),
            r = edge(W / 2 - 0.05);
          if (!l || !r || Math.abs(l.dist - r.dist) > 0.05) continue;
          // Level ground, nothing overhead.
          const y = P.groundHeight(x, z, 0.6);
          const corners = [
            [x + sx * 0.45 + fx * 0.25, z + sz * 0.45 + fz * 0.25],
            [x - sx * 0.45 + fx * 0.25, z - sz * 0.45 + fz * 0.25],
            [x + sx * 0.45 - fx * 0.2, z + sz * 0.45 - fz * 0.2],
            [x - sx * 0.45 - fx * 0.2, z - sz * 0.45 - fz * 0.2],
          ];
          if (y > 0.25 || corners.some(([cx, cz]) => Math.abs(P.groundHeight(cx, cz, 0.6) - y) > 0.05)) continue;
          if (P.raycast(new V(x + fx * 0.6, y + 0.4, z + fz * 0.6), new V(0, 1, 0), 2.8)) continue;
          // The footprint touches no collider.
          const hx = Math.abs(sx) * (W / 2) + Math.abs(fx) * (D / 2) - 0.01,
            hz = Math.abs(sz) * (W / 2) + Math.abs(fz) * (D / 2) - 0.01;
          if (solids.some((b) => b.min.x < x + hx && b.max.x > x - hx && b.min.z < z + hz && b.max.z > z - hz && b.min.y < y + H && b.max.y > y + 0.06)) continue;
          // Clear and walkable in front.
          let clear = true;
          for (const s of [-W / 2, 0, W / 2])
            for (const h of [0.35, 1.2]) if (ray(x + sx * s + fx * (D / 2 + 0.02), y + h, z + sz * s + fz * (D / 2 + 0.02), fx, fz, 2.2)) clear = false;
          if (!clear) continue;
          if (![0.7, 1.0, 1.5, 2.0].every((d) => nav.isWalkable(x + fx * d, z + fz * d))) continue;
          if (keep.some((q) => Math.hypot(q.x - x, q.z - z) < q.r)) continue;
          const stand = { x: x + fx, z: z + fz };
          const path = nav.findPath(start, new V(stand.x, 0, stand.z));
          const end = path && path[path.length - 1];
          if (!end || Math.hypot(end.x - stand.x, end.z - stand.z) > 0.75) continue;
          out.push({ x, y, z, yaw, zone: zoneOf(x, z) });
        }
      }
    return out;
  }, salvage);

  const by = {};
  for (const c of found) (by[c.zone] ??= []).push(c);
  console.log(`${found.length} positions qualify:`, Object.fromEntries(Object.entries(by).map(([k, v]) => [k, v.length])));

  const picked = [];
  const far = (c) => Math.min(1e9, ...picked.map((p) => Math.hypot(p.x - c.x, p.z - c.z)));
  for (const [zone, want] of Object.entries(QUOTA)) {
    const pool = [...(by[zone] || [])];
    for (let n = 0; n < want && pool.length; n++) {
      // Farthest from every pick so far; ties broken by position so the output is stable.
      pool.sort((a, b) => far(b) - far(a) || a.x - b.x || a.z - b.z);
      if (far(pool[0]) < MIN_APART) break;
      picked.push(pool.shift());
    }
  }
  if (picked.length < 12) throw new Error(`only ${picked.length} spots; need at least 12`);
  const order = { yard: 0, shed: 1, quay: 2, gate: 3 };
  picked.sort((a, b) => order[a.zone] - order[b.zone] || a.x - b.x || a.z - b.z);

  const r2 = (v) => Math.round(v * 100) / 100;
  const rows = picked.map((c, i) => `  { id: ${i}, zone: "${c.zone}", x: ${r2(c.x)}, y: ${r2(c.y)}, z: ${r2(c.z)}, yaw: ${r2(c.yaw)} },`);
  for (const r of rows) console.log(r);
  const src = `// GENERATED by scripts/gen-locker-spots.mjs from the level as built. Do not edit by hand: rerun the script.
//
// Where a supply locker may stand: ${picked.length} ground positions, each checked in the running level: a wall at its back,
// its footprint clear of every collider, level ground, 2.2 m of clear, walkable floor in front, a nav path from the
// player start, and away from the relays, the boat, the start, the drone spawns and the salvage doors.
//
// x, y, z: the centre of the locker's base. yaw: its three.js yaw; the open front faces (sin yaw, 0, cos yaw).

export interface LockerSpot {
  id: number;
  zone: "yard" | "shed" | "quay" | "gate";
  x: number;
  y: number;
  z: number;
  yaw: number;
}

// One spot per line, as generated.
// prettier-ignore
export const LOCKER_SPOTS: readonly LockerSpot[] = [
${rows.join("\n")}
];
`;
  if (dry) console.log(src);
  else writeFileSync(OUT, src);
} finally {
  await browser.close();
}
