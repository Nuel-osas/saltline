// The Harbormaster's extra drones (src/economy/story/waves.ts): the split, the caps, and none unless Act III is read.
import { describe, expect, it } from "vitest";
import { createMockChain } from "../src/economy/mock";
import { bonusOf, createTownReader } from "../src/economy/story/town";
import { waveBonus } from "../src/economy/story/waves";
import { FAILED, MISSING, ok, view } from "./story-fixtures";

describe("the Harbormaster's extra drones", () => {
  it("splits the bonus with at most a hound per two gulls, capped at four", () => {
    expect([0, 1, 2, 3, 4].map(waveBonus)).toEqual([
      { gull: 0, hound: 0, alive: 0 },
      { gull: 1, hound: 0, alive: 1 },
      { gull: 2, hound: 0, alive: 2 },
      { gull: 2, hound: 1, alive: 3 },
      { gull: 3, hound: 1, alive: 4 },
    ]);
    for (const n of [0, 1, 2, 3, 4]) {
      const b = waveBonus(n);
      expect(b.hound * 2).toBeLessThanOrEqual(b.gull);
    }
    expect(waveBonus(9)).toEqual(waveBonus(4));
    expect(waveBonus(-2)).toEqual(waveBonus(0));
    expect(waveBonus(Number.NaN)).toEqual(waveBonus(0));
    expect(waveBonus(2.9)).toEqual(waveBonus(2));
  });

  it("takes the bonus from Act III only; unknown means none", () => {
    expect(bonusOf(ok(view(3, { strength: 100 })))).toBe(4);
    expect(bonusOf(ok(view(3, { strength: 60, bonus: 9 })))).toBe(4);
    expect(bonusOf(ok(view(3, { strength: 24 })))).toBe(0);
    expect(bonusOf(ok(view(2, { bonus: 3 })))).toBe(0);
    expect(bonusOf(MISSING)).toBe(0);
    expect(bonusOf(FAILED)).toBe(0);
    expect(bonusOf(null)).toBe(0);
  });

  it("reads the offline mock's town: two extra gulls a wave at its Act III, none before", async () => {
    const at = async (act: 1 | 2 | 3) => createTownReader(createMockChain(5, { storage: null, act })).read();
    const three = await at(3);
    expect(three).toMatchObject({ status: "ok", view: { act: 3, harbormaster: { strength: 62, bonusDrones: 2 } } });
    expect(waveBonus(bonusOf(three))).toEqual({ gull: 2, hound: 0, alive: 2 });
    expect(bonusOf(await at(2))).toBe(0);
    expect(bonusOf(await at(1))).toBe(0);
  });
});
