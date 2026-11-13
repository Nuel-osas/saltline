// THE MARKET: other players' guns, as cards with prices. Filters by frame and grade, the last sale prices for that
// frame and grade on every card, BUY. Your own listings with CANCEL. LIST A GUN: pick one, set a price with the
// appraisal and recent sales as guides, and see the fee and the maker's share before you commit. Listed items sit
// in a small section of their own.
import { h } from "../../dockside/dom";
import { ago, fmt, UNKNOWN } from "../../dockside/format";
import { FRAME_IDS, MARKET, TOKEN_NAMES } from "../items";
import type { EconomyView, FrameId, Grade, Listing, Weapon } from "../types";
import { frameWord, gunCard, gunTile } from "./guncard";
import { actBtn, emptyLine, head, okv, painter, plural, scripEl, type Ctx } from "./store";

const GRADES: Grade[] = ["A", "B", "C", "D"];

/** Where a sale's price goes: 2% to the gun's maker, 2% burned, the rest to the seller (docs/CONTRACT_V2.md). */
export function saleSplit(price: number): { fee: number; maker: number; burned: number; seller: number } {
  const maker = Math.floor((price * MARKET.makerPct) / 100);
  const burned = Math.floor((price * (MARKET.feePct - MARKET.makerPct)) / 100);
  return { fee: maker + burned, maker, burned, seller: price - maker - burned };
}

/** The last sale prices for a frame and grade: [] when none has sold, null when the economy couldn't be read. */
export const salesFor = (eco: EconomyView | null, frame: FrameId, grade: Grade): number[] | null =>
  eco ? (eco.lastSales.find((s) => s.frame === frame && s.grade === grade)?.prices ?? []) : null;

