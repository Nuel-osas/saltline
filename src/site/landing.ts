// The front page (index.html). It draws what the game's own numbers say (items.ts: the invoice, the frames, the
// blueprints), reads the live economy from the v2 contract (live.ts), and runs the scroll: the yard folding back
// into a photograph, the invoice filling the screen line by line, and the meter down the side that bills the reader
// for scrolling. No dependency beyond the game's own modules.
import { resolveV2Config } from "../economy/v2/config";
import { gunSvg } from "../economy/v2/dock/gunart";
import { BLUEPRINTS, FRAMES, FRAME_IDS, INVOICE, ISSUE, MATERIALS } from "../economy/v2/items";
import type { FrameId, MaterialId } from "../economy/v2/types";
import { type EconomyView, type HarbormasterView, type Quote, type RecentLine, type VendorView, ago, amount, bestBid, fmt, meterValue, read } from "./live";

type Child = Node | string | null | false | undefined;
const $ = <T extends HTMLElement = HTMLElement>(sel: string, root: ParentNode = document) => root.querySelector<T>(sel);
const $$ = <T extends HTMLElement = HTMLElement>(sel: string, root: ParentNode = document) => [...root.querySelectorAll<T>(sel)];
function h(tag: string, attrs: Record<string, string | null> | null, ...kids: Child[]): HTMLElement {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs ?? {})) if (v != null) el.setAttribute(k, v);
  for (const kid of kids) if (kid) el.append(kid);
  return el;
}
const fill = (el: Element, ...kids: Child[]) => el.replaceChildren(...kids.filter((k): k is Node | string => !!k));
const clamp = (n: number) => Math.min(1, Math.max(0, n));
// The explorer's account page. Same site as config.ts's TESTNET_EXPLORER_TX; the /address/<account> route is
// NearBlocks' own pattern. Not checked by a script (the site answers scripts with a challenge page): click it once.
const EXPLORER_ADDRESS = "https://testnet.nearblocks.io/address/";
const UNKNOWN = "The chain didn't answer. This is not zero.";

document.documentElement.dataset.js = "1";

// ---------------------------------------------------------------------------------------------------------------
// What the game's own numbers say.

const n = (v: number) => fmt(BigInt(v));

function drawBill() {
  const rows: [string, string][] = [
    ["Going over the fence", n(INVOICE.entry)],
    ["Each earlier raid you got home from", `+${n(INVOICE.perExtraction)}`],
    ["Each minute on site", n(INVOICE.perMinute)],
    ["Cutting a customs seal", n(INVOICE.seal)],
    ["Cargo, per unit of weight", n(INVOICE.perWeight)],
    ["Cutting an uplink", n(INVOICE.uplink)],
    ["Destroying a gull / a hound", `${n(INVOICE.gull)} / ${n(INVOICE.hound)}`],
  ];
  $("[data-bill]")?.replaceChildren(...rows.map(([what, cost]) => h("tr", null, h("td", null, what), h("td", null, cost))));

  const rungs: [number, string, string, boolean][] = [
    [INVOICE.secondNotice, "Second notice", "More inspection units on patrol.", false],
    [INVOICE.bailiff, "Final demand", "The Bailiff is sent.", true],
    [INVOICE.secondBailiff, "A second Bailiff", "It is sent as well.", false],
    [INVOICE.foreclosure, "Foreclosure", "The Assessor walks to the boat.", true],
  ];
  $("[data-rungs]")?.replaceChildren(
    h("li", { class: "rungs-cap", style: "display:block;border:0;padding-top:0" }, "What it brings"),
    ...rungs.map(([at, name, what, hot]) => h("li", { class: hot ? "hot" : null }, h("b", null, n(at)), h("span", null, name, h("i", null, what)))),
  );
}

