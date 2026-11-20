// Draw the level from above, to plan new areas on.
// usage: node scripts/level-map.mjs <base-url> <out-dir>     (a dev server: npm run dev)
//
// Loads the baseline game (?noeconomy=1, the level and the shooter only), stops its frame loop and writes three files:
//   top.jpg    the yard seen straight down through an orthographic camera, 25 px a metre, with no fog and the shed's
//              roof cut away above 6 m so its floor shows, and the quay crane cut above 9 m. x runs left to right, z top to bottom.
//   map.json   what is on that picture, in metres: every placed prop (with its footprint and the step in
//              src/level/yard.json that placed it, or "code" for the shed, quay and boat), every collision box, where
//              ground machines can walk (a 0.5 m grid), the zones, spawns, cover points, relays, the boat, the
//              player start and the opening's camera path.
//   map.html   a viewer for the two (scripts/level-map.html with map.json built in): open it from the folder. Zoom,
//              layers, what is under the cursor and the step that placed it, pins with copyable coordinates.
// Run it again after changing the level; nothing is cached.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { launch } from "./browser.mjs";

const [base, outDir] = process.argv.slice(2);
if (!base || !outDir) {
  console.error("usage: node scripts/level-map.mjs <base-url> <out-dir>");
  process.exit(2);
}

/** The picture's extent: the world (x −40…40, z −30…30) and 4 m round it. */
const VIEW = { x: [-44, 44], z: [-34, 34], ppm: 25 };
/** The shed's roof is cut away above this height, and the quay crane above CRANE_CUT. */
const ROOF_CUT = 6;
const CRANE_CUT = 9;

