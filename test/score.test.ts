// The score (src/economy/score): which state plays, as a pure function of events and time; the scheduler's bar
// maths; when it must be silent; and that the written music is sound (in key, in time, one note at a time). No audio
// here: scripts/render-score.mjs and scripts/smoke-score.mjs listen to the engine itself.
import { describe, expect, it } from "vitest";
import { BAR, LATCH, LOOKAHEAD, STEP, TIMER, behind, due, nextLine, position, reanchor, stepTime } from "../src/economy/score/clock";
import { CLEAR_SECONDS, EVENTS, QUIET_SECONDS, audible, createDirector, heartRate, radioSeconds } from "../src/economy/score/state";
import { DRUMS, FIELDS, MOTIFS, OSTINATO, PULSE, RECIPES, STALKER, STEPS_PER_BAR, TEMPO, TICKS, hz, midi, sections } from "../src/economy/score/theme";

/** A director with a run under way at t = 0. */
function inRun() {
  const d = createDirector();
  d.event("game:state", { state: "intro", prev: "title" }, 0);
  d.event("run:start", { retries: 0 }, 0);
  d.event("game:state", { state: "playing", prev: "intro" }, 0);
  return d;
}

describe("which state plays", () => {
  it("is the title pad on the title screen and in the Dockside, whatever the game is doing behind it", () => {
    const d = createDirector();
    expect(d.read(0).state).toBe("title");
    d.event("game:state", { state: "complete" }, 1);
    expect(d.read(1).state).toBe("debrief");
    d.event("dock:open", { from: "debrief" }, 2);
    expect(d.read(2).state).toBe("title");
    d.event("dock:close", {}, 3);
    expect(d.read(3).state).toBe("debrief");
  });

  it("goes title → infiltrate → combat on a shot or an alert, and back to infiltrate after six quiet seconds", () => {
    const d = createDirector();
    d.event("game:state", { state: "intro" }, 0);
    expect(d.read(0).state).toBe("infiltrate");
    d.event("game:state", { state: "playing" }, 1);
    expect(d.read(5).state).toBe("infiltrate");
    d.event("enemy:alert", {}, 10);
    expect(d.read(10).state).toBe("combat");
    expect(d.read(10 + QUIET_SECONDS - 0.1).state).toBe("combat");
    expect(d.read(10 + QUIET_SECONDS + 0.1).state).toBe("infiltrate");
    d.event("weapon:fire", {}, 30);
    expect(d.read(30).state).toBe("combat");
    d.event("weapon:fire", {}, 34); // each shot starts the six seconds again
    expect(d.read(39).state).toBe("combat");
    expect(d.read(40.1).state).toBe("infiltrate");
  });

  it("follows the fight's heat: an alert is hotter than one shot, a hit hotter still, and it cools", () => {
    const d = inRun();
    d.event("weapon:fire", {}, 1);
    const shot = d.read(1).intensity;
    d.event("enemy:alert", {}, 1);
    const alert = d.read(1).intensity;
    d.event("player:hit", { amount: 20 }, 1);
    const hit = d.read(1).intensity;
    expect(shot).toBeGreaterThanOrEqual(0.3);
    expect(alert).toBeGreaterThan(shot);
    expect(hit).toBeGreaterThan(alert);
    expect(d.read(5).intensity).toBeLessThan(hit);
    for (let i = 0; i < 200; i++) d.event("enemy:fire", {}, 6);
    expect(d.read(6).intensity).toBe(1);
    expect(d.read(60).intensity).toBe(0); // infiltrate again
  });

  it("stays where it was through a pause, and starts a retry clean", () => {
    const d = inRun();
    d.event("enemy:alert", {}, 1);
    d.event("game:state", { state: "paused" }, 2);
    expect(d.read(2).state).toBe("combat");
    d.event("game:state", { state: "playing", prev: "paused" }, 3);
    expect(d.read(3).state).toBe("combat");
    d.event("game:state", { state: "dead" }, 4);
    expect(d.read(4).state).toBe("dead");
    d.event("game:state", { state: "playing", prev: "dead" }, 5);
    expect(d.read(5).state).toBe("infiltrate");
  });

  it("plays the set piece on the campaign's phase, over any fight, and the dead and debrief cards on its last ones", () => {
    const d = inRun();
    d.event("mission:phase", { id: "m3", phase: "setpiece" }, 1);
    expect(d.read(1)).toMatchObject({ state: "setpiece", intensity: 1 });
    d.event("enemy:alert", {}, 2);
    expect(d.read(2).state).toBe("setpiece");
    d.event("mission:phase", { id: "m3", phase: "extract" }, 20);
    expect(d.read(20).state).toBe("clear");
    expect(d.read(20 + CLEAR_SECONDS + 0.1).state).toBe("infiltrate");
    d.event("mission:phase", { id: "m3", phase: "complete" }, 40);
    expect(d.read(40).state).toBe("debrief");
    const f = inRun();
    f.event("mission:phase", { id: "m2", phase: "failed" }, 1);
    expect(f.read(1).state).toBe("dead");
  });

  it("plays the resolve when the boat comes free in a plain run, but not when a set piece claims the last uplink", () => {
    const plain = inRun();
    plain.event("objective:all", {}, 10);
    expect(plain.read(10).state).toBe("infiltrate"); // a moment for the campaign or the boss to claim it
    expect(plain.read(10.3).state).toBe("clear");
    expect(plain.read(10.3 + CLEAR_SECONDS).state).toBe("infiltrate");

    const campaign = inRun();
    campaign.event("objective:all", {}, 10);
    campaign.event("mission:phase", { id: "m3", phase: "setpiece" }, 10);
    expect(campaign.read(10.3).state).toBe("setpiece");
    expect(campaign.read(30).state).toBe("setpiece");
  });

  it("plays the Assessor while it stands, then the resolve when it falls, even if the phase still says set piece", () => {
    const d = inRun();
    d.event("mission:phase", { id: "m5", phase: "setpiece" }, 1);
    d.event("objective:all", {}, 1);
    expect(d.read(1.1, { boss: true }).state).toBe("boss");
    expect(d.read(60, { boss: true }).state).toBe("boss");
    expect(d.read(61, { boss: false }).state).toBe("clear");
    expect(d.read(61 + CLEAR_SECONDS + 0.1, { boss: false }).state).toBe("infiltrate");
    // The campaign's own extract a moment later does not start the resolve again.
    d.event("mission:phase", { id: "m5", phase: "extract" }, 63);
    expect(d.read(61 + CLEAR_SECONDS + 0.1, { boss: false }).state).toBe("infiltrate");
  });

  it("is silent before the game has a state it knows, and whatever a screen pins it to", () => {
    const d = createDirector();
    d.event("game:state", { state: "showcase" }, 0);
    expect(d.read(0)).toMatchObject({ state: "silent", base: "silent" });
    d.hold("ending");
    expect(d.read(1)).toMatchObject({ state: "ending", base: "ending", stalker: 0 });
    d.event("enemy:alert", {}, 2);
    expect(d.read(2).state).toBe("ending");
    d.hold("silent");
    expect(d.read(3).state).toBe("silent");
    d.hold(null);
    d.event("game:state", { state: "title" }, 4);
    expect(d.read(4).state).toBe("title");
  });

  it("listens to every event it has a rule for", () => {
    for (const name of ["game:state", "run:start", "objective:all", "mission:phase", "bailiff:near", "weapon:fire", "enemy:alert", "dock:open", "dock:close"]) expect(EVENTS).toContain(name);
  });
});