/** The invoice's line items, for the wipe. */
function drawLines() {
  const lines: [string, string][] = [
    ["Trespass surcharge", n(INVOICE.entry)],
    ["Time on site, per minute", n(INVOICE.perMinute)],
    ["Customs seal, cut", n(INVOICE.seal)],
    ["Cargo removed, per unit of weight", n(INVOICE.perWeight)],
    ["Uplink relay, cut", n(INVOICE.uplink)],
    ["Inspection unit (gull), destroyed", n(INVOICE.gull)],
    ["Inspection unit (hound), destroyed", n(INVOICE.hound)],
    ["Carried forward from your last visit", "half"],
    ["Total", "payable on exit"],
  ];
  $("[data-lines]")?.replaceChildren(...lines.map(([what, cost]) => h("li", null, h("span", null, what), h("b", null, cost))));
}

const materialName = (id: string) => (id in MATERIALS ? MATERIALS[id as MaterialId].name.toLowerCase() : id);
const range = ([lo, hi]: readonly [number, number], unit = "") => `${n(lo)}–${n(hi)}${unit}`;

function gunCard(frame: FrameId | "issue"): HTMLElement {
  const art = h("div", { class: "gun-art" });
  art.innerHTML = gunSvg(frame); // our own drawing (dock/gunart.ts), no outside input
  if (frame === "issue") {
    const s = ISSUE.stats;
    return h(
      "article",
      { class: "gun", "data-frame": "issue" },
      h("div", { class: "gun-k" }, h("span", null, "PAC-9"), h("span", null, "Issued at the gate")),
      h("div", null, h("h3", null, "Issue"), h("p", { class: "gun-line" }, "Port Authority property. Everyone gets one. Nobody wants it.")),
      h(
        "div",
        null,
        art,
        stats([
          ["Damage", n(s.damage)],
          ["Fire rate", n(s.rpm)],
          ["Magazine", n(s.mag)],
          ["Range", `${n(s.range)} m`],
        ]),
      ),
      h("p", { class: "gun-foot" }, "Not an NFT. It can't be sold and it can't be lost."),
    );
  }
  const f = FRAMES[frame];
  const [model, ...word] = f.name.split(" ");
  const bp = BLUEPRINTS[frame];
  const parts = (Object.entries(bp.inputs) as [MaterialId, number][]).map(([id, count]) => `${count} ${materialName(id)}`).join(", ");
  return h(
    "article",
    { class: "gun", "data-frame": frame },
    h("div", { class: "gun-k" }, h("span", null, model), h("span", null, "NFT · rolled when built")),
    h("div", null, h("h3", null, word.join(" ")), h("p", { class: "gun-line" }, f.line)),
    h(
      "div",
      null,
      art,
      stats([
        ["Damage", range(f.bands.damage)],
        ["Fire rate", range(f.bands.rpm)],
        ["Magazine", range(f.bands.mag)],
        ["Range", range(f.bands.range, " m")],
      ]),
    ),
    h("p", { class: "gun-foot" }, `Built from ${parts}, and a fee of `, h("b", null, `${n(bp.fee)} scrip`), "."),
  );
}
const stats = (rows: [string, string][]) => h("dl", null, ...rows.flatMap(([k, v]) => [h("dt", null, k), h("dd", null, v)]));

function drawRack() {
  $("[data-rack]")?.replaceChildren(...FRAME_IDS.map(gunCard), gunCard("issue"));
}

// ---------------------------------------------------------------------------------------------------------------
// What the contract says, read a moment ago.

const row = (k: string, v: Child, cls?: string) => h("div", null, h("dt", null, k), h("dd", cls ? { class: cls } : null, v));
/** A row whose value takes the whole width under its label: an account id is too long to sit beside it. */
const wideRow = (k: string, v: Child) => h("div", { class: "wide" }, h("dt", null, k), h("dd", null, v));
const say = (text: string) => h("div", null, h("dd", { class: "say" }, `“${text}”`));
const account = (id: string) => h("a", { href: EXPLORER_ADDRESS + id, rel: "noopener", target: "_blank" }, id);
const unknownRows = (why = UNKNOWN) => [row("Wallet", "unknown", "unk"), h("div", null, h("dd", { class: "say unk" }, why))];

