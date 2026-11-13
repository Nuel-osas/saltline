// The radio channel the raid's Harbormaster lines go out on (story/radio.ts explains the HUD's one subtitle box and
// its two labels). v2 doesn't start v1's story, so somebody has to open the channel, and it must work whichever of
// the raid and the Bailiff starts first:
//
// - a channel is already published at G.story.channel: use it;
// - none, and no Bailiff yet: open the story's own channel and publish it, so the Bailiff and the Assessor speak
//   through the same one;
// - none, but the Bailiff is already up (it opened a channel of its own, which nobody else can reach): open a guest
//   channel that labels only the lines it queued and leaves every other line to the Bailiff's. Two full channels
//   would each relabel the other's lines as Control's.
import type { Line } from "../../story/lines";
import { CHANNEL_LABEL, createChannel, lineMs, type TimedChannel } from "../../story/radio";

/* eslint-disable @typescript-eslint/no-explicit-any -- the game context is the untyped bundle's G */
type Game = any;

/** A queued line that hasn't started after this long was cleared off the HUD without a reset (as story/radio.ts). */
const STALE_MS = 60_000;

export interface Opened {
  channel: TimedChannel;
  /** How it was opened, for the log and the tests. */
  how: "shared" | "own" | "guest";
  dispose(): void;
}

export function openChannel(G: Game, doc: Document = document, now: () => number = () => performance.now()): Opened {
  const existing: TimedChannel | undefined = G.story?.channel;
  if (existing && typeof existing.say === "function" && typeof existing.busy === "function") return { channel: existing, how: "shared", dispose() {} };
  const guest = !!G.bailiff;
  const channel = guest ? createGuestChannel(G, doc, now) : createChannel(G, doc, now);
  G.story = { ...(G.story ?? {}), channel };
  return {
    channel,
    how: guest ? "guest" : "own",
    dispose() {
      channel.dispose();
      if (G.story?.channel === channel) delete G.story.channel;
    },
  };
}

/** A channel beside another's: it puts the Harbormaster's label on the lines it queued and touches no other line. */
export function createGuestChannel(G: Game, doc: Document = document, now: () => number = () => performance.now()): TimedChannel {
  let queued: { text: string; seconds: number; at: number }[] = [];
  let mine = false;
  let hmEnd = -Infinity;
  const box = () => doc.querySelector<HTMLElement>("#ui > .comms") ?? doc.querySelector<HTMLElement>(".comms");
  const fresh = () => {
    const t = now();
    if (queued.length && queued[0].at < t - STALE_MS) queued = queued.filter((q) => q.at >= t - STALE_MS);
    return queued;
  };
  const off = G.events?.on?.("radio:line", (e: { text?: string } | undefined) => {
    const text = e && typeof e.text === "string" ? e.text : "";
    const t = now();
    if (mine) hmEnd = Math.min(hmEnd, t); // the line before this one is over
    const i = fresh().findIndex((q) => q.text === text);
    mine = i >= 0;
    if (!mine) return; // the other channel has labelled it: Control's, or its own
    const [q] = queued.splice(i, 1);
    hmEnd = t + lineMs(q.text, q.seconds);
    const el = box();
    if (!el) return;
    el.classList.add("st-hm");
    const label = el.querySelector(".comms-who");
    if (label) label.textContent = CHANNEL_LABEL.harbormaster;
  });
  return {
    say(line: Line, seconds = 4.2) {
      if (!line || !line.text || !G.hud || typeof G.hud.radio !== "function") return;
      const entry = { text: line.text, seconds, at: now() };
      if (line.who === "harbormaster") queued.push(entry);
      try {
        G.hud.radio(line.text, seconds);
      } catch (e) {
        queued = queued.filter((q) => q !== entry);
        console.warn("[raid] radio failed", e);
      }
    },
    get speaking() {
      return mine ? ("harbormaster" as const) : ("control" as const);
    },
    reset() {
      queued = [];
      if (mine) hmEnd = Math.min(hmEnd, now());
    },
    dispose() {
      if (typeof off === "function") off();
      queued = [];
    },
    busy() {
      if (fresh().length) return true;
      const el = box();
      return !!el && el.classList.contains("on");
    },
    lastHarbormasterEnd: () => hmEnd,
  };
}