describe("the Bailiff's layer", () => {
  it("sits over infiltrate and combat while a standing Bailiff is within 25 m, and reports stalker", () => {
    const d = inRun();
    d.event("bailiff:near", { id: 1, dist: 28, standing: true }, 1);
    expect(d.read(1)).toMatchObject({ state: "infiltrate", stalker: 0, heartBpm: 0 });
    d.event("bailiff:near", { id: 1, dist: 20, standing: true }, 1.5);
    expect(d.read(1.5)).toMatchObject({ state: "stalker", base: "infiltrate", stalker: 1 });
    d.event("enemy:alert", {}, 2);
    d.event("bailiff:near", { id: 1, dist: 18, standing: true }, 2);
    expect(d.read(2)).toMatchObject({ state: "stalker", base: "combat", stalker: 1 });
  });

  it("quickens the heartbeat as the distance falls from 25 m to 3 m", () => {
    expect(heartRate(40)).toBe(STALKER.slow);
    expect(heartRate(25)).toBe(STALKER.slow);
    expect(heartRate(3)).toBe(STALKER.fast);
    expect(heartRate(0)).toBe(STALKER.fast);
    expect(heartRate(14)).toBeCloseTo((STALKER.slow + STALKER.fast) / 2, 5);
    let last = 0;
    for (let dist = 25; dist >= 3; dist--) {
      expect(heartRate(dist)).toBeGreaterThan(last);
      last = heartRate(dist);
    }
    const d = inRun();
    d.event("bailiff:near", { id: 1, dist: 6, standing: true }, 1);
    expect(d.read(1).heartBpm).toBe(heartRate(6));
  });

  it("thins when the Bailiff is on a knee, and returns when it stands", () => {
    const d = inRun();
    d.event("bailiff:near", { id: 1, dist: 8, standing: true }, 1);
    d.event("bailiff:staggered", { id: 1, seconds: 9, by: "damage" }, 1.2);
    expect(d.read(1.2)).toMatchObject({ state: "infiltrate", stalker: STALKER.kneeLevel, heartBpm: STALKER.kneeBpm });
    d.event("bailiff:near", { id: 1, dist: 8, standing: false }, 1.7);
    expect(d.read(1.7).state).toBe("infiltrate");
    d.event("bailiff:recovered", { id: 1 }, 2);
    expect(d.read(2)).toMatchObject({ state: "stalker", stalker: 1 });
  });

  it("follows the nearest standing one of two, and stops when they go quiet or the run ends", () => {
    const d = inRun();
    d.event("bailiff:near", { id: 1, dist: 22, standing: true }, 1);
    d.event("bailiff:near", { id: 2, dist: 9, standing: false }, 1);
    expect(d.read(1).heartBpm).toBe(heartRate(22));
    d.event("bailiff:near", { id: 2, dist: 9, standing: true }, 1.5);
    expect(d.read(1.5).heartBpm).toBe(heartRate(9));
    expect(d.read(4).state).toBe("infiltrate"); // no report for 1.5 s: gone
    d.event("bailiff:near", { id: 1, dist: 5, standing: true }, 5);
    d.event("game:state", { state: "dead" }, 5.1);
    expect(d.read(5.1)).toMatchObject({ state: "dead", stalker: 0 });
  });

  it("can be pinned for a screen or a test", () => {
    const d = createDirector();
    d.hold("stalker");
    expect(d.read(0)).toMatchObject({ state: "stalker", base: "infiltrate", stalker: 1 });
  });
});

