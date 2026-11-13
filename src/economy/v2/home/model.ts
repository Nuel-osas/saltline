// The lobby's rules, as pure functions (home/index.ts draws them): the player's rank, which "start here" step is
// showing, and what the one big button says and does.

/** Ranks by raids brought home (the contract's `extractions`). Status only: a rank changes nothing in a raid. */
export const RANKS: readonly { at: number; name: string }[] = [
  { at: 0, name: "Casual" },
  { at: 1, name: "Docker" },
  { at: 3, name: "Stevedore" },
  { at: 6, name: "Breacher" },
  { at: 10, name: "Foreman" },
  { at: 15, name: "Pilot" },
];

export interface Rank {
  /** 1 for Casual, up to RANKS.length. */
  level: number;
  name: string;
  /** Raids home since this rank began, and how many this rank takes. At the top rank the two are equal. */
  into: number;
  need: number;
}

export function rankOf(extractions: number | null | undefined): Rank {
  const n = Number.isFinite(extractions) ? Math.max(0, Math.floor(extractions as number)) : 0;
  let i = 0;
  while (i + 1 < RANKS.length && n >= RANKS[i + 1].at) i++;
  const next = RANKS[i + 1];
  if (!next) return { level: i + 1, name: RANKS[i].name, into: 1, need: 1 };
  return { level: i + 1, name: RANKS[i].name, into: n - RANKS[i].at, need: next.at - RANKS[i].at };
}

export type Mode = "raid" | "practice" | "film";
export type Do = "signin" | "deploy" | "practice" | "online" | "film" | "vendors";

/** What the lobby knows. A null is "unknown" (a read that hasn't answered or failed), never "no". */
export interface Facts {
  /** The offline game (?mock): nothing here is on the chain. */
  offline: boolean;
  /** This build asks players to sign in. */
  loginOn: boolean;
  signedIn: boolean;
  extractions: number | null;
  /** They have opened Practice before (kept on the device). */
  practised: boolean;
  /** The gun going over the fence, for the button's caption. */
  gun: string;
}

export interface Action {
  label: string;
  caption: string;
  do: Do;
}

/** The one big button, for the mode picked. Its label is always the next step, as on a shooter's lobby. */
export function actionFor(mode: Mode, f: Facts): Action {
  if (mode === "film") return { label: "Watch", caption: "The opening · 48 seconds", do: "film" };
  if (mode === "practice") {
    return f.offline ? { label: "Deploy", caption: `Practice · with the ${f.gun}`, do: "deploy" } : { label: "Play practice", caption: "Offline · nothing at stake", do: "practice" };
  }
  if (f.offline) return { label: "Go on chain", caption: "Raid · leave practice", do: "online" };
  if (f.loginOn && !f.signedIn) return { label: "Sign in", caption: "Raid · sign in first", do: "signin" };
  return { label: "Deploy", caption: `Raid · with the ${f.gun}`, do: "deploy" };
}

export interface Step {
  n: 1 | 2 | 3 | 4;
  text: string;
  button: string;
  do: Do;
}

/** "Start here": four steps, one at a time. Null when there is nothing left to point at. */
export function startStep(f: Facts): Step | null {
  if (f.offline) {
    if ((f.extractions ?? 0) < 1) return { n: 3, text: "Take the rifle over the fence. Nothing here is at stake.", button: "Deploy", do: "deploy" };
    return { n: 4, text: "You got out. Sell what you carried at the dock.", button: "Open vendors", do: "vendors" };
  }
  if (f.loginOn && !f.signedIn) {
    if (!f.practised) return { n: 1, text: "Start with Practice: free, no sign-in.", button: "Play practice", do: "practice" };
    return { n: 2, text: "Sign in for your dock pass. An email is enough.", button: "Sign in", do: "signin" };
  }
  if (f.extractions == null) return null; // unknown: say nothing rather than guess
  if (f.extractions < 1) return { n: 3, text: "Take the rifle over the fence, and reach the boat.", button: "Deploy", do: "deploy" };
  if (f.extractions < 3) return { n: 4, text: "Sell what you carried out, then build a gun of your own.", button: "Open vendors", do: "vendors" };
  return null;
}

/** Which mode the lobby opens on: Practice in the offline game, the raid otherwise. */
export const defaultMode = (offline: boolean): Mode => (offline ? "practice" : "raid");
