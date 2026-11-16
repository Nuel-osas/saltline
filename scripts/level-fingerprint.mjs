// Fingerprint everything the level builds, so a change to how the level is built can be shown to change nothing.
// usage: node scripts/level-fingerprint.mjs <base-url> <out.json>     (a dev server: npm run dev)
//
// Loads the baseline game (?noeconomy=1, so only the level and the shooter), waits for boot, and writes:
// every placed prop, every collision box, the walkable grid and floor surfaces sampled every 0.25 m, a hash of
// every merged and dynamic mesh (geometry bytes, material, transform), and the play data (start, objectives,
// spawns, zones, cover, camera path). Prints one hash per section. Two runs of the same code print the same
// hashes; compare two files with `diff`.
import { writeFileSync } from "node:fs";
import { launch } from "./browser.mjs";

const [base, out] = process.argv.slice(2);
if (!base || !out) {
  console.error("usage: node scripts/level-fingerprint.mjs <base-url> <out.json>");
  process.exit(2);
}

const browser = await launch();
try {
  const page = await browser.newPage({ viewport: { width: 960, height: 600 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e.message)));
  await page.goto(`${base.replace(/\/$/, "")}/play/?noeconomy=1&noaudio&seed=1`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => window.__ready && window.__G && window.__G.level, null, { timeout: 120000 });
  const fp = await page.evaluate(() => {
    const G = window.__G;
    const L = G.level;
    const P = G.physics;
    // FNV-1a over 32-bit words: fast enough for the merged yard (a few million floats).
    const hashBytes = (h, view) => {
      const n = view.byteLength >> 2;
      const w = new Uint32Array(view.buffer, view.byteOffset, n);
      for (let k = 0; k < n; k++) h = Math.imul(h ^ w[k], 16777619) >>> 0;
      const tail = new Uint8Array(view.buffer, view.byteOffset + n * 4, view.byteLength - n * 4);
      for (let k = 0; k < tail.length; k++) h = Math.imul(h ^ tail[k], 16777619) >>> 0;
      return h;
    };
    const hashStr = (s) => hashBytes(2166136261, new TextEncoder().encode(s));
    const r6 = (v) => Math.round(v * 1e6) / 1e6;
    const v3 = (v) => (v ? [r6(v.x), r6(v.y), r6(v.z)] : null);
    const geomHash = (g) => {
      let h = 2166136261;
      for (const name of Object.keys(g.attributes).sort()) {
        h = hashStr(name + h);
        h = hashBytes(h, g.attributes[name].array);
      }
      if (g.index) h = hashBytes(h, g.index.array);
      return h.toString(16);
    };
    const meshes = (root, deep) => {
      const list = [];
      if (!root) return list;
      root.traverse((o) => {
        const row = { name: o.name, type: o.type };
        // Dynamic props animate (one sways), so only the merged level's rotations are compared.
        if (deep || o.parent === root) Object.assign(row, { p: v3(o.position), s: v3(o.scale) });
        if (deep) row.q = [o.quaternion.x, o.quaternion.y, o.quaternion.z, o.quaternion.w].map(r6);
        if (o.isMesh) {
          row.geom = geomHash(o.geometry);
          row.mat = Array.isArray(o.material) ? o.material.map((m) => m.name) : o.material && o.material.name;
          row.shadow = [o.castShadow, o.receiveShadow];
        }
        list.push(row);
      });
      return list;
    };
    const boxes = P.boxes.map((b) => {
      const row = { min: v3(b.min), max: v3(b.max) };
      for (const [k, v] of Object.entries(b)) if (k !== "min" && k !== "max" && (typeof v !== "object" || v === null)) row[k] = v;
      return row;
    });
    const grid = (fn, step) => {
      let s = "";
      for (let z = -30; z <= 30; z += step) for (let x = -40; x <= 40; x += step) s += fn(x, z);
      return s;
    };
    const walk = P.nav && P.nav.isWalkable ? grid((x, z) => (P.nav.isWalkable(x, z) ? 1 : 0), 0.25) : "";
    const surface = grid((x, z) => (L.groundSurfaceAt(x, z) === "metal" ? "m" : "c"), 0.25);
    const merged = G.scene.getObjectByName("level-merged");
    const dynamic = G.scene.getObjectByName("level-dynamic");
    const sections = {
      placed: L.placed.map((q) => [q.name, r6(q.x), r6(q.y), r6(q.z), r6(q.yaw)]),
      boxes,
      walk: { cells: walk.length, hash: hashStr(walk).toString(16), walkable: [...walk].filter((c) => c === "1").length },
      surface: { hash: hashStr(surface).toString(16), metal: [...surface].filter((c) => c === "m").length },
      merged: meshes(merged, true),
      dynamic: meshes(dynamic, false),
      play: {
        playerStart: { pos: v3(L.playerStart.pos), yaw: L.playerStart.yaw },
        objectives: L.objectives.map((o) => ({ id: o.id, label: o.label, zone: o.zone, pos: v3(o.pos), obj: v3(o.object && o.object.position) })),
        extraction: { pos: v3(L.extraction.pos), radius: L.extraction.radius },
        enemySpawns: L.enemySpawns.map((s) => [s.type, s.zone, ...v3(s.pos)]),
        zones: L.zones,
        interiorBoxes: L.interiorBoxes.map((b) => [v3(b.min), v3(b.max)]),
        cinematicPath: L.cinematicPath,
        coverPoints: L.coverPoints.map(v3),
        vantage: { stairsFoot: v3(L.vantage.stairsFoot), roof: v3(L.vantage.roof) },
        skylights: (L.skylights || []).length,
        shedLights: (L.shedLights || []).length,
        stats: L.stats,
      },
    };
    const summary = {};
    for (const [k, v] of Object.entries(sections)) summary[k] = hashStr(JSON.stringify(v)).toString(16);
    return { summary, counts: { placed: sections.placed.length, boxes: boxes.length, merged: sections.merged.length, dynamic: sections.dynamic.length, tris: L.stats.tris }, sections };
  });
  fp.errors = errors;
  writeFileSync(out, JSON.stringify(fp, null, 1));
  console.log(JSON.stringify({ summary: fp.summary, counts: fp.counts, errors: errors.length }));
} finally {
  await browser.close();
}
