// @vitest-environment happy-dom
// The debrief and dead cards lead with what happened (raid/hud.ts): the haul and its worth above the game's figures,
// or what was lost and what to do next, with the bill and a plain note below.
import { describe, expect, it } from "vitest";
import { createRaidHud } from "../src/economy/v2/raid/hud";

const q = <T extends Element = HTMLElement>(root: ParentNode, sel: string) => {
  const el = root.querySelector<T>(sel);
  if (!el) throw new Error(`missing ${sel}`);
  return el as T;
};

describe("the debrief and dead cards lead with what happened", () => {
  function cards() {
    document.body.innerHTML = `<div id="ui"><div class="menu">
      <section data-s="complete"><div class="m-rating"></div><dl class="m-stats"><div><dt>Time</dt><dd>01:39</dd></div></dl><div class="m-actions"></div></section>
      <section data-s="dead"><dl class="m-stats"><div><dt>Time survived</dt><dd>00:40</dd></div></dl><div class="m-actions"></div></section></div></div>`;
    return createRaidHud({ hud: {} });
  }
  it("puts the haul and its worth above the game's figures, the bill and a plain note below them", () => {
    const hud = cards();
    hud.setDebrief({ lead: { k: "You carried out", v: "SERVO ×2", sub: "Worth about 186 scrip at Moss's today." }, rows: [{ k: "Invoice", v: "1,094 scrip" }], note: "The bill is not a price." });
    const stats = q(document, '[data-s="complete"] .m-stats');
    const lead = stats.previousElementSibling as HTMLElement;
    expect(lead.classList.contains("rd-lead")).toBe(true);
    expect(q(lead, ".rd-lead-v").textContent).toBe("SERVO ×2");
    expect(q(lead, ".rd-lead-s").textContent).toBe("Worth about 186 scrip at Moss's today.");
    const sec = stats.nextElementSibling as HTMLElement;
    expect(q(sec, "dt").textContent).toBe("Invoice");
    expect(q(sec, ".rd-note").textContent).toBe("The bill is not a price.");
    hud.setDebrief(null);
    expect(document.querySelector('[data-s="complete"] .rd-lead, [data-s="complete"] .rd-sec')).toBeNull();
    // Rows alone still work (a raid off the books).
    hud.setDebrief([{ k: "Raid", v: "Off the books." }]);
    expect(document.querySelector('[data-s="complete"] .rd-lead')).toBeNull();
    expect(q(document, '[data-s="complete"] .rd-sec dd').textContent).toBe("Off the books.");
  });
  it("leads the dead card with what was lost and what to do next", () => {
    const hud = cards();
    hud.setDead({ lead: { k: "Lost", v: "LONGSHORE S-000026 · SERVO ×2", sub: "Build or buy another at the dock." }, rows: [] });
    const lead = q(document, '[data-s="dead"] .rd-lead.rd-lost');
    expect(lead.nextElementSibling?.classList.contains("m-stats")).toBe(true);
    expect(lead.textContent).toBe("LostLONGSHORE S-000026 · SERVO ×2Build or buy another at the dock.");
    expect(document.querySelector('[data-s="dead"] .rd-sec')).toBeNull(); // no empty section
  });
});