export function createMarket(ctx: Ctx) {
  const el = h("div", { class: "d2-market" });
  let frame: FrameId | "all" = "all";
  let grade: Grade | "all" = "all";
  let listSerial: string | null = null;
  let priceText = "";

  const seg = <T extends string>(label: string, cur: T, options: { id: T; label: string }[], pick: (v: T) => void) =>
    h(
      "div",
      { class: "d2-filter", role: "group", "aria-label": label },
      h("span", null, label),
      h("div", { class: "d2-seg" }, ...options.map((o) => h("button", { class: "d2-seg-b", type: "button", "data-k": `f:${label}:${o.id}`, "data-v": o.id, "aria-pressed": String(cur === o.id), onclick: () => pick(o.id) }, o.label))),
    );

  function buy(l: Listing) {
    const what = l.weapon ? `${l.weapon.grade}-grade ${frameWord(l.weapon.frame)} ${l.weapon.serial}` : l.item ? `${l.item.amount} × ${TOKEN_NAMES[l.item.tokenId]}` : "lot";
    void ctx.act({
      key: `buy:${l.id}`,
      settling: `Settling: buying the ${what} from ${l.callsign}…`,
      run: () => ctx.chain.buyListing(l.id),
      done: (r) => `Bought the ${what} for ${r.paid == null ? UNKNOWN : `${fmt(r.paid)} scrip`}. It's in your stash.`,
      refresh: ["listings", "economy"],
    });
  }

  function listingCard(l: Listing, w: Weapon, eco: EconomyView | null) {
    const me = ctx.me();
    const scrip = ctx.holding("scrip");
    const own = l.seller === me;
    const short = scrip == null ? `Your scrip is ${UNKNOWN}` : scrip < l.price ? `${fmt(l.price - scrip)} scrip short` : null;
    return gunCard(w, {
      me,
      tag: own ? "Your listing" : `Listed by ${l.callsign} · ${ago(l.at)}`,
      price: { label: own ? "You ask" : `${l.callsign} asks`, amount: l.price },
      sales: salesFor(eco, w.frame, w.grade),
      actions: [
        own
          ? actBtn(ctx, { k: `cancel:${l.id}`, label: "Cancel listing", onclick: () => cancel(l) })
          : actBtn(ctx, { k: `buy:${l.id}`, label: "Buy", cls: "solid", disabled: !!short, why: short, onclick: () => buy(l) }),
        !own && short ? h("span", { class: "d2-why" }, short) : null,
      ],
    });
  }

  function cancel(l: Listing) {
    void ctx.act({
      key: `cancel:${l.id}`,
      settling: `Settling: taking ${l.weapon?.serial ?? "your lot"} off the market…`,
      run: () => ctx.chain.cancelListing(l.id),
      done: () => `${l.weapon?.serial ?? "Your lot"} is off the market and back in your stash.`,
      refresh: ["listings"],
    });
  }

  function listPanel(weapons: Weapon[] | null, eco: EconomyView | null) {
    const held = weapons?.filter((w) => w.state === "held") ?? [];
    if (listSerial && !held.some((w) => w.serial === listSerial)) listSerial = null;
    const w = held.find((x) => x.serial === listSerial) ?? null;
    const price = /^\d{1,7}$/.test(priceText.trim()) ? parseInt(priceText.trim(), 10) : null;
    const split = price ? saleSplit(price) : null;
    const sales = w ? salesFor(eco, w.frame, w.grade) : null;
    const makerIsMe = !!w && w.maker === ctx.me();
    const input = h("input", {
      class: "d2-in",
      type: "text",
      inputmode: "numeric",
      "data-k": "list:price",
      "aria-label": "Your price in scrip",
      placeholder: w ? String(w.value) : "",
      value: priceText,
      oninput: (e: Event) => {
        priceText = (e.target as HTMLInputElement).value.replace(/[^\d]/g, "").slice(0, 7);
        ctx.render();
      },
    });
    return h(
      "section",
      { class: "d2-list", "aria-label": "List a gun" },
      head("List a gun", "held by the contract while listed"),
      weapons
        ? held.length
          ? h("div", { class: "d2-rack-list short", "data-scroll": "listpick" }, ...held.map((x) => gunTile(x, { k: `list:${x.serial}`, selected: x.serial === listSerial, onclick: () => ((listSerial = x.serial), (priceText = String(x.value)), ctx.render()) })))
          : emptyLine("No gun in your stash to list.")
        : emptyLine(ctx.reads.weapons.s === "loading" ? "Opening your locker…" : `Your guns: ${UNKNOWN}.`, ctx.reads.weapons.s === "unknown"),
      w
        ? h(
            "div",
            { class: "d2-list-form", "data-serial": w.serial },
            h("label", { class: "d2-in-l" }, h("span", null, "Your price"), input, h("i", null, "scrip")),
            h(
              "div",
              { class: "d2-guides" },
              h("button", { class: "d2-guide", type: "button", "data-k": "list:appraisal", onclick: () => ((priceText = String(w.value)), ctx.render()) }, h("span", null, "Appraised"), h("b", null, fmt(w.value))),
              h(
                "div",
                { class: "d2-guide", "data-unknown": sales === null ? "1" : null },
                h("span", null, `Last ${frameWord(w.frame)} ${w.grade} sales`),
                h("b", { class: sales === null ? "d2-unk" : "" }, sales === null ? UNKNOWN : sales.length ? sales.map(fmt).join(" · ") : "none yet"),
              ),
            ),
            split
              ? h(
                  "dl",
                  { class: "d2-split", "data-fee": split.fee, "data-maker": split.maker, "data-burned": split.burned, "data-seller": split.seller },
                  h("div", null, h("dt", null, "Buyer pays"), h("dd", null, fmt(price!))),
                  h("div", { class: "maker" }, h("dt", null, `Maker's ${MARKET.makerPct}% (${makerIsMe ? "you built it" : w.makerCallsign})`), h("dd", null, makerIsMe ? `${fmt(split.maker)} back to you` : `−${fmt(split.maker)}`)),
                  h("div", null, h("dt", null, `Burned ${MARKET.feePct - MARKET.makerPct}%`), h("dd", null, `−${fmt(split.burned)}`)),
                  h("div", { class: "sum" }, h("dt", null, "You receive"), h("dd", null, fmt(split.seller + (makerIsMe ? split.maker : 0)))),
                )
              : h("p", { class: "d2-why" }, "Set a price in whole scrip."),
            actBtn(ctx, {
              k: `list:go`,
              label: price ? `List for ${fmt(price)}` : "List",
              cls: "solid wide",
              disabled: !price,
              onclick: () =>
                void ctx
                  .act({
                    key: "list:go",
                    settling: `Settling: listing ${w.serial} for ${fmt(price!)}…`,
                    run: () => ctx.chain.listWeapon(w.serial, price!),
                    done: () => `${w.serial} is on the market for ${fmt(price!)} scrip.`,
                    refresh: ["listings"],
                  })
                  .then((r) => {
                    if (r) ((listSerial = null), (priceText = ""));
                    ctx.render();
                  }),
            }),
          )
        : null,
    );
  }

  const paint = painter(
    el,
    () => [ctx.reads.listings, ctx.reads.weapons, ctx.reads.economy, ctx.reads.balances, frame, grade, listSerial, priceText, ctx.busy() ? "busy" : "", Math.floor(Date.now() / 60000)],
    () => {
      const listings = okv(ctx.reads.listings);
      const eco = okv(ctx.reads.economy);
      const weapons = okv(ctx.reads.weapons);
      const me = ctx.me();
      const guns = (listings ?? []).filter((l) => l.weapon) as (Listing & { weapon: Weapon })[];
      const others = guns.filter((l) => l.seller !== me);
      const shown = others.filter((l) => (frame === "all" || l.weapon.frame === frame) && (grade === "all" || l.weapon.grade === grade));
      const mine = (listings ?? []).filter((l) => l.seller === me);
      const items = (listings ?? []).filter((l) => l.item && l.seller !== me);
      const scrip = ctx.holding("scrip");
      return [
        h(
          "section",
          { class: "d2-mkt-main", "aria-label": "Guns for sale" },
          h(
            "div",
            { class: "d2-mkt-bar" },
            seg("Frame", frame, [{ id: "all" as const, label: "All" }, ...FRAME_IDS.map((f) => ({ id: f, label: frameWord(f) }))], (v) => ((frame = v), ctx.render())),
            seg("Grade", grade, [{ id: "all" as const, label: "All" }, ...GRADES.map((g) => ({ id: g, label: g }))], (v) => ((grade = v), ctx.render())),
            h("span", { class: "d2-mkt-count" }, listings ? `${plural(shown.length, "gun")} for sale` : ""),
          ),
          listings
            ? shown.length
              ? h("div", { class: "d2-mkt-grid", "data-scroll": "mkt" }, ...shown.map((l) => listingCard(l, l.weapon, eco)))
              : emptyLine(others.length ? "No gun matches those filters." : "Nobody is selling a gun right now. Build one and be the first.")
            : emptyLine(ctx.reads.listings.s === "loading" ? "Reading the market…" : `The market's listings: ${UNKNOWN}. Nothing here has been bought or sold.`, ctx.reads.listings.s === "unknown"),
        ),
        h(
          "aside",
          { class: "d2-mkt-side", "data-scroll": "mktside" },
          h(
            "section",
            { class: "d2-mine", "aria-label": "Your listings" },
            head("Your listings", listings ? String(mine.length) : null),
            listings
              ? mine.length
                ? h(
                    "div",
                    { class: "d2-rack-list" },
                    ...mine.map((l) =>
                      h(
                        "div",
                        { class: "d2-mine-row", "data-listing": l.id },
                        l.weapon ? gunTile(l.weapon, { sub: `${l.weapon.serial} · listed ${ago(l.at)}`, figure: document.createTextNode(fmt(l.price)) }) : h("span", { class: "d2-item-n" }, `${l.item!.amount} × ${TOKEN_NAMES[l.item!.tokenId]} · ${fmt(l.price)}`),
                        actBtn(ctx, { k: `cancel:${l.id}`, label: "Cancel", onclick: () => cancel(l) }),
                      ),
                    ),
                  )
                : emptyLine("You have nothing listed.")
              : emptyLine(ctx.reads.listings.s === "loading" ? "…" : `Your listings: ${UNKNOWN}.`, ctx.reads.listings.s === "unknown"),
          ),
          listPanel(weapons, eco),
          h(
            "section",
            { class: "d2-items", "aria-label": "Parts and mods for sale" },
            head("Parts and mods", "fee burned, no maker"),
            listings
              ? items.length
                ? h(
                    "ul",
                    { class: "d2-item-list" },
                    ...items.map((l) => {
                      const short = scrip != null && scrip < l.price;
                      return h(
                        "li",
                        { "data-listing": l.id },
                        h("span", { class: "d2-item-n" }, h("b", null, `${l.item!.amount} × ${TOKEN_NAMES[l.item!.tokenId]}`), h("i", null, `${l.callsign} · ${ago(l.at)}`)),
                        scripEl(l.price),
                        actBtn(ctx, { k: `buy:${l.id}`, label: "Buy", disabled: scrip == null || short, why: short ? "Not enough scrip" : null, onclick: () => buy(l) }),
                      );
                    }),
                  )
                : emptyLine("No parts listed.")
              : null,
          ),
        ),
      ];
    },
  );

  return { el, update: paint };
}
