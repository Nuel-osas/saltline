// @vitest-environment happy-dom
// v2's opening film (src/economy/v2/intro): the cut as data (timeline.ts), and the player that holds the first raid's
// start, can be skipped at any moment, plays once and replays from the title, and never blocks the raid (film.ts).
// The stage here is a recorder: the real one (stage.ts) needs the game's scene and is checked in the headless run.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type Film, type Stage, createFilm } from "../src/economy/v2/intro/film";
import { INTRO_KEY, createSeen } from "../src/economy/v2/intro/index";
import { FILM_SECONDS, LENS_AT, MARKS, MARKS_OFF, SHOTS, blackAt, locate, shotStart, subtitleAt } from "../src/economy/v2/intro/timeline";

vi.mock("../src/economy/v2/intro/intro.css", () => ({}));
vi.mock("../src/economy/v2/intro/stage", () => ({ createStage: () => null }));

describe("the film's cut", () => {
  it("is five shots in order, about fifty seconds", () => {
    expect(SHOTS.map((s) => s.id)).toEqual(["water", "drop", "crate", "objective", "title"]);
    expect(SHOTS.map((s) => s.seconds)).toEqual([9, 10, 11.5, 13.5, 4.5]);
    expect(FILM_SECONDS).toBe(48.5);
    expect(SHOTS.map((_, i) => shotStart(i))).toEqual([0, 9, 19, 30.5, 44]);
  });

  it("says the owner's lines, each by the right voice, word for word", () => {
    expect(SHOTS.flatMap((s) => s.subtitles.map((l) => `${s.id}/${l.who}: ${l.text}`))).toEqual([
      "water/control: Ten years ago they gave the port to a machine. Last winter it impounded the town.",
      "drop/control: Everything the town needs is behind that fence. Medicine. Fuel. Copper. You're the one going over it.",
      "crate/moss: Issue rifle. Port Authority property. Everyone gets one. Nobody wants it.",
      "crate/moss: Bring me back parts and I'll build you something better.",
      "objective/control: Three uplinks. Cut them and it goes blind.",
      "objective/control: Take what you can carry. Everything you take goes on its invoice.",
      "objective/control: When the invoice gets big enough, it sends something to collect.",
      "title/harbormaster: Your visit is not authorised.",
    ]);
    // Dry: nobody in this story raises their voice.
    expect(SHOTS.flatMap((s) => s.subtitles.map((l) => l.text)).join(" ")).not.toContain("!");
  });

  it("keeps every subtitle inside its shot, one at a time, long enough to read", () => {
    for (const s of SHOTS) {
      let free = 0;
      for (const l of s.subtitles) {
        expect(l.at).toBeGreaterThanOrEqual(free);
        expect(l.at + l.for).toBeLessThanOrEqual(s.seconds);
        // An easy reading pace: at least a quarter of a second a word.
        expect(l.for).toBeGreaterThanOrEqual(0.25 * l.text.split(/\s+/).length);
        free = l.at + l.for;
      }
    }
  });

  it("finds the shot and the subtitle at any moment", () => {
    expect(locate(-1).index).toBe(-1);
    expect(locate(0)).toMatchObject({ index: 0, local: 0 });
    expect(locate(9).shot?.id).toBe("drop");
    expect(locate(25).shot?.id).toBe("crate");
    expect(locate(25).local).toBeCloseTo(6);
    expect(locate(FILM_SECONDS).index).toBe(SHOTS.length);
    expect(subtitleAt(0.5)).toBeNull();
    expect(subtitleAt(3)?.text).toMatch(/^Ten years ago/);
    expect(subtitleAt(19 + 5)?.who).toBe("moss");
    expect(subtitleAt(19 + 9)?.text).toMatch(/^Bring me back parts/);
    expect(subtitleAt(30.5 + 10)?.text).toMatch(/sends something to collect\.$/);
    expect(subtitleAt(44 + 2)?.who).toBe("harbormaster");
    expect(subtitleAt(FILM_SECONDS + 1)).toBeNull();
  });

  it("picks out the three uplinks one by one, then opens the lens under the last line", () => {
    expect(MARKS.map((m) => `${m.id} ${m.label}`)).toEqual(["relay_a YARD", "relay_b SHED", "relay_c QUAY"]);
    expect(MARKS.every((m, i) => (i === 0 || m.at > MARKS[i - 1].at) && m.at < MARKS_OFF)).toBe(true);
    const objective = SHOTS[3];
    const last = objective.subtitles[objective.subtitles.length - 1];
    expect(LENS_AT).toBeGreaterThan(last.at);
    expect(LENS_AT).toBeLessThan(objective.seconds - 1.5);
  });

  it("comes up from black, cuts through a few frames of it, and holds black under the title", () => {
    expect(blackAt(0)).toBe(1);
    expect(blackAt(4)).toBe(0);
    expect(blackAt(9.001)).toBeGreaterThan(0.9); // the cut into the drop point
    expect(blackAt(14)).toBe(0);
    expect(blackAt(43.9)).toBeGreaterThan(0.8); // down to black before the title
    expect(blackAt(45)).toBe(1);
    expect(blackAt(FILM_SECONDS + 5)).toBe(1);
  });
});

