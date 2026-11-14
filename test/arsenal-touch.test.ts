// @vitest-environment happy-dom
// The kit's touch buttons (arsenal/touch.ts): a phone's way to throw a charge, swing the rifle and hold USE.
import { afterEach, describe, expect, it, vi } from "vitest";
import { addTouchButtons } from "../src/economy/arsenal/touch";

const layer = () => {
  document.body.innerHTML = `<div class="h-prompt"></div><div class="touch on"><button class="t-btn t-interact"></button></div>`;
};
const tap = (el: Element) => el.dispatchEvent(new Event("touchstart", { bubbles: true, cancelable: true }));

describe("touch buttons for the kit", () => {
  afterEach(() => {
    vi.useRealTimers();
    document.body.innerHTML = "";
  });

  it("wait for the game's touch layer, then join it once", () => {
    vi.useFakeTimers();
    document.body.innerHTML = "";
    const undo = addTouchButtons({ throwCharge: () => true, swing: () => true, charges: () => 2 });
    expect(document.querySelector(".t-charge")).toBeNull(); // no layer yet: the game builds it at the first touch
    layer();
    vi.advanceTimersByTime(300);
    expect(document.querySelectorAll(".touch .t-charge")).toHaveLength(1);
    expect(document.querySelectorAll(".touch .t-butt")).toHaveLength(1);
    vi.advanceTimersByTime(2000);
    expect(document.querySelectorAll(".touch .t-btn")).toHaveLength(3); // never added twice
    undo();
    expect(document.querySelector(".t-charge")).toBeNull();
  });

  it("CHG throws a charge and shows how many are left; with none it dims", () => {
    vi.useFakeTimers();
    layer();
    let charges = 2;
    const thrown: number[] = [];
    addTouchButtons({ throwCharge: () => (charges > 0 ? (thrown.push(charges--), true) : false), swing: () => true, charges: () => charges });
    const chg = document.querySelector(".t-charge")!;
    expect(chg.textContent).toBe("CHG2");
    tap(chg);
    vi.advanceTimersByTime(300);
    expect(thrown).toEqual([2]);
    expect(chg.textContent).toBe("CHG1");
    tap(chg);
    vi.advanceTimersByTime(300);
    expect(chg.classList.contains("empty")).toBe(true);
    tap(chg);
    expect(thrown).toEqual([2, 1]); // nothing left to throw
  });

  it("HIT swings the rifle, and a touch followed by its made-up mouse press swings once", () => {
    layer();
    let swings = 0;
    addTouchButtons({ throwCharge: () => true, swing: () => (swings++, true), charges: () => 0 });
    const hit = document.querySelector(".t-butt")!;
    tap(hit);
    hit.dispatchEvent(new Event("mousedown", { bubbles: true, cancelable: true }));
    expect(swings).toBe(1);
  });

  it("keeps the USE button in step with the prompt, even one that was showing before the layer existed", () => {
    vi.useFakeTimers();
    layer();
    document.querySelector(".h-prompt")!.classList.add("on"); // "HOLD USE — TAKE THE RIFLE", up since the raid began
    const told: boolean[] = [];
    addTouchButtons({ throwCharge: () => true, swing: () => true, charges: () => 0 }, document, { setPrompt: (on) => void told.push(on) });
    expect(told).toEqual([true]);
    document.querySelector(".h-prompt")!.classList.remove("on");
    vi.advanceTimersByTime(300);
    expect(told[told.length - 1]).toBe(false);
  });
});
