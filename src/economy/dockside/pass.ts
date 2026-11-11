// The dock pass card, shown on the first visit: pick a callsign, claim the pass. Plain words; the chain is one
// "what's this?" away for anyone curious. The pass itself is drawn as a laminated card that fills in as you type
// and takes a stamp when the claim settles.
import { RULES } from "../items";
import type { Chain, Wallet } from "../types";
import { h, text } from "./dom";
import { accountUrl, AMBIGUOUS, CALLSIGN_MAX, checkCallsign, shortAccount } from "./format";

export interface PassCard {
  readonly el: HTMLElement;
  focus(): void;
}

/** A barcode from the callsign: bar widths from a string hash, so the same callsign always prints the same pass. */
export function barcode(s: string, bars = 34): number[] {
  let x = 2166136261;
  for (const c of s || "SALTLINE") x = Math.imul(x ^ c.charCodeAt(0), 16777619) >>> 0;
  const out: number[] = [];
  for (let i = 0; i < bars; i++) {
    x = Math.imul(x ^ (x >>> 13), 0x5bd1e995) >>> 0;
    out.push(1 + (x % 3));
  }
  return out;
}

export function createPass(opts: { chain: Chain; wallet: Wallet; onDone: () => void; onSound?: () => void }): PassCard {
  const { chain, wallet } = opts;
  const input = h("input", {
    class: "dk-cs-in",
    id: "dk-callsign",
    type: "text",
    autocomplete: "off",
    autocapitalize: "characters",
    spellcheck: "false",
    placeholder: "e.g. WREN",
    "aria-describedby": "dk-cs-hint",
  });
  const count = h("span", { class: "dk-cs-count" }, `0/${CALLSIGN_MAX}`);
  const hint = h("p", { class: "dk-cs-hint", id: "dk-cs-hint" }, "3 to 16 characters: letters, numbers, space, - . _");
  const claim = h("button", { class: "btn primary dk-claim", type: "submit" }, "Claim dock pass");
  const status = h("p", { class: "dk-pass-status", role: "status", "aria-live": "polite", "data-state": "idle" });
  const shownName = h("b", { class: "dk-pc-name" }, "CALLSIGN");
  const bars = h("span", { class: "dk-pc-bars", "aria-hidden": "true" });
  const stamp = h("span", { class: "dk-pc-stamp", "aria-hidden": "true" }, h("b", null, String(RULES.starterScrip)), h("i", null, "scrip"));
  const id = wallet.accountId();
  const url = id ? accountUrl(chain.network, id) : null;

  const card = h(
    "div",
    { class: "dk-pc", "aria-hidden": "true" },
    h("div", { class: "dk-pc-band" }, h("span", null, "Dock pass"), h("span", null, "Berth 4")),
    h(
      "div",
      { class: "dk-pc-body" },
      h("span", { class: "dk-pc-k" }, "Callsign"),
      shownName,
      h("span", { class: "dk-pc-meta" }, `Saltline Port Authority · issued ${new Date().toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" }).toUpperCase()}`),
      bars,
    ),
    stamp,
  );

  const form = h(
    "form",
    { class: "dk-pass-form", novalidate: true },
    h("label", { class: "dk-cs-l", for: "dk-callsign" }, h("span", null, "Callsign"), count),
    input,
    hint,
    h("p", { class: "dk-pass-gift" }, `Your dock pass comes with ${RULES.starterScrip} scrip.`),
    claim,
    status,
  );

  const what = h(
    "details",
    { class: "dk-what" },
    h("summary", null, "What's this?"),
    h(
      "p",
      null,
      chain.network === "testnet"
        ? "Your cargo and scrip live on NEAR testnet, a public ledger, under an account made for you in this browser. No sign-up, no fees."
        : "On this build your cargo and scrip live on a local mock ledger. The live game keeps them on NEAR testnet.",
    ),
    h(
      "p",
      { class: "dk-what-acct" },
      "Account ",
      h("code", null, id ? shortAccount(id) : "made when you claim"),
      url ? " · " : null,
      url ? h("a", { href: url, target: "_blank", rel: "noopener" }, "view on explorer ↗") : null,
    ),
  );

  const el = h(
    "section",
    { class: "dk-pass", role: "dialog", "aria-modal": "true", "aria-labelledby": "dk-pass-h" },
    h("div", { class: "m-k" }, "Saltline Port Authority · Berth 4"),
    h("h2", { class: "dk-pass-h", id: "dk-pass-h" }, "Sign on"),
    h("p", { class: "dk-pass-lede" }, "Brokers only deal with pass holders. Pick the name that goes on your pass, your wrecks and the board."),
    card,
    form,
    what,
  );

  let busy = false;
  const paint = () => {
    const c = checkCallsign(input.value);
    text(shownName, c.callsign || "CALLSIGN");
    shownName.classList.toggle("empty", !c.callsign);
    text(count, `${c.callsign.length}/${CALLSIGN_MAX}`);
    count.classList.toggle("over", c.callsign.length > CALLSIGN_MAX);
    bars.replaceChildren(...barcode(c.callsign).map((w, i) => h("i", { style: `width:${w}px`, class: i % 2 ? "gap" : "" })));
    return c;
  };
  input.addEventListener("input", () => {
    const pos = input.selectionStart;
    const up = input.value.toUpperCase();
    if (up !== input.value) {
      input.value = up;
      input.setSelectionRange?.(pos, pos);
    }
    const c = paint();
    // Only nag once there is something to judge.
    const show = !c.ok && c.callsign.length >= 3;
    hint.dataset.state = show || c.callsign.length > CALLSIGN_MAX ? "error" : c.ok ? "ok" : "idle";
    text(hint, show || c.callsign.length > CALLSIGN_MAX ? (c as { error: string }).error : c.ok ? "Looks good." : "3 to 16 characters: letters, numbers, space, - . _");
    input.setAttribute("aria-invalid", String(hint.dataset.state === "error"));
  });

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (busy) return;
    const c = paint();
    if (!c.ok) {
      hint.dataset.state = "error";
      text(hint, c.error);
      input.setAttribute("aria-invalid", "true");
      input.focus();
      return;
    }
    opts.onSound?.();
    busy = true;
    el.dataset.state = "pending";
    claim.disabled = true;
    input.readOnly = true;
    status.dataset.state = "pending";
    text(status, "Settling… issuing your pass");
    let r: Awaited<ReturnType<Wallet["claim"]>> | null = null;
    try {
      r = await wallet.claim(c.callsign);
    } catch {
      r = null;
    }
    if (r && r.ok) {
      status.dataset.state = "ok";
      text(status, `Pass issued to ${c.callsign}. ${RULES.starterScrip} scrip on it.`);
      el.dataset.state = "done";
      setTimeout(opts.onDone, 1300);
      return;
    }
    if (!r) {
      // No answer: it may have landed. Check before letting them claim again.
      let reg: boolean | null = null;
      try {
        reg = await wallet.registered();
      } catch {
        reg = null;
      }
      if (reg) {
        status.dataset.state = "ok";
        text(status, "Your pass is on the books.");
        el.dataset.state = "done";
        setTimeout(opts.onDone, 900);
        return;
      }
      status.dataset.state = "unknown";
      text(status, AMBIGUOUS);
    } else {
      status.dataset.state = "error";
      text(status, r.error ? `${r.error}.`.replace(/\.\.$/, ".") : "The dock office refused that.");
    }
    busy = false;
    el.dataset.state = "";
    claim.disabled = false;
    input.readOnly = false;
  });

  paint();
  return {
    el,
    focus() {
      try {
        input.focus({ preventScroll: true });
      } catch {
        /* focus is best effort */
      }
    },
  };
}
