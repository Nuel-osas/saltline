// Which music plays: a pure function of the game's events and the time (docs/CAMPAIGN.md → The score's table). No
// audio here. The caller feeds it events with a clock in seconds and reads it back; the engine plays what it reads.
//
// It works with the campaign's events (mission:phase, bailiff:near) and without them: a plain run still moves from
// infiltrate to combat and back, hears the boat come free at the last uplink, and ends on the debrief or dead card.
import type { ScoreState } from "../campaign/types";
import { STALKER } from "./theme";

/** A fight is over this long after the last shot or alert. */
export const QUIET_SECONDS = 6;
/** How long the resolve plays when the boat comes free (two bars and a breath). */
export const CLEAR_SECONDS = 8;
/** A Bailiff not heard from for this long has gone (bailiff:near comes twice a second). */
export const NEAR_STALE = 1.5;
/** The wait after the last uplink for the campaign or the boss to claim the moment, before it is the boat's. */
const CLAIM_SECONDS = 0.25;
const HEAT_FADE = 5;

/** The states the engine has music for: every ScoreState but the overlay and silence. */
export type BaseState = Exclude<ScoreState, "stalker">;

export interface Reading {
  /** What G.score.state() reports: `stalker` while a standing Bailiff is within range, else the base. */
  state: ScoreState;
  /** The music under any Bailiff. */
  base: BaseState;
  /** The Bailiff's layer: 0 off, 1 standing and near, in between on a knee. */
  stalker: number;
  /** Heartbeats a minute, or 0 for none. */
  heartBpm: number;
  /** 0–1: how hot the fight is. */
  intensity: number;
}

export interface Probes {
  /** The Assessor is arriving or fighting (G.boss.fight). */
  boss?: boolean;
}

export interface Director {
  /** An event from G.events, at `now` seconds. Unknown names are ignored. */
  event(name: string, payload: unknown, now: number): void;
  read(now: number, probes?: Probes): Reading;
  hold(state: ScoreState | null): void;
}

/** Heartbeats a minute for a standing Bailiff `dist` metres away: slow at 25 m, racing at 3 m. */
export function heartRate(dist: number): number {
  const t = Math.min(1, Math.max(0, (STALKER.far - dist) / (STALKER.far - STALKER.close)));
  return STALKER.slow + (STALKER.fast - STALKER.slow) * t;
}

const IN_RUN: ReadonlySet<BaseState> = new Set<BaseState>(["infiltrate", "combat", "setpiece", "boss", "clear"]);

