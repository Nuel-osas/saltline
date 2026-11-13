// Shared registries over two of game.js's single-slot `// ext:` hooks, so more than one system can use each:
//   G.ext.raycast(origin, dir, maxDist)   the player's shots: the nearest hit among every registered target wins
//   G.ext.extractBlocked()                the boat: it holds off while any registered gate says so
// The Assessor, the Bailiff and the missions' set pieces all register here instead of assigning the slots.
// (G.ext.interact stays the salvage module's, and G.ext.beforeRun the story's briefing.)

/* eslint-disable @typescript-eslint/no-explicit-any -- the game context is the untyped bundle's G */
type Game = any;

/** What game.js's playerShot takes back from G.ext.raycast: at least the distance along the ray. */
export interface ShotHit {
  dist: number;
}
export type ShotTarget = (origin: any, dir: any, maxDist: number) => ShotHit | null | undefined;
export type BoatGate = () => boolean;

export interface Hooks {
  /** Adds something the player's shots can hit. Returns its remover. */
  addShotTarget(fn: ShotTarget): () => void;
  /** Adds a reason the boat holds off. Returns its remover. */
  addBoatGate(fn: BoatGate): () => void;
  readonly shotTargets: number;
  readonly boatGates: number;
}

const KEY = "__hooks";

/** The registries for this game context, created and wired into G.ext on first use. */
export function hooks(G: Game): Hooks {
  const ext = (G.ext ??= {});
  if (ext[KEY]) return ext[KEY] as Hooks;
  const targets = new Set<ShotTarget>();
  const gates = new Set<BoatGate>();
  const safe = <T>(fn: () => T, fallback: T): T => {
    try {
      return fn();
    } catch (e) {
      console.warn("[hooks]", e);
      return fallback;
    }
  };
  ext.raycast = (origin: any, dir: any, max: number) => {
    let best: ShotHit | null = null;
    for (const t of targets) {
      const hit = safe(() => t(origin, dir, best ? best.dist : max), null);
      if (hit && typeof hit.dist === "number" && hit.dist <= (best ? best.dist : max)) best = hit;
    }
    return best;
  };
  ext.extractBlocked = () => {
    let blocked = false;
    for (const g of gates) if (safe(g, false)) blocked = true; // every gate is asked: each may show its own hint
    return blocked;
  };
  const api: Hooks = {
    addShotTarget(fn) {
      targets.add(fn);
      return () => void targets.delete(fn);
    },
    addBoatGate(fn) {
      gates.add(fn);
      return () => void gates.delete(fn);
    },
    get shotTargets() {
      return targets.size;
    },
    get boatGates() {
      return gates.size;
    },
  };
  ext[KEY] = api;
  return api;
}
