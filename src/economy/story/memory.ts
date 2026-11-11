// What this player has already seen and heard, in localStorage `saltline.story.v1`, so the once-only beats (the
// briefing, the lights coming on, the reveal) stay once-only across visits. A missing, unreadable or foreign value
// starts fresh; a storage that refuses writes keeps the memory for this page only.
export const STORY_KEY = "saltline.story.v1";

export interface StoryMemory {
  v: 1;
  /** The opening briefing has been shown (played through or skipped). */
  briefed: boolean;
  /** Once-only lines already said: "act2", "reveal". */
  heard: string[];
  /** The Harbormaster's highest strength seen since it last said the town had stopped selling. */
  peak: number;
}

type Store = Pick<Storage, "getItem" | "setItem">;

const fresh = (): StoryMemory => ({ v: 1, briefed: false, heard: [], peak: 0 });

export function loadMemory(store: Store | null | undefined): StoryMemory {
  try {
    const raw = store?.getItem(STORY_KEY);
    if (!raw) return fresh();
    const m = JSON.parse(raw) as Partial<StoryMemory>;
    if (!m || m.v !== 1) return fresh();
    return {
      v: 1,
      briefed: m.briefed === true,
      heard: Array.isArray(m.heard) ? m.heard.filter((h): h is string => typeof h === "string").slice(0, 32) : [],
      peak: typeof m.peak === "number" && Number.isFinite(m.peak) ? Math.max(0, Math.min(100, m.peak)) : 0,
    };
  } catch {
    return fresh();
  }
}

export function saveMemory(store: Store | null | undefined, m: StoryMemory): void {
  try {
    store?.setItem(STORY_KEY, JSON.stringify(m));
  } catch {
    /* private mode or a full disk: remembered for this page only */
  }
}

/** localStorage, or null where touching it throws. */
export function defaultStore(): Store | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}
