// Two voices on one radio. The HUD's subtitle box (game.js: `.comms`, its label `.comms-who` reading "Control") shows
// one queued line at a time and emits `radio:line` as each one starts. The Harbormaster's lines go through the same
// queue; when one of them starts, the box switches to its channel (the HARBORMASTER label, a cold colour and a glitch,
// story.css), and back to Control for the next line. No game.js change: the HUD is styled from outside.
//
// The channel also keeps time for the pacing rule (pacing.ts): whether the radio is busy, and when the
// Harbormaster's last line ended, whoever queued it (the billing lines and the boss both speak through here).
import type { Line } from "./lines";

/* eslint-disable @typescript-eslint/no-explicit-any -- the game context is the untyped bundle's G */
type Game = any;

export const CHANNEL_LABEL = { control: "Control", harbormaster: "Harbormaster" } as const;

/** The HUD types a line at 58 characters a second, then holds it for its `seconds` (game.js, the radio's update). */
export const lineMs = (text: string, seconds: number) => (text.length / 58 + seconds) * 1000;
/** A queued Harbormaster line that hasn't started after this long was cleared off the HUD without a reset. */
const STALE_MS = 60_000;

export interface Channel {
  /** Queue a line on the HUD radio, on its speaker's channel. */
  say(line: Line, seconds?: number): void;
  /** The speaker of the line on the radio now. */
  readonly speaking: Line["who"];
  /** Forget queued Harbormaster lines (a run ended and the HUD cleared its queue). */
  reset(): void;
  dispose(): void;
}

/** The channel as createChannel makes it: a Channel that also keeps time for the pacing rule. */
export interface TimedChannel extends Channel {
  /** The radio is saying a line, or holding lines in its queue. */
  busy(): boolean;
  /** When the Harbormaster's last line ended, or will end if it's on now (performance.now() ms); -Infinity if never. */
  lastHarbormasterEnd(): number;
}

export function createChannel(G: Game, doc: Document = document, now: () => number = () => performance.now()): TimedChannel {
  /** Harbormaster lines queued and not yet started (the HUD's queue only knows text). */
  let queued: { text: string; seconds: number; at: number }[] = [];
  let speaking: Line["who"] = "control";
  let hmEnd = -Infinity;
  const box = () => doc.querySelector<HTMLElement>("#ui > .comms") ?? doc.querySelector<HTMLElement>(".comms");

  function show(who: Line["who"]) {
    speaking = who;
    const el = box();
    if (!el) return;
    el.classList.toggle("st-hm", who === "harbormaster");
    const label = el.querySelector(".comms-who");
    if (label && label.textContent !== CHANNEL_LABEL[who]) label.textContent = CHANNEL_LABEL[who];
  }

  const fresh = () => {
    const t = now();
    if (queued.length && queued[0].at < t - STALE_MS) queued = queued.filter((q) => q.at >= t - STALE_MS);
    return queued;
  };

  const off = G.events?.on?.("radio:line", (e: { text?: string } | undefined) => {
    const text = e && typeof e.text === "string" ? e.text : "";
    const t = now();
    if (speaking === "harbormaster") hmEnd = Math.min(hmEnd, t); // the line before this one is over
    const i = fresh().findIndex((q) => q.text === text);
    if (i >= 0) {
      const [q] = queued.splice(i, 1);
      hmEnd = t + lineMs(q.text, q.seconds);
      show("harbormaster");
    } else show("control");
  });

  return {
    say(line, seconds = 4.2) {
      if (!line || !line.text || !G.hud || typeof G.hud.radio !== "function") return;
      const entry = { text: line.text, seconds, at: now() };
      if (line.who === "harbormaster") queued.push(entry);
      try {
        G.hud.radio(line.text, seconds);
      } catch (e) {
        if (line.who === "harbormaster") queued = queued.filter((q) => q !== entry);
        console.warn("[story] radio failed", e);
      }
    },
    get speaking() {
      return speaking;
    },
    reset() {
      queued = [];
      if (speaking === "harbormaster") hmEnd = Math.min(hmEnd, now());
    },
    dispose() {
      if (typeof off === "function") off();
      queued = [];
      show("control");
    },
    busy() {
      if (fresh().length) return true;
      const el = box();
      return !!el && el.classList.contains("on");
    },
    lastHarbormasterEnd() {
      return hmEnd;
    },
  };
}
