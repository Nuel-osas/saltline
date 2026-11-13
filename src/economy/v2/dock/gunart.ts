// The gun's picture, drawn here in SVG: a side profile built from the frame (how long the barrel, what stock, what
// magazine) and the mods fitted to it (a longer magazine, a longer barrel, a compensator, an optic). No art is
// downloaded. Colours come from CSS variables on the card, so a frame's finish and an A grade's gilt are styling.
import type { FrameId, ModId } from "../types";

export type ArtFrame = FrameId | "issue";

interface Spec {
  stock: number;
  stockKind: "fixed" | "wire" | "precision";
  body: number;
  guard: number;
  barrel: number;
  mag: number;
  lean: number;
  bipod?: boolean;
  heavy?: boolean;
}

const SPEC: Record<ArtFrame, Spec> = {
  longshore: { stock: 72, stockKind: "fixed", body: 86, guard: 64, barrel: 50, mag: 34, lean: 8 },
  stevedore: { stock: 50, stockKind: "wire", body: 78, guard: 42, barrel: 14, mag: 46, lean: 5 },
  pilot: { stock: 80, stockKind: "precision", body: 90, guard: 72, barrel: 78, mag: 22, lean: 3, bipod: true, heavy: true },
  issue: { stock: 68, stockKind: "fixed", body: 84, guard: 54, barrel: 38, mag: 28, lean: 7 },
};

const W = 420;
const H = 124;
const r1 = (n: number) => Math.round(n * 10) / 10;

