// What the coach says, and with which keys. A first raid is taught one line at a time, so every line is short and
// names the control for the input in the player's hands: keyboard and mouse, a gamepad, or touch. The bindings are
// game.js's own (its keymap, its gamepad table, its touch buttons); the kit (G, F) has no touch buttons and its charge
// no gamepad button, and the lines say so rather than name a button that isn't there.
import { FRAMES, ISSUE, RAID } from "../items";
import type { DeathBy, Weapon } from "../types";
import { FINISH, gunTag, money } from "../raid/rules";

export type Device = "kbm" | "pad" | "touch";
export type StepId = "rifle" | "move" | "seal" | "invoice" | "cargo" | "fire" | "kit" | "uplinks" | "boat";
export type MomentId = "bailiff" | "wreck" | "death" | "debrief";

/** The checklist, in the order it is taught. */
export const ORDER: readonly StepId[] = ["rifle", "move", "seal", "invoice", "cargo", "fire", "kit", "uplinks", "boat"];

/** A key cap. */
export interface Key {
  key: string;
}
export type Part = string | Key;
/** `LEAD — tail`: a line is one of these, or a few side by side (`FIRE — left mouse · AIM — right mouse`). */
export interface Pair {
  lead: Part[];
  tail: Part[];
}
export type Line = Pair[];

const k = (key: string): Key => ({ key });
const pair = (lead: Part | Part[], ...tail: Part[]): Pair => ({ lead: Array.isArray(lead) ? lead : [lead], tail });

/**
 * The input in use, from the same fields game.js's own prompt reads to choose between `E`, `Y` and `USE`
 * (hud.setPrompt: `input.touch ? "USE" : input.gamepad && !input.locked ? "Y" : "E"`).
 */
export function deviceOf(input: { touch?: boolean; gamepad?: boolean; locked?: boolean } | null | undefined): Device {
  return input?.touch ? "touch" : input?.gamepad && !input.locked ? "pad" : "kbm";
}

/** The interact control, as the game's prompt names it. */
export const USE: Record<Device, string> = { kbm: "E", pad: "Y", touch: "USE" };

export interface LineFacts {
  /** The invoice at which this raid's Harbormaster sends the Bailiff. */
  bailiffAt: number;
}

/** A step's line for this input, or null where the input has no control for it (the kit on touch). */
export function stepLine(id: StepId, device: Device, facts: LineFacts = { bailiffAt: 1200 }): Line | null {
  const use = k(USE[device]);
  switch (id) {
    case "rifle":
      return [pair("TAKE THE RIFLE", "hold ", use, " at the crate")];
    case "move":
      return device === "kbm"
        ? [pair("MOVE", k("W"), k("A"), k("S"), k("D")), pair("LOOK", "mouse")]
        : device === "pad"
          ? [pair("MOVE", "left stick"), pair("LOOK", "right stick")]
          : [pair("MOVE", "left thumb"), pair("LOOK", "right thumb")];
    case "seal":
      return [pair("A SEALED CONTAINER", "follow the marker, hold ", use, " to cut the seal")];
    case "invoice":
      return [pair("EVERYTHING GOES ON THE INVOICE", `at ${money(facts.bailiffAt)} it sends the Bailiff`)];
    case "cargo":
      return [pair("CARGO SLOWS YOU", `${RAID.carryLimit} is the limit`)];
    case "fire":
      return device === "kbm"
        ? [pair("FIRE", "left mouse"), pair("AIM", "right mouse"), pair("RELOAD", k("R"))]
        : device === "pad"
          ? [pair("FIRE", k("RT")), pair("AIM", k("LT")), pair("RELOAD", k("X"))]
          : [pair("FIRE", k("FIRE")), pair("AIM", k("AIM")), pair("RELOAD", k("RLD"))];
    case "kit":
      return device === "kbm" ? [pair(k("G"), "BREAKER CHARGE"), pair(k("F"), "RIFLE BUTT")] : device === "pad" ? [pair(k("RB"), "RIFLE BUTT"), pair("BREAKER CHARGE", k("G"), " on the keyboard")] : null;
    case "uplinks":
      return [pair("CUT THE THREE UPLINKS", "hold ", use, " at each")];
    case "boat":
      return [pair("THE BOAT", "quay ladder, south end")];
  }
}

const partsText = (parts: Part[]) => parts.map((p, i) => (typeof p === "string" ? p : (i > 0 && typeof parts[i - 1] !== "string" ? " " : "") + p.key)).join("");
/** A line as one string: `MOVE — W A S D · LOOK — mouse`. */
export const lineText = (line: Line) => line.map((p) => `${partsText(p.lead)} — ${partsText(p.tail)}`).join(" · ");

/** The moments outside the list: each is said once, ever. */
export const MOMENT: Record<"bailiff" | "wreck", { kicker: string; line: (device: Device) => Line }> = {
  bailiff: { kicker: "The Bailiff", line: () => [pair("IT CAN'T BE DESTROYED", "drop it with fire or a charge, then run")] },
  wreck: { kicker: "A wreck", line: (device) => [pair("ANOTHER BREACHER'S WRECK", "hold ", k(USE[device]), " to take what they lost")] },
};

export const PANEL = { kicker: "First raid", howTo: "How to play", debrief: "SELL AND BUILD AT THE DOCK" } as const;

/** The first death's card: what became of the gun, and where the next one comes from. */
export function deathLine(gun: Pick<Weapon, "frame" | "serial"> | null, by: DeathBy): string {
  if (!gun) return "THE ISSUE RIFLE IS NEVER LOST — it is back in the crate next raid.";
  return by === "bailiff"
    ? `${gunTag(gun).toUpperCase()} IS IMPOUNDED — buy it back at the DOCK within ${RAID.impoundHours} hours.`
    : `${gunTag(gun).toUpperCase()} STAYS WHERE YOU FELL — whoever carries it to the boat keeps it. Build or buy the next one at the DOCK.`;
}

/** What Control says as the rifle comes up: the raid's first line. */
export function firstLine(gun: Pick<Weapon, "frame" | "serial"> | null): string {
  return gun
    ? `${gunTag(gun)}. It's on your papers now: lose it in here and it stays in here. Uplinks first.`
    : "Issue rifle. Nobody can take that one off you. Uplinks first, and mind what you put on the invoice.";
}

/** The rifle lying in the crate: the gun this raid was signed with, or the issue rifle. */
export interface CrateGun {
  /** Stencilled on the crate's lid. */
  label: string;
  /** The furniture's colour (raid/rules.ts FINISH): the same the view model wears. */
  finish: number;
  issue: boolean;
}
export function crateGun(gun: Pick<Weapon, "frame" | "grade"> | null): CrateGun {
  if (!gun || !(gun.frame in FRAMES)) return { label: ISSUE.name.toUpperCase(), finish: FINISH.issue, issue: true };
  return { label: `${FRAMES[gun.frame].name} · ${gun.grade}`.toUpperCase(), finish: FINISH[gun.frame] ?? FINISH.issue, issue: false };
}