export function createDirector(): Director {
  let game = "title";
  let dock = false;
  let phase: string | null = null;
  let held: ScoreState | null = null;
  let heat = 0;
  let heatAt = 0;
  let lastHot = -Infinity;
  let clearUntil = -Infinity;
  /** The last uplink went dark at this time and nobody has claimed the moment yet. */
  let allCutAt: number | null = null;
  let bossWas = false;
  let bossDone = false;
  const near = new Map<number, { dist: number; standing: boolean; at: number }>();

  const heatNow = (now: number) => heat * Math.exp(-Math.max(0, now - heatAt) / HEAT_FADE);
  const warm = (now: number, to: number, add = 0) => {
    heat = Math.min(1, Math.max(heatNow(now), to) + add);
    heatAt = now;
    lastHot = now;
  };
  const free = (now: number) => {
    if (now >= clearUntil) clearUntil = now + CLEAR_SECONDS;
    allCutAt = null;
  };
  const resetRun = () => {
    phase = null;
    heat = 0;
    lastHot = -Infinity;
    clearUntil = -Infinity;
    allCutAt = null;
    bossWas = false;
    bossDone = false;
    near.clear();
  };

  function event(name: string, payload: unknown, now: number): void {
    const e = (payload ?? {}) as Record<string, unknown>;
    switch (name) {
      case "game:state": {
        const next = typeof e.state === "string" ? e.state : game;
        // A new run (not a resume from pause) starts clean; leaving a run forgets its fight.
        if (next === "title" || ((next === "playing" || next === "intro") && game !== "paused" && game !== "intro")) resetRun();
        game = next;
        break;
      }
      case "run:start":
        resetRun();
        break;
      case "dock:open":
        dock = true;
        break;
      case "dock:close":
        dock = false;
        break;
      case "mission:start":
        resetRun();
        phase = "infiltrate";
        break;
      case "mission:phase":
        phase = typeof e.phase === "string" ? e.phase : phase;
        allCutAt = null; // the campaign is running this moment
        if (phase === "extract") free(now);
        break;
      case "objective:all":
        allCutAt = now;
        break;
      case "weapon:fire":
        warm(now, 0, 0.06);
        break;
      case "player:hitEnemy":
        warm(now, 0, 0.03);
        break;
      case "enemy:alert":
      case "enemy:telegraph":
        warm(now, 0.6);
        break;
      case "enemy:fire":
        warm(now, 0.6, 0.05);
        break;
      case "player:hit":
        warm(now, 0.6, 0.15);
        break;
      case "explosion":
        warm(now, 0.7);
        break;
      case "bailiff:near":
        if (typeof e.id === "number" && typeof e.dist === "number" && Number.isFinite(e.dist)) near.set(e.id, { dist: e.dist, standing: e.standing !== false, at: now });
        break;
      case "bailiff:staggered":
      case "bailiff:recovered": {
        const b = typeof e.id === "number" ? near.get(e.id) : undefined;
        if (b) b.standing = name === "bailiff:recovered";
        break;
      }
    }
  }

  function base(now: number, boss: boolean): BaseState {
    if (dock) return "title";
    switch (game) {
      case "title":
        return "title";
      case "intro":
        return "infiltrate";
      case "dead":
        return "dead";
      case "complete":
        return "debrief";
      case "playing":
      case "paused":
        if (phase === "failed") return "dead";
        if (phase === "complete") return "debrief";
        if (boss) return "boss";
        if (now < clearUntil) return "clear";
        if (phase === "setpiece" && !bossDone) return "setpiece";
        return now - lastHot < QUIET_SECONDS ? "combat" : "infiltrate";
      default:
        return "silent";
    }
  }

  function read(now: number, probes: Probes = {}): Reading {
    const boss = !!probes.boss && (game === "playing" || game === "paused");
    // The Assessor falling frees the boat, whatever the campaign's phase still says.
    if (bossWas && !boss && (game === "playing" || game === "paused")) {
      bossDone = true;
      free(now);
    }
    bossWas = boss;
    if (boss) allCutAt = null;
    // A plain run: the last uplink is cut and neither a set piece nor the boss took the moment, so the boat is free.
    if (allCutAt !== null && now - allCutAt >= CLAIM_SECONDS) {
      if (game === "playing" && phase !== "setpiece") free(now);
      allCutAt = null;
    }

    if (held && held !== "stalker") return { state: held, base: held, stalker: 0, heartBpm: 0, intensity: held === "combat" ? 1 : 0 };
    const b = held === "stalker" ? "infiltrate" : base(now, boss);
    const intensity = b === "boss" || b === "setpiece" ? 1 : b === "combat" ? Math.min(1, Math.max(0.3, heatNow(now))) : 0;

    // The nearest Bailiff still being reported: a standing one hunts, one on a knee only breathes.
    let standing = Infinity;
    let kneeling = Infinity;
    for (const [id, n] of near) {
      if (now - n.at > NEAR_STALE) near.delete(id);
      else if (n.dist <= STALKER.far) n.standing ? (standing = Math.min(standing, n.dist)) : (kneeling = Math.min(kneeling, n.dist));
    }
    if (held === "stalker") standing = Math.min(standing, 10);
    if (!IN_RUN.has(b) || (standing === Infinity && kneeling === Infinity)) return { state: b, base: b, stalker: 0, heartBpm: 0, intensity };
    if (standing < Infinity) return { state: "stalker", base: b, stalker: 1, heartBpm: heartRate(standing), intensity };
    return { state: b, base: b, stalker: STALKER.kneeLevel, heartBpm: STALKER.kneeBpm, intensity };
  }

  return {
    event,
    read,
    hold(state) {
      held = state;
    },
  };
}

/** The events the director listens to. */
export const EVENTS = [
  "game:state",
  "run:start",
  "dock:open",
  "dock:close",
  "mission:start",
  "mission:phase",
  "objective:all",
  "weapon:fire",
  "player:hitEnemy",
  "enemy:alert",
  "enemy:telegraph",
  "enemy:fire",
  "player:hit",
  "explosion",
  "bailiff:near",
  "bailiff:staggered",
  "bailiff:recovered",
] as const;

/** About how long a radio line is up, for the duck under it: it types at 58 characters a second, then holds. */
export const radioSeconds = (text: unknown): number => Math.min(8, Math.max(2, (typeof text === "string" ? text.length : 0) / 58 + 2.2));

/** Whether the score may sound at all: not with ?noaudio or the game's silent audio, at volume 0, or in a hidden tab. */
export function audible(c: { muted: boolean; volume: number; hidden: boolean; context: string | null }): boolean {
  return !c.muted && c.volume > 0 && !c.hidden && c.context === "running";
}
