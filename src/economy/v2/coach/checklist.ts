// The first raid's checklist, as rules with no DOM or three.js: which line is lit, when it ticks, and what the
// player has already been taught. One line is on screen at a time. A line ticks when the player does the thing, holds
// its tick for a moment, and the next one comes up. Anything the player did before its line came up is never shown:
// nobody is told what they have just done.
//
// What it remembers lives in localStorage `saltline.coach.v1`: whether a first raid has been completed (after which
// the checklist never returns, unless HOW TO PLAY turns it back on), which lines have been taught (so a retry after
// a death picks up where the last raid left off) and which once-ever moments have been seen.
import { ORDER, stepLine, type Device, type MomentId, type StepId } from "./copy";

export const COACH_KEY = "saltline.coach.v1";

export interface CoachMemory {
  v: 1;
  /** A first raid has reached the boat: the checklist is over. */
  done: boolean;
  /** Lines already taught. The raid's own three (the rifle, the uplinks, the boat) are asked again each raid. */
  taught: StepId[];
  /** Once-ever moments already seen. */
  seen: MomentId[];
}

type Store = Pick<Storage, "getItem" | "setItem">;
const MOMENTS: readonly MomentId[] = ["bailiff", "wreck", "death", "debrief"];
const fresh = (): CoachMemory => ({ v: 1, done: false, taught: [], seen: [] });

export function loadCoach(store: Store | null | undefined): CoachMemory {
  try {
    const raw = store?.getItem(COACH_KEY);
    if (!raw) return fresh();
    const m = JSON.parse(raw) as Partial<CoachMemory>;
    if (!m || m.v !== 1) return fresh();
    return {
      v: 1,
      done: m.done === true,
      taught: Array.isArray(m.taught) ? ORDER.filter((s) => (m.taught as unknown[]).includes(s)) : [],
      seen: Array.isArray(m.seen) ? MOMENTS.filter((s) => (m.seen as unknown[]).includes(s)) : [],
    };
  } catch {
    return fresh();
  }
}

export function saveCoach(store: Store | null | undefined, m: CoachMemory): void {
  try {
    store?.setItem(COACH_KEY, JSON.stringify(m));
  } catch {
    /* private mode or a full disk: remembered for this page only */
  }
}

/** Seconds and metres the lines are measured in. */
export const TUNE = {
  /** A ticked line stays this long before the next comes up. */
  tick: 1.1,
  /** MOVE is done after walking this far. */
  walk: 6,
  /** The invoice and cargo lines are done after this long on screen. */
  read: 4,
  /** The kit's line gives up after this long on screen. */
  kit: 20,
} as const;

/** Asked again every raid: the raid can't be played without them, whatever was taught before. */
const EACH_RAID: readonly StepId[] = ["rifle", "uplinks", "boat"];
/** Done by being read, not by an action. */
const READ: Partial<Record<StepId, number>> = { invoice: TUNE.read, cargo: TUNE.read, kit: TUNE.kit };

export type Did = "rifle" | "seal" | "alert" | "kill" | "reload" | "kit" | "uplinks" | "boat";

export interface ChecklistView {
  /** The line on screen, or null. */
  step: StepId | null;
  /** It has just been done and is showing its tick. */
  ticked: boolean;
  /** This raid's lines, in order, and which are done: the panel's pips. */
  steps: { id: StepId; done: boolean }[];
}

export class Checklist {
  private readonly done = new Set<StepId>();
  private signed = false;
  private device: Device = "kbm";
  private armed = false;
  private walked = 0;
  private weight = 0;
  private sealCut = false;
  private alerted = false;
  private shown: StepId | null = null;
  private shownFor = 0;
  private tickLeft = 0;

  /** `taught`: the lines an earlier raid taught. `onTaught` is told each time one more is. */
  constructor(
    taught: readonly StepId[] = [],
    private readonly onTaught: (id: StepId) => void = () => {},
  ) {
    for (const id of taught) if (!EACH_RAID.includes(id)) this.done.add(id);
  }

  /** A new raid. `signed`: it has an invoice and cargo (a raid off the books has neither, and skips their lines). */
  begin(o: { signed: boolean; device: Device }): void {
    for (const id of EACH_RAID) this.done.delete(id);
    this.signed = o.signed;
    this.device = o.device;
    this.armed = false;
    this.walked = 0;
    this.weight = 0;
    this.sealCut = false;
    this.alerted = false;
    this.shown = null;
    this.shownFor = 0;
    this.tickLeft = 0;
  }

  /** Something the player did (or, for `alert`, that a machine did). */
  did(what: Did): void {
    if (what === "rifle") ((this.armed = true), this.finish("rifle"));
    else if (what === "seal") ((this.sealCut = true), this.finish("seal"));
    else if (what === "alert") this.alerted = true;
    else if (what === "kill" || what === "reload") this.finish("fire");
    else this.finish(what);
  }
  /** Metres walked since the last frame. */
  walk(metres: number): void {
    if (!(metres > 0)) return;
    this.walked += metres;
    if (this.walked >= TUNE.walk) this.finish("move");
  }
  /** The weight carried now. */
  carry(weight: number): void {
    this.weight = weight;
  }

  private finish(id: StepId): void {
    if (this.done.has(id)) return;
    this.done.add(id);
    if (!EACH_RAID.includes(id)) this.onTaught(id);
  }

  /** Does this raid, on this input, have the line at all? */
  private applies(id: StepId): boolean {
    if ((id === "seal" || id === "invoice" || id === "cargo") && !this.signed) return false;
    return stepLine(id, this.device) !== null;
  }
  /** Has its moment come? */
  private ready(id: StepId): boolean {
    if (id === "rifle") return true;
    if (!this.armed) return false;
    if (id === "cargo") return this.weight > 0;
    if (id === "fire") return this.alerted || this.sealCut || !this.signed;
    return true;
  }
  private next(): StepId | null {
    // A machine has noticed the player: how to shoot is what matters now, whatever line was up.
    if (this.armed && this.alerted && !this.done.has("fire") && this.applies("fire")) return "fire";
    const id = ORDER.find((s) => !this.done.has(s) && this.applies(s));
    return id && this.ready(id) ? id : null;
  }

  /** Advances the clocks. `device` follows the input in use; a line is only on screen (and read) while `playing`. */
  tick(dt: number, o: { device: Device; playing: boolean }): ChecklistView {
    this.device = o.device;
    if (o.playing) {
      if (this.tickLeft > 0) {
        this.tickLeft -= dt;
        if (this.tickLeft <= 0) this.shown = null;
      } else if (this.shown && this.done.has(this.shown)) {
        this.tickLeft = TUNE.tick;
      }
      if (this.tickLeft <= 0) {
        const want = this.next();
        if (want !== this.shown) ((this.shown = want), (this.shownFor = 0));
        else if (this.shown) {
          this.shownFor += dt;
          const limit = READ[this.shown];
          if (limit !== undefined && this.shownFor >= limit) this.finish(this.shown);
        }
      }
    }
    return this.view;
  }

  get view(): ChecklistView {
    return {
      step: this.shown,
      ticked: this.tickLeft > 0,
      steps: ORDER.filter((s) => this.applies(s)).map((id) => ({ id, done: this.done.has(id) })),
    };
  }
}
