// @vitest-environment happy-dom
// The chapter card (src/economy/story/card.ts): game.js's location card, filled with the chapter for the town's act
// before a run's intro shows it, Chapter 1 when the act is unknown, and put back on dispose.
import { afterEach, describe, expect, it } from "vitest";
import { createChapterCard } from "../src/economy/story/card";
import { CHAPTERS, chapterCard } from "../src/economy/story/copy";
import { actOf } from "../src/economy/story/town";
import { FAILED, MISSING, ok, view } from "./story-fixtures";

// The card as game.js builds it (src/game.js, pM: the `.loc-card` at the end of the menu's markup).
const GAME_CARD = `<i></i><b>Saltline Terminal · Berth 4 · 05:42</b><span>Port Authority Breach Unit — one breacher, no backup</span>`;

const mount = () => {
  document.body.innerHTML = `<div id="ui"><div class="menu"><div class="loc-card" aria-hidden="true">${GAME_CARD}</div></div></div>`;
  return document.querySelector<HTMLElement>(".loc-card")!;
};
const lines = (el: HTMLElement) => [...el.querySelectorAll("b, em, span")].map((n) => n.textContent);

afterEach(() => document.body.replaceChildren());

describe("the chapter card", () => {
  it("names each chapter after its shipping document, with its line and the place", () => {
    expect(chapterCard(1)).toEqual({
      kicker: "Chapter 1 · Proof of Delivery",
      line: "The town needs its cargo. The Harbormaster needs a signature.",
      place: "Saltline Terminal · Berth 4 · 05:42",
    });
    expect(chapterCard(2).kicker).toBe("Chapter 2 · Bill of Lading");
    expect(chapterCard(2).line).toBe("The lights are back. The Harbormaster has noticed the discrepancy.");
    expect(chapterCard(3).kicker).toBe("Chapter 3 · Final Notice");
    expect(chapterCard(3).line).toBe("The client has been identified. The client would like its cores back.");
    expect(CHAPTERS.map((c) => c.title)).toEqual(["Proof of Delivery", "Bill of Lading", "Final Notice"]);
  });

  it("is Chapter 1 whenever the act is unknown", () => {
    for (const act of [undefined, null, 0, 4, "2", Number.NaN]) expect(chapterCard(act).kicker).toBe("Chapter 1 · Proof of Delivery");
    // The reads the story makes: a failed or missing town plays as Chapter 1.
    expect(chapterCard(actOf(FAILED)).kicker).toBe("Chapter 1 · Proof of Delivery");
    expect(chapterCard(actOf(MISSING)).kicker).toBe("Chapter 1 · Proof of Delivery");
    expect(chapterCard(actOf(null)).kicker).toBe("Chapter 1 · Proof of Delivery");
    expect(chapterCard(actOf(ok(view(3)))).kicker).toBe("Chapter 3 · Final Notice");
  });

  it("fills the game's location card per act, and puts it back on dispose", () => {
    const el = mount();
    const card = createChapterCard();
    expect(card.act).toBeNull();
    for (const act of [1, 2, 3] as const) {
      expect(card.set(act)).toBe(true);
      expect(card.act).toBe(act);
      expect(el.dataset.chapter).toBe(String(act));
      const c = chapterCard(act);
      expect(lines(el)).toEqual([c.kicker, c.line, c.place]);
      expect(el.querySelector("i")).not.toBeNull(); // the signal bar stays
    }
    card.set(undefined);
    expect(lines(el)[0]).toBe("Chapter 1 · Proof of Delivery");
    expect(el.classList.contains("st-chapter")).toBe(true);
    expect(card.showing).toBe(false);
    el.classList.add("on");
    expect(card.showing).toBe(true);
    card.dispose();
    expect(el.innerHTML).toBe(GAME_CARD);
    expect(el.classList.contains("st-chapter")).toBe(false);
  });

  it("does nothing without a card in the page", () => {
    const card = createChapterCard();
    expect(card.set(2)).toBe(false);
    expect(card.act).toBeNull();
    expect(card.showing).toBe(false);
    expect(() => card.dispose()).not.toThrow();
  });
});