/** The drawing as SVG markup. `data-part` marks each fitted mod's shape, so the picture can be checked. */
export function gunSvg(frame: ArtFrame, mods: readonly ModId[] = []): string {
  const s = SPEC[frame];
  const has = (m: ModId) => mods.includes(m);
  const barrel = s.barrel + (has("barrel2") ? 30 : 0);
  const muzzle = has("comp") ? 24 : 11;
  const total = s.stock + s.body + s.guard + barrel + muzzle;
  const x0 = (W - total) / 2;
  const R = r1(x0 + s.stock); // receiver's rear
  const G = R + s.body; // handguard's rear
  const B = G + s.guard; // barrel's start
  const E = B + barrel; // muzzle's start
  const p: string[] = [];
  const body = 'class="ga-body"';
  const furn = 'class="ga-furn"';
  const cut = 'class="ga-cut"';
  const acc = 'class="ga-acc"';
  const line = 'class="ga-line"';

  // ground shadow
  p.push(`<ellipse cx="${W / 2}" cy="112" rx="${r1(total * 0.46)}" ry="4" class="ga-shadow"/>`);

  // barrel, then the muzzle device
  const bh = s.heavy ? 8 : 6;
  p.push(`<rect x="${B - 2}" y="${51 - bh / 2}" width="${barrel + 2}" height="${bh}" ${body}/>`);
  if (has("barrel2")) {
    p.push(`<g data-part="barrel2"><rect x="${E - 30}" y="${51 - bh / 2 - 1}" width="30" height="${bh + 2}" ${body}/>`);
    for (let i = 0; i < 4; i++) p.push(`<rect x="${E - 27 + i * 7}" y="50" width="4" height="2" ${acc}/>`);
    p.push("</g>");
  }
  if (has("comp")) {
    p.push(`<g data-part="comp"><rect x="${E}" y="44" width="24" height="14" rx="1.5" ${body}/>`);
    for (let i = 0; i < 3; i++) p.push(`<rect x="${E + 4 + i * 6}" y="46" width="3" height="10" ${cut}/>`);
    p.push(`<rect x="${E}" y="44" width="2.5" height="14" ${acc}/></g>`);
  } else {
    p.push(`<rect x="${E}" y="46.5" width="11" height="9" rx="1" ${body}/><rect x="${E + 3}" y="48" width="1.6" height="6" ${cut}/><rect x="${E + 6.5}" y="48" width="1.6" height="6" ${cut}/>`);
  }

  // bipod (the Pilot's), folded forward under the handguard
  if (s.bipod) {
    p.push(`<path d="M${B - 16} 58 L${B + 26} 69 M${B - 12} 58 L${B + 30} 66" ${line} stroke-width="2.6"/><rect x="${B - 20}" y="55" width="10" height="5" ${body}/>`);
  }

  // handguard with vent slots
  p.push(`<path d="M${G - 1} 41 H${B} V56 L${G + 8} 59 L${G - 1} 58 Z" ${furn}/>`);
  const slots = Math.floor((s.guard - 14) / 13);
  for (let i = 0; i < slots; i++) p.push(`<rect x="${G + 9 + i * 13}" y="46.5" width="8" height="3.2" rx="1.6" ${cut}/>`);
  p.push(`<path d="M${G + 4} 53.5 H${B - 4}" ${line} stroke-width=".8" opacity=".5"/>`);

  // the stock
  if (s.stockKind === "wire") {
    p.push(`<path d="M${R + 1} 45 H${R - s.stock + 4} M${R + 1} 59 L${R - s.stock + 6} 72" ${line} stroke-width="4"/>`);
    p.push(`<rect x="${R - s.stock}" y="40" width="6" height="36" rx="2" ${furn}/>`);
  } else if (s.stockKind === "precision") {
    const L = R - s.stock;
    p.push(`<path d="M${R + 1} 41 H${L + 8} L${L} 45 V78 H${L + 15} L${L + 28} 63 H${R - 8} L${R + 1} 60 Z" ${furn}/>`);
    p.push(`<path d="M${L + 24} 49 H${R - 22} L${R - 30} 57 H${L + 30} Z" ${cut}/>`);
    p.push(`<rect x="${L + 16}" y="34.5" width="${s.stock - 30}" height="7" rx="2" ${body}/>`);
    p.push(`<rect x="${L - 3}" y="44" width="4" height="35" rx="1.5" ${body}/>`);
  } else {
    const L = R - s.stock;
    p.push(`<path d="M${R + 1} 42 L${L + 10} 44 L${L} 46 V75 L${L + 11} 76 L${R - 15} 61 H${R + 1} Z" ${furn}/>`);
    p.push(`<rect x="${L - 3}" y="45" width="4" height="31" rx="1.5" ${body}/>`);
    p.push(`<path d="M${L + 14} 50 H${R - 18}" ${line} stroke-width=".8" opacity=".45"/>`);
  }

  // grip, trigger guard, trigger
  p.push(`<path d="M${R + 9} 62 L${R + 1} 87 Q${R} 91 ${R + 5} 91 H${R + 16} L${R + 25} 64 Z" ${furn}/>`);
  p.push(`<path d="M${R + 25} 64 Q${R + 27} 77 ${R + 37} 77 H${R + 46} L${R + 49} 64" ${line} stroke-width="1.8" fill="none"/>`);
  p.push(`<path d="M${R + 36} 64 Q${R + 34} 70 ${R + 37} 73" ${line} stroke-width="1.6" fill="none"/>`);

  // magazine
  const mx = R + 51;
  const ml = s.mag + (has("mag2") ? 14 : 0);
  p.push(`<g${has("mag2") ? ' data-part="mag2"' : ""}><path d="M${mx} 63 H${mx + 17} L${mx + 17 + s.lean} ${63 + ml} L${mx + s.lean - 1} ${65 + ml} Z" ${body}/>`);
  for (let i = 1; i <= Math.floor(ml / 11); i++) {
    const t = (i * 11) / ml;
    p.push(`<path d="M${r1(mx + 2 + s.lean * t)} ${63 + i * 11} H${r1(mx + 15 + s.lean * t)}" ${line} stroke-width=".8" opacity=".5"/>`);
  }
  if (has("mag2")) p.push(`<path d="M${mx + s.lean - 1} ${61 + ml} L${mx + 17 + s.lean} ${59 + ml} L${mx + 17 + s.lean} ${63 + ml} L${mx + s.lean - 1} ${65 + ml} Z" ${acc}/>`);
  p.push("</g>");

  // receiver, with its port, pins and selector
  p.push(`<path d="M${R} 40 H${G} V57 H${G - 9} L${G - 15} 64 H${R + 6} L${R} 61 Z" ${body}/>`);
  p.push(`<rect x="${r1(R + s.body * 0.46)}" y="44" width="21" height="6.5" rx="1" ${cut}/>`);
  p.push(`<circle cx="${R + 15}" cy="57.5" r="1.7" ${cut}/><circle cx="${G - 22}" cy="58" r="1.7" ${cut}/>`);
  p.push(`<path d="M${R + 26} 53 l5 -3" ${line} stroke-width="1.6"/>`);
  p.push(`<rect x="${R + 6}" y="46" width="13" height="2.4" ${acc}/>`);

  // top rail
  p.push(`<rect x="${R + 5}" y="36.5" width="${G - R + s.guard - 12}" height="3.6" ${body}/>`);
  for (let x = R + 9; x < B - 12; x += 6) p.push(`<rect x="${x}" y="36.5" width="2" height="1.6" ${cut}/>`);

  // sights, or the optic
  if (has("optic")) {
    const ox = R + 12;
    const ow = s.body - 6;
    p.push(`<g data-part="optic"><rect x="${ox + 10}" y="33" width="5" height="4" ${body}/><rect x="${ox + ow - 18}" y="33" width="5" height="4" ${body}/>`);
    p.push(`<rect x="${ox}" y="21" width="13" height="13" rx="2.5" ${body}/>`);
    p.push(`<rect x="${ox + 10}" y="23.5" width="${ow - 22}" height="8.5" rx="2" ${body}/>`);
    p.push(`<path d="M${ox + ow - 14} 23.5 L${ox + ow + 8} 20 V35.5 L${ox + ow - 14} 32 Z" ${body}/>`);
    p.push(`<rect x="${r1(ox + ow / 2 - 5)}" y="18.5" width="10" height="6" rx="1" ${body}/>`);
    p.push(`<rect x="${ox + ow + 6}" y="21" width="2.4" height="13.5" ${acc}/></g>`);
  } else {
    p.push(`<path d="M${B - 12} 37 L${B - 10} 27 H${B - 6} L${B - 4} 37 Z" ${body}/>`);
    p.push(`<path d="M${R + 12} 37 V31 H${R + 15} V34 H${R + 20} V31 H${R + 23} V37 Z" ${body}/>`);
  }

  return `<svg class="ga" viewBox="0 0 ${W} ${H}" data-frame="${frame}" role="img" aria-hidden="true" preserveAspectRatio="xMidYMid meet">${p.join("")}</svg>`;
}

/** The drawing in an element. */
export function gunArt(frame: ArtFrame, mods: readonly ModId[] = []): HTMLElement {
  const el = document.createElement("div");
  el.className = "d2-art";
  el.dataset.frame = frame;
  el.innerHTML = gunSvg(frame, mods);
  return el;
}
