// The dock pass card, shown on the first visit: pick a callsign, claim the pass. Plain words; the chain is one
// "what's this?" away for anyone curious. The pass itself is drawn as a laminated card that fills in as you type
// and takes a stamp when the claim settles.
import { RAID } from "../items";
import type { Chain2, Wallet2 } from "../types";
import { h, text } from "../../dockside/dom";
import { accountUrl, AMBIGUOUS, CALLSIGN_MAX, checkCallsign, shortAccount } from "../../dockside/format";

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

export interface PassOptions {
  chain: Chain2;
  wallet: Wallet2;
  onDone: () => void;
  onSound?: () => void;
  /** The line under the heading (default: the Dockside's own). */
  lede?: string;
  /** The claim button's label (default "Claim dock pass"). */
  claimLabel?: string;
  /** Said after the pass is issued, before onDone (e.g. "Deploying…"). */
  doneNote?: string;
  /** A warning shown in the status line before anything is claimed (e.g. the pass status is unknown). */
  notice?: string;
  /** A way on without a pass: a small link under the form. */
  skip?: { label: string; note: string; onSkip: () => void };
}

export const PASS_LEDE = "Moss and Ines only deal with pass holders. Pick the name that goes on your pass, your guns and your wrecks.";

export function createPass(opts: PassOptions): PassCard {
  const { chain, wallet } = opts;
  const input = h("input", {
    class: "d2-cs-in",
    id: "d2-callsign",
    type: "text",
    autocomplete: "off",
    autocapitalize: "characters",
    spellcheck: "false",
    placeholder: "e.g. WREN",
    "aria-describedby": "d2-cs-hint",
  });
  const count = h("span", { class: "d2-cs-count" }, `0/${CALLSIGN_MAX}`);
  const hint = h("p", { class: "d2-cs-hint", id: "d2-cs-hint" }, "3 to 16 characters: letters, numbers, space, - . _");
  const claim = h("button", { class: "btn primary d2-claim", type: "submit" }, opts.claimLabel ?? "Claim dock pass");
  const status = h("p", { class: "d2-pass-status", role: "status", "aria-live": "polite", "data-state": "idle" });
  const shownName = h("b", { class: "d2-pc-name" }, "CALLSIGN");
  const bars = h("span", { class: "d2-pc-bars", "aria-hidden": "true" });
  const stamp = h("span", { class: "d2-pc-stamp", "aria-hidden": "true" }, h("b", null, String(RAID.starterScrip)), h("i", null, "scrip"));
  const id = wallet.accountId();
  const url = id ? accountUrl(chain.network, id) : null;

  const card = h(
    "div",
    { class: "d2-pc", "aria-hidden": "true" },
    h("div", { class: "d2-pc-band" }, h("span", null, "Dock pass"), h("span", null, "Berth 4")),
    h(
      "div",
      { class: "d2-pc-body" },
      h("span", { class: "d2-pc-k" }, "Callsign"),
      shownName,
      h("span", { class: "d2-pc-meta" }, `Dock Office · issued ${new Date().toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" }).toUpperCase()}`),
      bars,
      h("span", { class: "d2-pc-ledger" }, "Written on the open ledger"),
    ),
    stamp,
  );

  const form = h(
    "form",
    { class: "d2-pass-form", novalidate: true },
    h("label", { class: "d2-cs-l", for: "d2-callsign" }, h("span", null, "Callsign"), count),
    input,
    hint,
    h("p", { class: "d2-pass-gift" }, `Your dock pass comes with ${RAID.starterScrip} scrip.`),
    claim,
    status,
  );

  const what = h(
    "details",
    { class: "d2-what" },
    h("summary", null, "What's this?"),
    h(
      "p",
      null,
      chain.network === "testnet"
        ? "Your pass, your guns and your scrip are written on the open ledger: NEAR testnet, where anyone can read them and nobody can quietly change them. The account was made for you in this browser. No sign-up, no fees."
        : "On this build your guns and scrip are written on a local stand-in ledger. The live game keeps them on the open ledger, NEAR testnet, where each gun is a token you own.",
    ),
    h(
      "p",
      { class: "d2-what-acct" },
      "Account ",
      h("code", null, id ? shortAccount(id) : "made when you claim"),
      url ? " · " : null,
      url ? h("a", { href: url, target: "_blank", rel: "noopener" }, "view on explorer ↗") : null,
    ),
  );

  let busy = false;
  const skip = opts.skip
    ? h(
        "button",
        {
          class: "d2-skip",
          type: "button",
          onclick: () => {
            if (!busy) opts.skip!.onSkip();
          },
        },
        h("span", null, opts.skip.label),
        h("i", null, opts.skip.note),
      )
    : null;

  const el = h(
    "section",
    { class: "d2-pass", role: "dialog", "aria-modal": "true", "aria-labelledby": "d2-pass-h", "data-mode": opts.skip ? "deploy" : null },
    h("div", { class: "m-k" }, "Dock Office · Open Ledger"),
    h("h2", { class: "d2-pass-h", id: "d2-pass-h" }, "Sign on"),
    h("p", { class: "d2-pass-lede" }, opts.lede ?? PASS_LEDE),
    card,
    form,
    skip,
    what,
  );

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
    if (skip) skip.disabled = true;
    input.readOnly = true;
    status.dataset.state = "pending";
    text(status, "Settling… issuing your pass");
    let r: Awaited<ReturnType<Wallet2["claim"]>> | null = null;
    try {
      r = await wallet.claim(c.callsign);
    } catch {
      r = null;
    }
    const then = opts.doneNote ? ` ${opts.doneNote}` : "";
    if (r && r.ok) {
      status.dataset.state = "ok";
      text(status, `Pass issued to ${c.callsign}. ${RAID.starterScrip} scrip on it.${then}`);
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
        text(status, `Your pass is on the books.${then}`);
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
    if (skip) skip.disabled = false;
    input.readOnly = false;
  });

  paint();
  if (opts.notice) {
    status.dataset.state = "unknown";
    text(status, opts.notice);
  }
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