const browser = await launch();
let data;
let jpeg;
try {
  const page = await browser.newPage({ viewport: { width: 960, height: 600 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e.message)));
  await page.goto(`${base.replace(/\/$/, "")}/play/?noeconomy=1&noaudio&seed=1&q=high`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => window.__ready && window.__G && window.__G.level, null, { timeout: 120000 });
  // Let the first frames settle (shadows, the interior light probe), then take over the renderer.
  await page.waitForFunction(() => window.__frames > 30, null, { timeout: 60000 });
  const out = await page.evaluate(
    ({ VIEW, ROOF_CUT, CRANE_CUT }) => {
      const G = window.__G;
      const THREE = G.THREE;
      const L = G.level;
      const P = G.physics;
      const r3 = (v) => Math.round(v * 1000) / 1000;
      const v3 = (v) => (v ? [r3(v.x), r3(v.y), r3(v.z)] : null);

      G.renderer.setAnimationLoop(null);
      const renderer = G.renderer;
      const scene = G.scene;
      const W = (VIEW.x[1] - VIEW.x[0]) * VIEW.ppm;
      const H = (VIEW.z[1] - VIEW.z[0]) * VIEW.ppm;
      const cx = (VIEW.x[0] + VIEW.x[1]) / 2;
      const cz = (VIEW.z[0] + VIEW.z[1]) / 2;

      // Straight down, with −z at the top of the picture so x reads left to right and z top to bottom.
      const cam = new THREE.OrthographicCamera(-W / VIEW.ppm / 2, W / VIEW.ppm / 2, H / VIEW.ppm / 2, -H / VIEW.ppm / 2, 1, 400);
      cam.position.set(cx, 200, cz);
      cam.up.set(0, 0, -1);
      cam.lookAt(cx, 0, cz);
      cam.updateMatrixWorld(true);

      // The sun's shadow normally follows the player; stretch it over the whole yard for one frame.
      scene.traverse((o) => {
        if (!o.isDirectionalLight || !o.castShadow) return;
        const dir = o.position.clone().sub(o.target.position).normalize();
        o.target.position.set(cx, 0, cz);
        o.target.updateMatrixWorld(true);
        o.position.copy(dir.multiplyScalar(150)).add(o.target.position);
        o.updateMatrixWorld(true);
        const sc = o.shadow.camera;
        Object.assign(sc, { left: -64, right: 64, top: 64, bottom: -64, near: 1, far: 400 });
        sc.updateProjectionMatrix();
        o.shadow.mapSize.set(8192, 8192);
        if (o.shadow.map) {
          o.shadow.map.dispose();
          o.shadow.map = null;
        }
      });
      renderer.shadowMap.needsUpdate = true;

      // Cut the shed's roof away: clip what is above ROOF_CUT and inside the shed (all five planes at once).
      const shed = L.interiorBoxes && L.interiorBoxes[0];
      if (shed) {
        const V = THREE.Vector3;
        const planes = [
          new THREE.Plane(new V(0, -1, 0), ROOF_CUT),
          new THREE.Plane(new V(-1, 0, 0), shed.min.x - 1),
          new THREE.Plane(new V(1, 0, 0), -(shed.max.x + 1)),
          new THREE.Plane(new V(0, 0, -1), shed.min.z - 1),
          new THREE.Plane(new V(0, 0, 1), -(shed.max.z + 1)),
        ];
        renderer.localClippingEnabled = true;
        scene.traverse((o) => {
          if (!o.material) return;
          for (const m of Array.isArray(o.material) ? o.material : [o.material]) {
            if (m.isShaderMaterial) continue;
            m.clippingPlanes = planes;
            m.clipIntersection = true;
            m.needsUpdate = true;
          }
        });
      }

      // The quay crane (part of the backdrop) spans the quay at 30 m; keep its legs and cut it, and its shadow,
      // above CRANE_CUT so the ground under it shows.
      const crane = scene.getObjectByName("crane");
      if (crane) {
        const cut = [new THREE.Plane(new THREE.Vector3(0, -1, 0), CRANE_CUT)];
        renderer.localClippingEnabled = true;
        crane.traverse((o) => {
          if (!o.material) return;
          const clip = (m) => Object.assign(m.clone(), { clippingPlanes: cut, clipShadows: true });
          o.material = Array.isArray(o.material) ? o.material.map(clip) : clip(o.material);
        });
      }

      const fog = scene.fog;
      scene.fog = null;
      renderer.setRenderTarget(null);
      renderer.setPixelRatio(1);
      renderer.setSize(W, H, false);
      renderer.render(scene, cam);
      const jpeg = renderer.domElement.toDataURL("image/jpeg", 0.86);
      scene.fog = fog;

      // Ground machines' walkable cells, row by row from z −30, 0.5 m a cell.
      const cell = 0.5;
      let walk = "";
      for (let z = -30 + cell / 2; z < 30; z += cell) for (let x = -40 + cell / 2; x < 40; x += cell) walk += P.nav.isWalkable(x, z) ? "1" : "0";

      return {
        jpeg,
        errors: window.__errors.slice(0, 20),
        level: {
          placed: L.placed.map((q) => ({ kind: q.name, x: r3(q.x), y: r3(q.y), z: r3(q.z), yaw: r3(q.yaw) })),
          boxes: P.boxes.map((b) => {
            const row = { min: v3(b.min), max: v3(b.max), surface: b.surface };
            for (const k of ["noNav", "bulletOnly", "playerOnly"]) if (b[k]) row[k] = true;
            return row;
          }),
          walk: { cell, origin: [-40, -30], cols: 160, rows: 120, cells: walk },
          zones: L.zones,
          relays: L.objectives.map((o) => ({ id: o.id, label: o.label, zone: o.zone, pos: v3(o.pos) })),
          extraction: { pos: v3(L.extraction.pos), radius: L.extraction.radius },
          playerStart: { pos: v3(L.playerStart.pos), yaw: r3(L.playerStart.yaw) },
          spawns: L.enemySpawns.map((s) => ({ type: s.type, zone: s.zone, pos: v3(s.pos) })),
          coverPoints: L.coverPoints.map(v3),
          cinematicPath: L.cinematicPath,
          vantage: { stairsFoot: v3(L.vantage.stairsFoot), roof: v3(L.vantage.roof) },
          shed: shed ? { min: v3(shed.min), max: v3(shed.max) } : null,
          stats: L.stats,
        },
      };
    },
    { VIEW, ROOF_CUT, CRANE_CUT },
  );
  if (errors.length || out.errors.length) console.error("page errors:", [...errors, ...out.errors]);
  jpeg = Buffer.from(out.jpeg.split(",")[1], "base64");
  data = out.level;
} finally {
  await browser.close();
}

