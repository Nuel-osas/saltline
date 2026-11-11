// Two voices on one radio. The HUD's subtitle box (game.js: `.comms`, its label `.comms-who` reading "Control") shows
// one queued line at a time and emits `radio:line` as each one starts. The Harbormaster's lines go through the same
// queue; when one of them starts, the box switches to its channel (the HARBORMASTER label, a cold colour and a glitch,
// story.css), and back to Control for the next line. No game.js change: the HUD is styled from outside.
import type { Line } from "./lines";

/* eslint-disable @typescript-eslint/no-explicit-any -- the game context is the untyped bundle's G */
type Game = any;

export const CHANNEL_LABEL = { control: "Control", harbormaster: "Harbormaster" } as const;

export interface Channel {
  /** Queue a line on the HUD radio, on its speaker's channel. */
  say(line: Line, seconds?: number): void;
  /** The speaker of the line on the radio now. */
  readonly speaking: Line["who"];
  /** Forget queued Harbormaster lines (a run ended and the HUD cleared its queue). */
  reset(): void;
  dispose(): void;
}

export function createChannel(G: Game, doc: Document = document): Channel {
  /** Harbormaster lines queued and not yet started, by text (the HUD's queue only knows text). */
  const queued = new Map<string, number>();
  let speaking: Line["who"] = "control";
  const box = () => doc.querySelector<HTMLElement>("#ui > .comms") ?? doc.querySelector<HTMLElement>(".comms");

  function show(who: Line["who"]) {
    speaking = who;
    const el = box();
    if (!el) return;
    el.classList.toggle("st-hm", who === "harbormaster");
    const label = el.querySelector(".comms-who");
    if (label && label.textContent !== CHANNEL_LABEL[who]) label.textContent = CHANNEL_LABEL[who];
  }

  const off = G.events?.on?.("radio:line", (e: { text?: string } | undefined) => {
    const text = e && typeof e.text === "string" ? e.text : "";
    const n = queued.get(text) ?? 0;
    if (n > 1) queued.set(text, n - 1);
    else queued.delete(text);
    show(n > 0 ? "harbormaster" : "control");
  });

  return {
    say(line, seconds = 4.2) {
      if (!line || !line.text || !G.hud || typeof G.hud.radio !== "function") return;
      if (line.who === "harbormaster") queued.set(line.text, (queued.get(line.text) ?? 0) + 1);
      try {
        G.hud.radio(line.text, seconds);
      } catch (e) {
        if (line.who === "harbormaster") queued.delete(line.text);
        console.warn("[story] radio failed", e);
      }
    },
    get speaking() {
      return speaking;
    },
    reset() {
      queued.clear();
    },
    dispose() {
      if (typeof off === "function") off();
      queued.clear();
      show("control");
    },
  };
}