describe("the scheduler's bar maths", () => {
  it("counts 72 bpm in sixteenths: 208 ms a step, 3.33 s a bar", () => {
    expect(STEP).toBeCloseTo(60 / 72 / 4, 9);
    expect(BAR).toBeCloseTo((60 / 72) * 4, 9);
    expect(stepTime(16, 2)).toBeCloseTo(2 + BAR, 9);
    expect(position(0)).toEqual({ bar: 0, beat: 0, inBar: 0 });
    expect(position(37)).toEqual({ bar: 2, beat: 1, inBar: 5 });
  });

  it("puts state changes on the next half-bar line", () => {
    expect(LATCH).toBe(8);
    expect(nextLine(0, LATCH)).toBe(0);
    expect(nextLine(1, LATCH)).toBe(8);
    expect(nextLine(8, LATCH)).toBe(8);
    expect(nextLine(17, STEPS_PER_BAR)).toBe(32);
  });

  it("schedules each step once, a lookahead in front of the clock", () => {
    expect(LOOKAHEAD).toBeGreaterThan(TIMER * 2); // a late timer still finds its notes in time
    const t0 = 10;
    const seen: number[] = [];
    let next = 0;
    for (let now = 10; now < 10 + BAR * 2; now += TIMER) {
      const steps = due(next, t0, now + LOOKAHEAD);
      for (const n of steps) {
        expect(stepTime(n, t0)).toBeGreaterThanOrEqual(now - 1e-9); // never in the past
        expect(stepTime(n, t0)).toBeLessThan(now + LOOKAHEAD);
        seen.push(n);
      }
      if (steps.length) next = steps[steps.length - 1] + 1;
    }
    expect(seen).toEqual(seen.map((_, i) => i));
    expect(seen.length).toBeGreaterThanOrEqual(32);
  });

  it("picks up where it was after the clock ran on without it", () => {
    const t0 = 0;
    expect(behind(5, t0, 5 * STEP - 0.1)).toBe(false);
    expect(behind(5, t0, 30)).toBe(true);
    const moved = reanchor(5, 30);
    expect(stepTime(5, moved)).toBeCloseTo(30.06, 9);
    expect(due(5, moved, 30 + LOOKAHEAD)).toEqual([5]); // no burst of the steps it missed
  });
});

