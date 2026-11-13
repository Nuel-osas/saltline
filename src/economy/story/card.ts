// The chapter title card (docs/STORY.md → Chapters): it replaces the location card that opens every run. game.js
// shows and hides its `.loc-card` during the intro; this fills that same element with the chapter's three lines
// before it shows (`CHAPTER 1 · PROOF OF DELIVERY`, the chapter's line, then `Saltline Terminal · Berth 4 · 05:42`),
// and puts the location card back on dispose. No game.js change: the card is in the DOM from boot.
import { chapterCard } from "./copy";

export interface ChapterCard {
  /** Fill the card for this act (unknown is Chapter 1). Returns false when the game has no card to fill. */
  set(act: unknown): boolean;
  /** The act on the card now, or null before the first set. */
  readonly act: 1 | 2 | 3 | null;
  /** The card is on screen (game.js adds `.on` during the intro). */
  readonly showing: boolean;
  dispose(): void;
}

export function createChapterCard(doc: Document = document): ChapterCard {
  let shown: 1 | 2 | 3 | null = null;
  let original: string | null = null;
  let host: HTMLElement | null = null;
  const find = () => (host?.isConnected ? host : (host = doc.querySelector<HTMLElement>(".loc-card")));

  return {
    set(act) {
      const el = find();
      if (!el) return false;
      const c = chapterCard(act);
      const n = (act === 2 || act === 3 ? act : 1) as 1 | 2 | 3;
      if (shown === n && el.classList.contains("st-chapter")) return true;
      if (original === null) original = el.innerHTML;
      const kicker = doc.createElement("b");
      kicker.textContent = c.kicker;
      const line = doc.createElement("em");
      line.className = "st-ch-line";
      line.textContent = c.line;
      const place = doc.createElement("span");
      place.textContent = c.place;
      el.replaceChildren(doc.createElement("i"), kicker, line, place);
      el.classList.add("st-chapter");
      el.dataset.chapter = String(n);
      shown = n;
      return true;
    },
    get act() {
      return shown;
    },
    get showing() {
      return !!find()?.classList.contains("on");
    },
    dispose() {
      const el = find();
      if (el && original !== null) {
        el.innerHTML = original;
        el.classList.remove("st-chapter");
        delete el.dataset.chapter;
      }
      shown = null;
      original = null;
    },
  };
}
