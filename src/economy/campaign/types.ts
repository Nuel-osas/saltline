// The campaign's shared interfaces (docs/CAMPAIGN.md). Every lane builds against these: the runner, the mission
// scripts, the Bailiff, the arsenal, the score and the campaign's screens. Change this file and the doc together.
import type { Hooks } from "../hooks";
import type { Economy } from "../types";

/* eslint-disable @typescript-eslint/no-explicit-any -- the game context is the untyped bundle's G */
export type Game = any;

export interface V2 {
  x: number;
  z: number;
}
export interface V3 extends V2 {
  y: number;
}

// ---------------------------------------------------------------------------------------------------------------
// Missions

export type MissionId = "m1" | "m2" | "m3" | "m4" | "m5";
export const MISSION_IDS: readonly MissionId[] = ["m1", "m2", "m3", "m4", "m5"];

/** infiltrate: the uplinks. setpiece: the mission's own, holding the boat. extract: the boat is free. */
export type MissionPhase = "infiltrate" | "setpiece" | "extract" | "complete" | "failed";

/** A mission as data (missions.ts). The copy is docs/CAMPAIGN.md's, word for word. */
export interface MissionDef {
  id: MissionId;
  n: 1 | 2 | 3 | 4 | 5;
  title: string;
  /** The line under the title on the mission card and the docket. */
  line: string;
  /** Briefing cards, in order. Mission 1's are the opening's five. */
  briefing: string[];
  /** Control's line on the debrief card. `{callsign}` is filled in. */
  debrief: string;
  /** Breaker charges the player starts with. */
  charges: number;
  /** Mission 4: the port is dark. */
  blackout?: boolean;
  /** Mission 5: the Assessor arrives at the third cut. */
  boss?: boolean;
}

export type Speaker = "control" | "harbormaster" | "bailiff";

/** What a mission script is handed at the start of its run. */
export interface MissionCtx {
  G: Game;
  economy: Economy;
  def: MissionDef;
  hooks: Hooks;
  /** Seeded from the run, so a mission plays the same for the same seed. */
  rng: { range(a: number, b: number): number; int(a: number, b: number): number; pick<T>(xs: readonly T[]): T };
  /** Queues a radio line; `{callsign}` is filled in. It waits for a quiet radio and is dropped if it goes stale. */
  say(who: Speaker, text: string, opts?: { seconds?: number; ttlMs?: number }): void;
  /** Sets the HUD's objective line for the set piece (`progress` 0–1 draws a bar where the HUD has one). */
  objective(text: string, progress?: number | null): void;
  /** The Bailiff and the arsenal, when those modules are running; null otherwise (the script must cope). */
  bailiff: BailiffApi | null;
  arsenal: ArsenalApi | null;
}

/** One mission's behaviour (m1.ts … m5.ts). The runner calls it; every method is guarded by the runner. */
export interface MissionScript {
  /** The run has started (after the reset, before play). */
  start(ctx: MissionCtx): void;
  /** An uplink was cut: `count` of `total` are now dark. */
  relayCut?(count: number, total: number): void;
  /** The last uplink is dark: the set piece begins. */
  allCut?(): void;
  update?(dt: number): void;
  /** True while the set piece still holds the boat. The runner registers it as a boat gate. */
  blocked?(): boolean;
  /** The run is over (boat, death, restart or quit): remove everything this script made. */
  dispose(): void;
}

export interface Best {
  rating: string;
  /** Seconds. */
  time: number;
}

/** Saved in localStorage as saltline.campaign.v1. */
export interface Progress {
  cleared: MissionId[];
  /** The first mission not yet cleared, or m5 once all are. */
  current: MissionId;
  best: Partial<Record<MissionId, Best>>;
  /** Missions whose briefing has been shown. */
  briefed: MissionId[];
  /** Mission 5 cleared and the ending seen. */
  finished: boolean;
}

export interface ActiveMission {
  def: MissionDef;
  phase: MissionPhase;
  objective: string;
  /** 0–1 where the set piece has a measure, else null. */
  progress: number | null;
}