describe("silence", () => {
  const on = { muted: false, volume: 0.8, hidden: false, context: "running" };
  it("sounds only with audio on, a volume, a visible tab and a running context", () => {
    expect(audible(on)).toBe(true);
    expect(audible({ ...on, muted: true })).toBe(false); // ?noaudio, or the game's silent audio
    expect(audible({ ...on, volume: 0 })).toBe(false);
    expect(audible({ ...on, hidden: true })).toBe(false);
    expect(audible({ ...on, context: "suspended" })).toBe(false); // before the first gesture
    expect(audible({ ...on, context: null })).toBe(false);
  });

  it("ducks for about as long as a radio line is up", () => {
    expect(radioSeconds("Move.")).toBeCloseTo(2.29, 1);
    expect(radioSeconds("x".repeat(116))).toBeCloseTo(4.2, 5);
    expect(radioSeconds("x".repeat(2000))).toBe(8);
    expect(radioSeconds(undefined)).toBe(2.2);
  });
});

describe("the written music", () => {
  const SCALE = new Set([2, 4, 5, 7, 9, 10, 0]); // D minor
  const COLOUR = new Set([3, 8, 6, 11, 1]); // Eb and Ab (the machines), F#, B and C# (the major)

  it("reads note names", () => {
    expect(midi("A4")).toBe(69);
    expect(midi("C4")).toBe(60);
    expect(midi("Eb2")).toBe(39);
    expect(midi("F#4")).toBe(66);
    expect(hz("A4")).toBe(440);
    expect(hz("D2")).toBeCloseTo(73.42, 2);
    expect(() => midi("H2")).toThrow();
  });

  it("keeps every phrase on the sixteenth grid, one note at a time, in or beside D minor", () => {
    for (const [name, phrase] of Object.entries(MOTIFS)) {
      let end = 0;
      for (const [beat, beats, note] of phrase) {
        expect(Number.isInteger(beat * TEMPO.stepsPerBeat), `${name} @${beat}`).toBe(true);
        expect(beat, `${name}: ${note} overlaps`).toBeGreaterThanOrEqual(end);
        end = beat + beats;
        const pc = midi(note) % 12;
        expect(SCALE.has(pc) || COLOUR.has(pc), `${name}: ${note}`).toBe(true);
      }
    }
  });

  it("makes the Bailiff a low falling minor second, and the foghorn a falling fourth that the ending answers", () => {
    const [a, b] = MOTIFS.bailiff;
    expect(midi(a[2]) - midi(b[2])).toBe(1);
    expect(hz(a[2])).toBeLessThan(90);
    expect(midi(MOTIFS.foghorn[0][2]) - midi(MOTIFS.foghorn[1][2])).toBe(5);
    expect(MOTIFS.foghornHome[1][2]).toBe("D2");
    // The theme opens with the foghorn's two notes turned upward.
    expect([MOTIFS.themeA[0][2], MOTIFS.themeA[1][2]]).toEqual(["D4", "A4"]);
  });

  it("has a recipe for every state, with bars of sixteen and chords over the D pedal", () => {
    for (const state of ["title", "infiltrate", "combat", "setpiece", "boss", "clear", "debrief", "dead", "ending"] as const) {
      const secs = sections(state);
      expect(secs.length).toBeGreaterThan(0);
      secs.forEach((r, i) => {
        expect(FIELDS[r.field].length).toBeGreaterThan(0);
        expect(r.pad).toBeGreaterThan(0);
        expect(r.pad).toBeLessThanOrEqual(1);
        expect(r.bars === undefined, `${state} section ${i}`).toBe(i === secs.length - 1);
        for (const bar of [r.drums?.bar, r.ticks?.bar, r.pulse?.bar]) if (bar) expect(bar.length).toBe(STEPS_PER_BAR);
      });
    }
    for (const chords of Object.values(FIELDS)) for (const c of chords) expect(midi(c[0]) % 12).toBe(2);
    for (const bar of [...Object.values(DRUMS), ...Object.values(TICKS), ...Object.values(PULSE)]) expect(bar.length).toBe(STEPS_PER_BAR);
    expect(OSTINATO.length).toBe(STEPS_PER_BAR);
  });

  it("plays the theme whole in the ending: between 60 and 90 seconds before the tail", () => {
    const secs = sections("ending");
    const bars = secs.slice(0, -1).reduce((n, r) => n + (r.bars ?? 0), 0);
    expect(bars * BAR).toBeGreaterThanOrEqual(60);
    expect(bars * BAR).toBeLessThanOrEqual(90);
    expect(secs[secs.length - 1].lead?.phrase).toBe(MOTIFS.foghornHome);
    expect(RECIPES.combat).toMatchObject({ followsIntensity: true });
  });
});
