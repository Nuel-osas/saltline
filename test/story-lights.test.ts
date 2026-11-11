// The lights across the water (src/economy/story/lights.ts): what the far shore shows for each read of the town.
import { describe, expect, it } from "vitest";
import { lightsOf } from "../src/economy/story/lights";
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
});