function paintVendor(who: string, v: VendorView | null | undefined, why?: string) {
  const dl = $(`[data-who="${who}"] [data-live]`);
  if (!dl) return;
  if (!v) return dl.replaceChildren(...unknownRows(why));
  const bid = bestBid(v.bids);
  fill(
    dl,
    row("Wallet", `${fmt(amount(v.scrip))} scrip`),
    row("Shop", v.open ? "Open" : "Closed: out of money"),
    bid ? row("Pays most for", `${materialName(bid.token_id)} · ${fmt(amount(bid.price))}`) : row("Buying", "nothing today"),
    bid && bid.reason ? say(bid.reason) : null,
    wideRow("Account", account(v.account_id)),
  );
}

function paintDesk(quotes: Quote[] | null, contractId: string | null, why?: string) {
  const dl = $('[data-who="desk"] [data-live]');
  if (!dl) return;
  if (!quotes || !contractId) return dl.replaceChildren(row("Prices", "unknown", "unk"), h("div", null, h("dd", { class: "say unk" }, why ?? UNKNOWN)));
  const top = bestBid(quotes);
  fill(
    dl,
    top ? row("Pays most for", `${materialName(top.token_id)} · ${fmt(amount(top.price))}`) : row("Buying", "nothing today"),
    top && top.reason ? say(top.reason) : null,
    row("Run by", "the contract's fixed curve"),
    wideRow("Account", account(contractId)),
  );
}

const POSTURE: Record<string, string> = {
  patrols: "More machines on patrol",
  pursuit: "A faster Bailiff",
};

function paintHarbormaster(hm: HarbormasterView | null, why?: string) {
  const dl = $('[data-who="harbormaster"] [data-live]');
  if (!dl) return;
  if (!hm) return dl.replaceChildren(...unknownRows(why));
  fill(
    dl,
    row("Wallet", `${fmt(amount(hm.balance))} scrip`),
    row("Strength", `${Number.isFinite(hm.strength) ? hm.strength : "unknown"} of 100`),
    row("Spending it on", POSTURE[hm.posture] ?? hm.posture),
    row("Sends the Bailiff at", fmt(amount(hm.bailiff_at))),
    hm.last_memo ? say(hm.last_memo) : null,
    wideRow("Account", account(hm.account_id)),
  );
}

function paintStats(e: EconomyView | null, why?: string) {
  const cell = (label: string, value: string | null, small?: string) =>
    h("div", null, h("dt", null, label), value == null ? h("dd", { class: "unk" }, "unknown") : h("dd", null, value, small ? h("small", null, small) : null));
  const dl = $("[data-stats]");
  if (!dl) return;
  if (!e) {
    dl.replaceChildren(
      cell("Breachers signed on", null),
      cell("Scrip in circulation", null),
      cell("Scrip made, last 24 hours", null),
      cell("Guns built", null),
    );
    dl.after(h("p", { class: "sources unk" }, why ?? UNKNOWN));
    return;
  }
  const count = (v: number) => (Number.isSafeInteger(v) && v >= 0 ? n(v) : null);
  fill(
    dl,
    cell("Breachers signed on", count(e.players)),
    cell("Scrip in circulation", amount(e.scrip_supply) == null ? null : fmt(amount(e.scrip_supply))),
    cell("Scrip made, last 24 hours", amount(e.minted_24h) == null ? null : fmt(amount(e.minted_24h)), `${fmt(amount(e.burned_24h))} destroyed`),
    cell("Guns built", count(e.weapons_built), `${count(e.weapons_alive) ?? "unknown"} alive · ${count(e.weapons_destroyed) ?? "unknown"} destroyed`),
  );
}