// Which step of src/level/yard.json placed each prop. Props from `place` steps match exactly on kind and position;
// containers sit within a metre of their `stack` step (the stack leans); fence panels lie on their `fence_run`;
// stairs and catwalks match their step's position. The rest (the shed, the quay, the boat, the relays) is code.
const yard = JSON.parse(readFileSync(new URL("../src/level/yard.json", import.meta.url), "utf8"));
const steps = Object.entries(yard.sections).flatMap(([section, list]) => list.map((s, i) => ({ ...s, ref: `${section}[${i}]` })));
const near = (a, b, d) => Math.hypot(a.x - b.x, a.z - b.z) <= d;
const onSegment = (p, a, b) => {
  const [ax, az] = a;
  const [bx, bz] = b;
  const t = Math.max(0, Math.min(1, ((p.x - ax) * (bx - ax) + (p.z - az) * (bz - az)) / ((bx - ax) ** 2 + (bz - az) ** 2)));
  return Math.hypot(p.x - (ax + t * (bx - ax)), p.z - (az + t * (bz - az))) < 0.05;
};
/** Where each box of a stack sits: the stack's spot plus the box's own dx / dz, turned with the stack's yaw. */
const boxSpots = (s) =>
  s.boxes.map(([, , o = {}]) => {
    const [dx, dz, a] = [o.dx || 0, o.dz || 0, s.yaw || 0];
    return { x: s.x + dx * Math.cos(a) + dz * Math.sin(a), z: s.z - dx * Math.sin(a) + dz * Math.cos(a) };
  });
function stepFor(p) {
  if (p.kind.startsWith("container")) {
    const gap = (s) => Math.min(...boxSpots(s).map((b) => Math.hypot(p.x - b.x, p.z - b.z)));
    return steps.filter((s) => s.op === "stack" && gap(s) <= 1).sort((a, b) => gap(a) - gap(b))[0];
  }
  if (p.kind === "fence_panel") return steps.find((s) => s.op === "fence_run" && onSegment(p, s.from, s.to));
  if (p.kind === "stairs_metal" || p.kind === "catwalk") return steps.find((s) => (s.op === "stairs" || s.op === "catwalk") && near(p, s, 0.01));
  if (p.kind === "reefer_unit") return steps.find((s) => s.op === "stack" && near(p, s, 7));
  return steps.find((s) => s.op === "place" && s.kind === p.kind && near(p, s, 0.001));
}

/** The catalogue's sizes (w along x at yaw 0, h, d along z), read from `Gi` in src/game.js so there is one copy. */
const SIZE = {};
{
  const src = readFileSync(new URL("../src/game.js", import.meta.url), "utf8");
  const start = src.indexOf("var Gi = {");
  if (start < 0) throw new Error("level-map: the prop catalogue (var Gi) is not in src/game.js");
  const block = src.slice(start, src.indexOf("}", start));
  for (const m of block.matchAll(/(\w+): \[([\d.]+), ([\d.]+), ([\d.]+),/g)) SIZE[m[1]] = [+m[2], +m[3], +m[4]];
  if (Object.keys(SIZE).length < 30) throw new Error(`level-map: read only ${Object.keys(SIZE).length} prop sizes from src/game.js`);
}
let matched = 0;
for (const p of data.placed) {
  const s = stepFor(p);
  p.step = s ? s.ref : "code";
  if (s) matched++;
  const size = SIZE[p.kind];
  if (size) [p.w, p.h, p.d] = size;
}

const map = { view: VIEW, roofCut: ROOF_CUT, craneCut: CRANE_CUT, world: { x: [-40, 40], z: [-30, 30], groundY: 0, seaY: -1.6, quayX: 30 }, ...data };
mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, "top.jpg"), jpeg);
writeFileSync(join(outDir, "map.json"), JSON.stringify(map));
// The viewer, with the data built in so it opens from the folder with no server. "<" is escaped so nothing in the
// data can close the script tag it sits in.
const viewer = readFileSync(new URL("./level-map.html", import.meta.url), "utf8");
if (!viewer.includes("/*MAP_DATA*/")) throw new Error("level-map: scripts/level-map.html has lost its /*MAP_DATA*/ slot");
writeFileSync(join(outDir, "map.html"), viewer.replace("/*MAP_DATA*/", () => JSON.stringify(map).replace(/</g, "\\u003c")));
console.log(
  JSON.stringify({
    picture: `${(VIEW.x[1] - VIEW.x[0]) * VIEW.ppm}x${(VIEW.z[1] - VIEW.z[0]) * VIEW.ppm}`,
    kb: Math.round(jpeg.length / 1024),
    props: data.placed.length,
    fromYardJson: matched,
    boxes: data.boxes.length,
    spawns: data.spawns.length,
  }),
);