interface Rig {
  film: Film;
  host: HTMLElement;
  stage: Stage & { begun: number; ended: number; frames: number[]; failBegin: boolean; failAt: number };
  seen: { value: boolean };
  ends: boolean[];
  gestures: boolean[];
  toggles: boolean[];
  /** Run the game's frames for `seconds` of film. */
  run(seconds: number, dt?: number): boolean;
}

function rig(seenAlready = false): Rig {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const seen = { value: seenAlready };
  const stage: Rig["stage"] = {
    begun: 0,
    ended: 0,
    frames: [],
    failBegin: false,
    failAt: Infinity,
    begin() {
      this.begun++;
      if (this.failBegin) throw new Error("no scene");
    },
    frame(t) {
      if (t >= this.failAt) throw new Error("a shot broke");
      this.frames.push(t);
    },
    end() {
      this.ended++;
    },
  };
  const ends: boolean[] = [];
  const gestures: boolean[] = [];
  const toggles: boolean[] = [];
  const film = createFilm({
    host,
    stage,
    seen: () => seen.value,
    markSeen: () => (seen.value = true),
    onEnd: (run) => ends.push(run),
    onGesture: (run) => gestures.push(run),
    onToggle: (on) => toggles.push(on),
  });
  return {
    film,
    host,
    stage,
    seen,
    ends,
    gestures,
    toggles,
    run(seconds, dt = 0.05) {
      let held = true;
      for (let i = 0, n = Math.round(seconds / dt); i < n; i++) held = film.frame(dt);
      return held;
    },
  };
}

const press = (code: string) => window.dispatchEvent(new KeyboardEvent("keydown", { code, bubbles: true, cancelable: true }));

