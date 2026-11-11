// Shared fixtures for the story tests (test/story-*.test.ts): town views per act and the reads the story makes of them.
import type { RunStartInput } from "../src/economy/story/lines";
import type { TownRead } from "../src/economy/story/town";
import type { TownView } from "../src/economy/types";

export function view(act: 1 | 2 | 3, o: { clinic?: boolean; generators?: boolean; strength?: number; bonus?: number } = {}): TownView {
  const lit = act >= 2;
  const strength = o.strength ?? 0;
  return {
    act,
    delivered: {},
    districts: [
      { id: "clinic", tokenId: "meds", need: 15, have: 15, lit: o.clinic ?? lit, litAt: null },
      { id: "generators", tokenId: "fuel", need: 10, have: 10, lit: o.generators ?? lit, litAt: null },
    ],
    client: { need: 8, have: act === 3 ? 8 : 0, revealed: act === 3, revealedAt: null },
    harbormaster: { strength, recentCores: strength * 100, bonusDrones: o.bonus ?? Math.floor(strength / 25) },
  };
}
export const ok = (v: TownView): TownRead => ({ status: "ok", view: v, at: 0 });
export const MISSING: TownRead = { status: "missing", at: 0 };
export const FAILED: TownRead = { status: "failed", why: "timeout", at: 0 };
export const input = (read: TownRead | null, o: Partial<RunStartInput> = {}): RunStartInput => ({
  read,
  heard: [],
  session: [],
  peak: 0,
  cores24h: null,
  ...o,
});
export const texts = (r: { lines: { text: string }[] }) => r.lines.map((l) => l.text);
