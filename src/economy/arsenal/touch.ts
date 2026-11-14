// Touch buttons for the kit: the breaker charge and the rifle butt. The game's own touch layer (src/game.js) has
// fire, aim, reload, jump and the context button; the kit's two actions were on G and F only, so a phone had no way
// to throw a charge at the Bailiff or swing the rifle. These two buttons join that layer, in its style, the first
// time it appears, and call the arsenal directly.
import "./arsenal.css";

/** The game's input module, as far as this needs it: it shows or hides the touch layer's USE button. */
export interface TouchInput {
  setPrompt?(on: boolean): void;
}

export interface TouchKit {
  throwCharge(): boolean;
  swing(): boolean;
  charges(): number;
}

/**
 * Adds the two buttons to the touch layer when it exists (the game builds it at the first touch). Returns its undo.
 *
 * It also keeps the layer's USE button in step with the prompt on screen. The game only tells that button when the
 * prompt changes, so a prompt that was already showing when the first touch built the layer left it hidden: a v2
 * raid opens on "HOLD USE — TAKE THE RIFLE", and a phone had no USE button to hold.
 */
export function addTouchButtons(kit: TouchKit, doc: Document = document, input: TouchInput | null = null): () => void {
  let made: HTMLElement[] = [];
  let count: HTMLElement | null = null;
  let chargeBtn: HTMLElement | null = null;

  const button = (cls: string, label: string, name: string, act: () => boolean) => {
    const b = doc.createElement("button");
    b.className = `t-btn ${cls}`;
    b.setAttribute("aria-label", name);
    const span = doc.createElement("span");
    span.textContent = label;
    b.append(span);
    let last = -Infinity; // never pressed: the first press always counts
    const press = (e: Event) => {
      e.preventDefault();
      e.stopPropagation();
      const now = performance.now();
      if (now - last < 120) return; // a touch is followed by a made-up mouse press: one act, not two
      last = now;
      if (act()) {
        b.classList.add("active");
        setTimeout(() => b.classList.remove("active"), 160);
      }
    };
    b.addEventListener("touchstart", press, { passive: false });
    b.addEventListener("mousedown", press);
    return b;
  };

  const mount = () => {
    const layer = doc.querySelector(".touch");
    if (!layer || layer.querySelector(".t-charge")) return !!layer;
    chargeBtn = button("t-charge", "CHG", "Throw a breaker charge", () => kit.throwCharge());
    count = doc.createElement("i");
    chargeBtn.append(count);
    const butt = button("t-butt", "HIT", "Swing the rifle butt", () => kit.swing());
    layer.append(chargeBtn, butt);
    made = [chargeBtn, butt];
    return true;
  };

  // The count on the button follows the kit; with none left the button dims.
  const sync = () => {
    if (!mount() || !count || !chargeBtn) return;
    input?.setPrompt?.(!!doc.querySelector(".h-prompt.on"));
    const n = kit.charges();
    if (count.textContent !== String(n)) count.textContent = String(n);
    chargeBtn.classList.toggle("empty", n <= 0);
  };
  sync();
  const timer = setInterval(sync, 250);
  // The first touch is what builds the layer: look again as soon as it has.
  const onTouch = () => setTimeout(sync, 0);
  doc.addEventListener("touchstart", onTouch, { passive: true, capture: true });
  return () => {
    clearInterval(timer);
    doc.removeEventListener("touchstart", onTouch, true);
    for (const b of made) b.remove();
  };
}