describe("the film on the first DEPLOY", () => {
  let warn: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    vi.useFakeTimers();
    warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.useRealTimers();
    warn.mockRestore();
    document.body.innerHTML = "";
  });

  it("takes the raid's start, plays every shot with its subtitles, then starts the raid exactly once", () => {
    const r = rig();
    const go = vi.fn();
    expect(r.film.beforeRun(go, "title")).toBe(true);
    expect(r.film.active).toBe(true);
    expect(r.stage.begun).toBe(1);
    expect(r.toggles).toEqual([true]);
    expect(go).not.toHaveBeenCalled();
    const root = r.host.querySelector<HTMLElement>(".in-film")!;
    expect(root.hidden).toBe(false);
    expect(root.querySelector(".in-skip")?.textContent).toMatch(/Skip/i);
    const line = () => (root.querySelector(".in-sub.on") ? root.querySelector(".in-line")!.textContent : null);
    const who = () => root.querySelector(".in-who")!.textContent;

    expect(r.run(3)).toBe(true); // the film holds the camera
    expect(r.film.shot).toBe(0);
    expect(line()).toMatch(/^Ten years ago/);
    expect(who()).toBe("Control");
    expect(root.querySelector(".in-slug.on .in-slug-t")?.textContent).toBe("05:40 · Saltline Terminal");
    r.run(21); // 24 s: Moss, over the crate
    expect(r.film.shot).toBe(2);
    expect(line()).toMatch(/^Issue rifle\./);
    expect(who()).toBe("Moss");
    r.run(11); // 35 s: the objective
    expect(r.film.shot).toBe(3);
    expect(line()).toMatch(/^Take what you can carry\./);
    r.run(11); // 46 s: the title, the Harbormaster under it and no subtitle
    expect(r.film.shot).toBe(4);
    expect(line()).toBeNull();
    expect(root.querySelector(".in-title.on b")?.textContent).toBe("SALTLINE");
    expect(root.querySelector(".in-hm.on")?.textContent).toBe("Your visit is not authorised.");
    expect(go).not.toHaveBeenCalled();

    expect(r.run(3)).toBe(false); // past the end: the camera is released
    expect(r.film.active).toBe(false);
    expect(r.stage.ended).toBe(1);
    expect(go).toHaveBeenCalledTimes(1);
    expect(r.seen.value).toBe(true);
    expect(r.ends).toEqual([true]);
    expect(r.toggles).toEqual([true, false]);
    // The stage saw film time in order, and nothing after the end.
    expect(r.stage.frames.every((t, i, a) => i === 0 || t > a[i - 1])).toBe(true);
    expect(Math.max(...r.stage.frames)).toBeLessThan(FILM_SECONDS);
    const n = r.stage.frames.length;
    r.run(1);
    expect(r.stage.frames.length).toBe(n);
    vi.advanceTimersByTime(600);
    expect(root.hidden).toBe(true);
  });

  it.each(SHOTS.map((s, i) => [s.id, i] as const))("is skipped cleanly in the %s shot", (_id, i) => {
    const r = rig();
    const go = vi.fn();
    r.film.beforeRun(go, "title");
    r.run(shotStart(i) + SHOTS[i].seconds / 2);
    expect(r.film.shot).toBe(i);
    // Esc, Enter and a click all skip.
    if (i % 3 === 0) press("Escape");
    else if (i % 3 === 1) press("Enter");
    else window.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    expect(r.film.active).toBe(false);
    expect(r.film.shot).toBe(-1);
    expect(r.stage.begun).toBe(1);
    expect(r.stage.ended).toBe(1); // the camera, the cast and the score go back; the drop point stays (stage.ts)
    expect(go).toHaveBeenCalledTimes(1);
    expect(r.gestures).toEqual([true]); // the gesture can capture the mouse for the raid
    expect(r.ends).toEqual([true]);
    expect(r.seen.value).toBe(true);
    expect(r.film.frame(0.016)).toBe(false);
    press("Escape");
    r.film.skip();
    expect(r.stage.ended).toBe(1);
    expect(go).toHaveBeenCalledTimes(1);
    expect(r.host.querySelector(".in-sub.on")).toBeNull();
  });

  it("leaves keys alone when it isn't playing, and takes them while it is", () => {
    const r = rig();
    const seenKeys: string[] = [];
    const later = (e: Event) => seenKeys.push((e as KeyboardEvent).code);
    window.addEventListener("keydown", later);
    press("Enter");
    r.film.beforeRun(() => {}, "title");
    press("KeyW"); // not a skip key
    expect(r.film.active).toBe(true);
    press("Enter"); // the skip: nothing behind the film sees it (the title would deploy again)
    expect(r.film.active).toBe(false);
    expect(seenKeys).toEqual(["Enter", "KeyW"]);
    window.removeEventListener("keydown", later);
  });

  it("plays once: the second DEPLOY goes straight to the sign-on", () => {
    const r = rig();
    const first = vi.fn();
    r.film.beforeRun(first, "title");
    press("Escape");
    expect(first).toHaveBeenCalledTimes(1);
    const second = vi.fn();
    expect(r.film.beforeRun(second, "title")).toBe(false);
    expect(r.stage.begun).toBe(1);
    expect(second).not.toHaveBeenCalled(); // the caller starts it
    // A retry mid-raid never plays it either.
    const fresh = rig();
    expect(fresh.film.beforeRun(vi.fn(), "dead")).toBe(false);
    expect(fresh.stage.begun).toBe(0);
  });

  it("replays from the title's INTRO without starting anything", () => {
    const r = rig(true);
    const back = vi.fn();
    r.film.play(back);
    expect(r.film.active).toBe(true);
    expect(r.stage.begun).toBe(1);
    r.run(12);
    expect(r.film.shot).toBe(1);
    press("Escape");
    expect(back).toHaveBeenCalledTimes(1);
    expect(r.gestures).toEqual([false]); // a replay must not capture the mouse
    expect(r.ends).toEqual([false]);
    expect(r.stage.ended).toBe(1);
    // And again, from the top.
    r.film.play();
    expect(r.film.time).toBe(0);
    expect(r.stage.begun).toBe(2);
    expect(r.run(FILM_SECONDS + 1)).toBe(false);
    expect(r.stage.ended).toBe(2);
  });

  it("treats a DEPLOY during the film as a skip: the held raid starts once, a replay lets this one through", () => {
    const r = rig();
    const go = vi.fn();
    r.film.beforeRun(go, "title");
    const again = vi.fn();
    expect(r.film.beforeRun(again, "title")).toBe(true);
    expect(go).toHaveBeenCalledTimes(1);
    expect(again).not.toHaveBeenCalled();
    r.film.play();
    expect(r.film.beforeRun(again, "title")).toBe(false); // over a replay, the caller starts this one
    expect(r.film.active).toBe(false);
  });

  it("never blocks the raid: a stage that can't start, a shot that throws, or a game that stops drawing", () => {
    const a = rig();
    a.stage.failBegin = true;
    const goA = vi.fn();
    expect(a.film.beforeRun(goA, "title")).toBe(true);
    expect(goA).toHaveBeenCalledTimes(1);
    expect(a.film.active).toBe(false);
    expect(a.stage.ended).toBe(1); // whatever it built is cleared
    expect(a.film.frame(0.016)).toBe(false);

    const b = rig();
    b.stage.failAt = 20;
    const goB = vi.fn();
    b.film.beforeRun(goB, "title");
    expect(b.run(19)).toBe(true);
    expect(b.run(2)).toBe(false);
    expect(goB).toHaveBeenCalledTimes(1);
    expect(b.stage.ended).toBe(1);
    expect(b.film.active).toBe(false);

    const c = rig();
    const goC = vi.fn();
    c.film.beforeRun(goC, "title");
    c.run(1);
    vi.advanceTimersByTime(1000); // frames came: it plays on
    c.run(0.5);
    expect(c.film.active).toBe(true);
    vi.advanceTimersByTime(4000); // none since: the raid can't wait
    expect(c.film.active).toBe(false);
    expect(goC).toHaveBeenCalledTimes(1);
    expect(c.stage.ended).toBe(1);
    expect(warn).toHaveBeenCalledTimes(3);
  });

  it("clears up when it is disposed mid-film", () => {
    const r = rig();
    const go = vi.fn();
    r.film.beforeRun(go, "title");
    r.run(5);
    r.film.dispose();
    expect(r.stage.ended).toBe(1);
    expect(go).toHaveBeenCalledTimes(1);
    expect(r.host.querySelector(".in-film")).toBeNull();
    press("Escape"); // its listeners are gone
    expect(r.stage.ended).toBe(1);
  });
});

describe("remembering the film", () => {
  it("is seen once marked, across page loads, and ?intro= overrides it", () => {
    localStorage.clear();
    const first = createSeen(localStorage);
    expect(first.seen()).toBe(false);
    first.markSeen();
    expect(first.seen()).toBe(true);
    expect(localStorage.getItem(INTRO_KEY)).toBe("1");
    expect(createSeen(localStorage).seen()).toBe(true);
    // ?intro=1 plays it once more; ?intro=0 never plays it on DEPLOY.
    const again = createSeen(localStorage, "1");
    expect(again.seen()).toBe(false);
    again.markSeen();
    expect(again.seen()).toBe(true);
    localStorage.clear();
    expect(createSeen(localStorage, "0").seen()).toBe(true);
  });

  it("plays once a page load when storage is off", () => {
    const broken = {
      getItem(): string | null {
        throw new Error("blocked");
      },
      setItem() {
        throw new Error("full");
      },
    };
    const m = createSeen(broken);
    expect(m.seen()).toBe(false);
    expect(() => m.markSeen()).not.toThrow();
    expect(m.seen()).toBe(true);
    expect(createSeen(null).seen()).toBe(false);
  });
});
