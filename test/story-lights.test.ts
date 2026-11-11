// The lights across the water (src/economy/story/lights.ts): what the far shore shows for each read of the town.
import { describe, expect, it } from "vitest";
import { createMockChain } from "../src/economy/mock";
import { lightsOf } from "../src/economy/story/lights";
import { createTownReader } from "../src/economy/story/town";
import { FAILED, MISSING, ok, view } from "./story-fixtures";

describe("the lights across the water", () => {
  it("follow the districts, dark at the start, unchanged on a failed read", () => {
    expect(lightsOf(MISSING)).toEqual({ clinic: false, generators: false });
    expect(lightsOf(ok(view(1)))).toEqual({ clinic: false, generators: false });
    expect(lightsOf(ok(view(1, { clinic: true })))).toEqual({ clinic: true, generators: false });
    expect(lightsOf(ok(view(2)))).toEqual({ clinic: true, generators: true });
    expect(lightsOf(ok(view(3)))).toEqual({ clinic: true, generators: true });
    expect(lightsOf(FAILED)).toBeNull();
    expect(lightsOf(null)).toBeNull();
  });

  it("are dark at the offline mock's Act I and lit from its Act II", async () => {
    const at = async (act: 1 | 2 | 3) => lightsOf(await createTownReader(createMockChain(5, { storage: null, act })).read());
    expect(await at(1)).toEqual({ clinic: false, generators: false });
    expect(await at(2)).toEqual({ clinic: true, generators: true });
    expect(await at(3)).toEqual({ clinic: true, generators: true });
  });
});