function paintOnRack(vendors: VendorView[] | null, why?: string) {
  const ul = $("[data-onrack]");
  if (!ul) return;
  if (!vendors) return ul.replaceChildren(h("li", { class: "unk" }, why ?? UNKNOWN));
  const guns = vendors.flatMap((v) => (v.guns ?? []).map((g) => ({ v, g }))).slice(0, 6);
  if (!guns.length) return ul.replaceChildren(h("li", { class: "unk" }, "The rack is empty. Someone has to carry the parts out first."));
  ul.replaceChildren(
    ...guns.map(({ v, g }) => {
      const w = g.weapon;
      const name = w.frame in FRAMES ? FRAMES[w.frame as FrameId].name.split(" ").slice(1).join(" ") : w.frame;
      return h(
        "li",
        null,
        h("b", null, name),
        h("span", null, `${w.serial} · grade ${w.grade} · condition ${w.condition}% · built by ${w.maker_callsign ?? v.name}`),
        h("em", null, `${fmt(amount(g.price))} scrip`),
      );
    }),
  );
}

function paintWire(lines: RecentLine[] | null, why?: string) {
  const ul = $("[data-wire]");
  if (!ul) return;
  if (!lines) return ul.replaceChildren(h("li", { class: "unk" }, why ?? UNKNOWN));
  if (!lines.length) return ul.replaceChildren(h("li", { class: "unk" }, "Quiet. Nobody has been over the fence lately."));
  const now = Date.now();
  ul.replaceChildren(...lines.slice(0, 8).map((l) => h("li", null, h("time", null, ago(l.at, now)), h("span", null, String(l.text ?? "")))));
}

async function live() {
  let cfg: ReturnType<typeof resolveV2Config> | null = null;
  try {
    cfg = resolveV2Config(import.meta.env as Record<string, unknown>, "");
  } catch {
    cfg = null;
  }
  const link = $<HTMLAnchorElement>("[data-contract-link]");
  if (!cfg || cfg.mode !== "testnet") {
    const why = "This copy of the page isn't connected to the chain.";
    link?.remove();
    paintStats(null, why);
    paintOnRack(null, why);
    paintWire(null, why);
    paintVendor("moss", null, why);
    paintVendor("ines", null, why);
    paintDesk(null, null, why);
    paintHarbormaster(null, why);
    return;
  }
  const { rpcUrls, contractId } = cfg;
  if (link) link.href = EXPLORER_ADDRESS + contractId;
  const [economy, hm, vendors, desk, recent] = await Promise.all([
    read<EconomyView>(rpcUrls, contractId, "economy"),
    read<HarbormasterView>(rpcUrls, contractId, "harbormaster"),
    read<VendorView[]>(rpcUrls, contractId, "vendors"),
    read<Quote[]>(rpcUrls, contractId, "export_prices"),
    read<RecentLine[]>(rpcUrls, contractId, "recent", { limit: 8 }),
  ]);
  paintStats(economy);
  paintOnRack(vendors);
  paintWire(recent);
  paintVendor(
    "moss",
    vendors?.find((v) => v.id === "moss"),
  );
  paintVendor(
    "ines",
    vendors?.find((v) => v.id === "ines"),
  );
  paintDesk(desk, contractId);
  paintHarbormaster(hm);
  const at = new Date().toISOString().slice(11, 16);
  $("[data-sources]")?.replaceChildren(
    "Read from ",
    account(contractId),
    ` on NEAR testnet at ${at} UTC. Testnet scrip and guns are real tokens with no money value.`,
  );
}

// ---------------------------------------------------------------------------------------------------------------
// The scroll.

const NOTICES: [number, string][] = [
  [INVOICE.secondNotice, "Second notice. A viewing surcharge has been added to your account."],
  [INVOICE.bailiff, "Final demand. A Bailiff has been sent to your position on this page."],
  [INVOICE.secondBailiff, "A second Bailiff has been sent. This is not a negotiation."],
  [INVOICE.foreclosure, "Foreclosure. The Assessor will meet you at the Play button."],
];