/** G.campaign */
export interface CampaignApi {
  readonly missions: readonly MissionDef[];
  progress(): Progress;
  unlocked(id: MissionId): boolean;
  /** The mission the next DEPLOY starts: `current`, unless the docket or ?mission= picked another. */
  selected(): MissionDef;
  /** Picks an unlocked mission for the next DEPLOY. False if it is locked. */
  select(id: MissionId): boolean;
  /** The mission of the run in play, or null between runs. */
  active(): ActiveMission | null;
  /** Gives a mission its script. A mission without one plays as mission 1 does. */
  register(id: MissionId, make: () => MissionScript): void;
  /** Marks the ending as seen (the ending screen calls it). */
  finish(): void;
  /** Forgets all progress. */
  reset(): void;
}

// ---------------------------------------------------------------------------------------------------------------
// The Bailiff (src/economy/bailiff)

export type BailiffState = "rising" | "walking" | "windup" | "recovering" | "staggered";

export interface BailiffHandle {
  readonly id: number;
  readonly pos: V3;
  readonly state: BailiffState;
  /** True unless it is staggered (on a knee). */
  readonly standing: boolean;
  /** Drops it now (a breaker charge does this). */
  stagger(seconds?: number): void;
  remove(): void;
}

/** G.bailiff */
export interface BailiffApi {
  /** Stands one up at `at` (it rises for about 2 s first). `delay` waits that many seconds before it appears. */
  spawn(opts: { at: V2; delay?: number }): BailiffHandle;
  readonly list: readonly BailiffHandle[];
  /** True while any Bailiff is on its feet. */
  anyStanding(): boolean;
  /** The nearest one to the player and its distance in metres, or null when there are none. */
  nearest(): { handle: BailiffHandle; dist: number } | null;
  /** Removes them all (the run is over). */
  clear(): void;
}

// ---------------------------------------------------------------------------------------------------------------
// The arsenal (src/economy/arsenal)

export type PickupKind = "ammo" | "med" | "charge";

/** G.arsenal */
export interface ArsenalApi {
  charges(): number;
  setCharges(n: number): void;
  addCharges(n: number): void;
  /** Puts one pickup on the ground at `at`. */
  spawnPickup(kind: PickupKind, at: V2): void;
  /** Places `count` supply lockers at seeded spots for this run. */
  placeLockers(seed: number, count: number): void;
  /** Removes every pickup and locker (the run is over). */
  clear(): void;
}

// ---------------------------------------------------------------------------------------------------------------
// The score (src/economy/score)

export type ScoreState = "title" | "infiltrate" | "combat" | "stalker" | "setpiece" | "boss" | "clear" | "debrief" | "dead" | "ending" | "silent";

/** G.score. It follows the game's events by itself; `hold` lets a screen pin a state (the ending). */
export interface ScoreApi {
  state(): ScoreState;
  hold(state: ScoreState | null): void;
}

// ---------------------------------------------------------------------------------------------------------------
// Events on G.events (noun:verb, like the baseline's)

export interface CampaignEvents {
  "mission:start": { id: MissionId; n: number; retries: number };
  "mission:phase": { id: MissionId; phase: MissionPhase };
  "mission:objective": { id: MissionId; text: string; progress: number | null };
  "mission:complete": { id: MissionId; rating: string | null; time: number; first: boolean };
  "mission:failed": { id: MissionId };
  "campaign:progress": Progress;
  "bailiff:spawned": { id: number; pos: V3 };
  "bailiff:staggered": { id: number; seconds: number; by: "damage" | "charge" | "script" };
  "bailiff:recovered": { id: number };
  "bailiff:grab": { id: number; damage: number };
  /** Sent about twice a second while one is within 30 m. `standing` is false while it is on a knee. */
  "bailiff:near": { id: number; dist: number; standing: boolean };
  "emp:detonated": { pos: V3; radius: number };
  "pickup:taken": { kind: PickupKind; amount: number };
  "score:state": { state: ScoreState };
}
