// The town's arc as the story reads it (docs/STORY.md → The arc; types.ts → TownView).
//
// - `Chain.town()` is optional. A chain without it is the story's start: Act I, strength 0, every light dark.
// - A read that fails, times out or comes back malformed is unknown. The game then plays as Act I (no extra drones,
//   no Harbormaster), and every line that needs the town's state is dropped rather than guessed.
// - The offline mock's `?act=1|2|3` (mock.ts) puts its town at an act for screenshots; this reads it like any chain.
import type { Chain, District, TownView } from "../types";

export type TownRead =
  | { status: "ok"; view: TownView; at: number }
  /** The chain has no town() yet: the start of the story, by definition. */
  | { status: "missing"; at: number }
  /** No answer, or one that doesn't hold together. Unknown, never zero. */
  | { status: "failed"; why: string; at: number };

/** Most drones the Harbormaster can add to a wave (STORY.md: floor(strength / 25), so 0–4). */
export const MAX_BONUS = 4;

const isInt = (n: unknown, lo: number, hi: number): n is number =>
  typeof n === "number" && Number.isInteger(n) && n >= lo && n <= hi;
const isCount = (n: unknown): n is number => typeof n === "number" && Number.isSafeInteger(n) && n >= 0;

/**
 * The view if the parts the story reads hold together (act, the districts' lights, the Harbormaster's strength and
 * bonus), else null: a read that fails closed.
 */
export function checkTown(raw: unknown): TownView | null {
  if (!raw || typeof raw !== "object") return null;
  const v = raw as Partial<TownView>;
  if (v.act !== 1 && v.act !== 2 && v.act !== 3) return null;
  if (!Array.isArray(v.districts)) return null;
  for (const d of v.districts as Partial<District>[]) {
    if (!d || (d.id !== "clinic" && d.id !== "generators") || typeof d.lit !== "boolean") return null;
    if (!isCount(d.need) || !isCount(d.have)) return null;
  }
  const hm = v.harbormaster;
  if (!hm || !isInt(hm.strength, 0, 100) || !isInt(hm.bonusDrones, 0, 1000)) return null;
  return v as TownView;
}

export const actOf = (r: TownRead | null): 1 | 2 | 3 => (r && r.status === "ok" ? r.view.act : 1);
/** True when the state is known: read, or known to be the start because the chain has no town() yet. */
export const known = (r: TownRead | null): boolean => !!r && r.status !== "failed";
/** The Harbormaster's strength: 0 before Act III and whenever the town is unknown. */
export const strengthOf = (r: TownRead | null): number =>
  r && r.status === "ok" && r.view.act === 3 ? r.view.harbormaster.strength : 0;
/** Extra drones per wave: the contract's bonus_drones in Act III, capped at 4; 0 otherwise or when unknown. */
export const bonusOf = (r: TownRead | null): number =>
  r && r.status === "ok" && r.view.act === 3 ? Math.min(MAX_BONUS, r.view.harbormaster.bonusDrones) : 0;

export interface TownReaderOptions {
  now?: () => number;
}

export interface TownReader {
  /** The last read, if any. */
  readonly last: TownRead | null;
  /** A read no older than `maxAge` ms, or a fresh one that gives up after `timeout` ms (a timeout is a failed read). */
  read(opts?: { maxAge?: number; timeout?: number }): Promise<TownRead>;
}

export function createTownReader(chain: Pick<Chain, "town">, opts: TownReaderOptions = {}): TownReader {
  const now = opts.now ?? Date.now;
  let last: TownRead | null = null;
  let inflight: Promise<TownRead> | null = null;

  function fetch(timeout: number): Promise<TownRead> {
    if (typeof chain.town !== "function") return Promise.resolve({ status: "missing", at: now() });
    let p: Promise<unknown>;
    try {
      p = Promise.resolve(chain.town());
    } catch (e) {
      p = Promise.reject(e);
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<TownRead>((ok) => {
      timer = setTimeout(() => ok({ status: "failed", why: "timeout", at: now() }), timeout);
    });
    const answer = p.then(
      (raw): TownRead => {
        const view = checkTown(raw);
        return view ? { status: "ok", view, at: now() } : { status: "failed", why: "malformed", at: now() };
      },
      (e): TownRead => ({ status: "failed", why: String((e && (e as Error).message) || e), at: now() }),
    );
    return Promise.race([answer, late]).finally(() => clearTimeout(timer));
  }

  return {
    get last() {
      return last;
    },
    read({ maxAge = 15_000, timeout = 2_500 } = {}) {
      if (last && last.status !== "failed" && now() - last.at <= maxAge) return Promise.resolve(last);
      if (inflight) return inflight;
      inflight = fetch(timeout).then((r) => {
        inflight = null;
        last = r;
        return r;
      });
      return inflight;
    },
  };
}