function scroll() {
  const hero = $("[data-hero]");
  const art = $("[data-hero-art]");
  const copy = $("[data-hero-copy]");
  const wipe = $("[data-wipe]");
  const lines = $$("[data-lines] li");
  const stamp = $("[data-stamp]");
  const meter = $("[data-meter]");
  const meterN = $("[data-meter-n]");
  const notice = $("[data-notice]");
  const marks = $$<HTMLElement>("[data-meter] u[data-at]");
  const max = INVOICE.foreclosure;
  for (const m of marks) m.style.setProperty("--at", String(Number(m.dataset.at) / max));
  let billed = 0;
  let hide = 0;
  let queued = false;

  const frame = () => {
    queued = false;
    const y = scrollY;
    const vh = innerHeight;
    if (hero && art && copy) {
      const p = clamp(y / Math.max(1, hero.offsetHeight - vh));
      hero.style.setProperty("--p", p.toFixed(4));
      copy.style.opacity = String(clamp(1 - p * 1.9));
      copy.style.pointerEvents = p > 0.45 ? "none" : "";
    }
    if (wipe) {
      const p = clamp((y - wipe.offsetTop) / Math.max(1, wipe.offsetHeight - vh));
      lines.forEach((li, i) => li.style.setProperty("--k", clamp((p - (0.1 + (0.56 * i) / Math.max(1, lines.length - 1))) / 0.18).toFixed(4)));
      stamp?.style.setProperty("--s", clamp((p - 0.84) / 0.1).toFixed(4));
    }
    if (meter && meterN) {
      const p = clamp(y / Math.max(1, document.documentElement.scrollHeight - vh));
      const value = meterValue(p, max);
      meter.style.setProperty("--p", p.toFixed(4));
      meterN.textContent = fmt(BigInt(value));
      meter.toggleAttribute("data-hot", value >= INVOICE.bailiff);
      for (const m of marks) m.toggleAttribute("data-passed", value >= Number(m.dataset.at));
      const crossed = NOTICES.filter(([at]) => billed < at && value >= at).pop();
      if (crossed && notice) {
        notice.replaceChildren(h("b", null, "The Harbormaster"), crossed[1]);
        notice.hidden = false;
        requestAnimationFrame(() => notice.setAttribute("data-on", ""));
        clearTimeout(hide);
        hide = window.setTimeout(() => notice.removeAttribute("data-on"), 5200);
      }
      billed = value;
    }
  };
  const queue = () => {
    if (!queued) ((queued = true), requestAnimationFrame(frame));
  };
  addEventListener("scroll", queue, { passive: true });
  addEventListener("resize", queue);
  frame();
}

function observe() {
  if (!("IntersectionObserver" in window)) return $$("[data-reveal]").forEach((el) => el.setAttribute("data-in", ""));
  const reveal = new IntersectionObserver(
    (entries) => {
      for (const e of entries) if (e.isIntersecting) (e.target.setAttribute("data-in", ""), reveal.unobserve(e.target));
    },
    { rootMargin: "0px 0px -8% 0px", threshold: 0.08 },
  );
  $$("[data-reveal]").forEach((el) => reveal.observe(el));

  // The bar's link for the section under the middle of the screen.
  const links = $$<HTMLAnchorElement>("[data-nav]");
  const current = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        const id = (e.target as HTMLElement).dataset.section;
        for (const a of links) a.dataset.nav === id ? a.setAttribute("aria-current", "true") : a.removeAttribute("aria-current");
      }
    },
    { rootMargin: "-50% 0px -50% 0px" },
  );
  $$("[data-section]").forEach((el) => current.observe(el));
}

drawBill();
drawLines();
drawRack();
scroll();
observe();
void live();
