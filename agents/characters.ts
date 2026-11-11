// The three brokers' characters: what each one does with the contract's advice, and how it says so.
//
// The contract's `advice({ broker })` view (contract/src/policy.rs) is the default policy. It already knows each
// item's export cooldown, so an export it suggests is one the broker is allowed to make now. Each character starts
// from that advice and leans on it in one direction:
//
// - Moss hates sitting on stock. She ships the moment the freighter will take it, and when she's shut she ships
//   down to a quarter of target, not half. While the shed is over target and the freighter isn't ready, she bids
//   less so it stops filling; once it's clear she brings her bids back towards 100.
// - Ines keeps a fat float. She tightens her bids as soon as her scrip drops under 1,300 (the default policy waits
//   until 1,000), and she only bids up when the till is over 3,000.
// - The Quartermaster spends fast. When relay cores are flowing (at or over target on the shelf) and he has 800
//   scrip or more, he pushes his stance up 5. He still cuts when the advice says the till is thin.
//
// Everyone ships when the advice says ship: exports are a broker's income. One move per broker per round.
//
// Pure functions of the broker's state, with no I/O, so the tests can pin every rule.
import { BROKERS, ITEMS } from "../src/economy/items.js";
import type { BrokerId, BrokerView, CargoId } from "../src/economy/types";

export const STANCE_MIN = 80;
export const STANCE_MAX = 120;
/** The longest memo an agent signs (the contract allows 160 bytes; the Dockside tooltip wants one short line). */
export const MEMO_MAX = 90;

/** The contract's `advice` view, decoded (docs/CONTRACT_API.md). */
export interface Advice {
  action: "none" | "export" | "stance";
  tokenId: CargoId | null;
  amount: number | null;
  stance: number | null;
  memo: string;
}

/** The one thing a broker does this round. */
export type Move =
  | { action: "hold" }
  | { action: "export"; tokenId: CargoId; amount: number }
  | { action: "stance"; stance: number };

/** Why the broker made the move. It picks the memo. */
export type Why =
  | "ship" // exporting while open
  | "ship-shut" // exporting while closed, to get back to the reopen line
  | "shed-full" // Moss: over target, the freighter isn't ready, bidding less
  | "shed-full-floor" // Moss: over target and already at the floor
  | "shed-clear" // Moss: back towards 100 once the shed is clear
  | "float" // Ines: under her own float line, tightening early
  | "float-floor" // Ines: under her float line and already at the floor
  | "cautious" // Ines: the advice says bid up, she isn't flush enough
  | "cores" // Quartermaster: cores are flowing, paying up
  | "thin" // the advice's cut: cash is thin
  | "flush" // the advice's raise: cash to spare
  | "steady" // nothing to do
  | "shut"; // closed with nothing to ship

export interface Decision {
  move: Move;
  why: Why;
  /** The cargo the memo talks about (the item shipped, or the one filling the shed). */
  tokenId?: CargoId;
}

/** Ines's float line: under this much scrip she tightens. */
export const INES_FLOAT = 1_300;
/** Ines only bids up with more than this in the till. */
export const INES_FLUSH = 3_000;
/** The Quartermaster pays up for cores only with at least this much scrip. */
export const QM_SPEND = 800;
/** Moss brings her bids back towards 100 only with at least this much scrip (the default policy's thin line). */
export const MOSS_STEADY = 700;

const target = (t: CargoId) => ITEMS[t].target ?? 0;
const stock = (b: BrokerView, t: CargoId) => b.stock[t] ?? 0;
const clampStance = (s: number) => Math.max(STANCE_MIN, Math.min(STANCE_MAX, s));
const hold = (why: Why): Decision => ({ move: { action: "hold" }, why });
/** A stance move, clamped to 80–120, or null when it wouldn't change anything. */
function stanceTo(b: BrokerView, s: number, why: Why, tokenId?: CargoId): Decision | null {
  const stance = clampStance(s);
  return stance === b.stance ? null : { move: { action: "stance", stance }, why, ...(tokenId ? { tokenId } : {}) };
}

/** The advice taken as it is, in this broker's voice. */
function followAdvice(b: BrokerView, a: Advice): Decision {
  if (a.action === "export" && a.tokenId && a.amount) {
    return { move: { action: "export", tokenId: a.tokenId, amount: a.amount }, why: b.open ? "ship" : "ship-shut", tokenId: a.tokenId };
  }
  if (a.action === "stance" && a.stance !== null) return stanceTo(b, a.stance, a.stance < b.stance ? "thin" : "flush") ?? hold("steady");
  return hold(b.open ? "steady" : "shut");
}

const adviceCuts = (b: BrokerView, a: Advice) => a.action === "stance" && a.stance !== null && a.stance < b.stance;
const adviceRaises = (b: BrokerView, a: Advice) => a.action === "stance" && a.stance !== null && a.stance > b.stance;

function moss(b: BrokerView, a: Advice): Decision {
  if (a.action === "export" && a.tokenId && a.amount) {
    // Ship what the advice says, topped up to her own keep line: target when open, a quarter of target when shut.
    // An advised amount over what the board shows she holds stays over it, so checkMove turns it into a hold.
    const keep = b.open ? target(a.tokenId) : Math.floor(target(a.tokenId) / 4);
    const amount = Math.max(a.amount, stock(b, a.tokenId) - keep);
    return { move: { action: "export", tokenId: a.tokenId, amount }, why: b.open ? "ship" : "ship-shut", tokenId: a.tokenId };
  }
  if (!b.open) return followAdvice(b, a);
  // Over target and the advice didn't ship it: the freighter won't take it yet. Bid less so the shed stops filling.
  const full = BROKERS.moss.buys
    .filter((t) => stock(b, t) > target(t))
    .sort((x, y) => stock(b, y) - target(y) - (stock(b, x) - target(x)))[0];
  if (full) {
    // Down 5, or the advice's deeper cut when the till is thin too.
    const cut = Math.min(b.stance - 5, adviceCuts(b, a) ? (a.stance as number) : b.stance);
    return stanceTo(b, cut, "shed-full", full) ?? { ...hold("shed-full-floor"), tokenId: full };
  }
  if (adviceCuts(b, a)) return followAdvice(b, a);
  // Shed's clear: back towards 100, unless the advice wants her higher still.
  if (b.stance < 100 && b.scrip >= MOSS_STEADY && !adviceRaises(b, a)) {
    return stanceTo(b, Math.min(100, b.stance + 5), "shed-clear") ?? hold("steady");
  }
  return followAdvice(b, a);
}

function ines(b: BrokerView, a: Advice): Decision {
  if (a.action === "export" || !b.open) return followAdvice(b, a);
  if (adviceCuts(b, a)) return followAdvice(b, a);
  if (b.scrip < INES_FLOAT) return stanceTo(b, b.stance - 5, "float") ?? hold("float-floor");
  if (adviceRaises(b, a) && b.scrip <= INES_FLUSH) return hold("cautious");
  return followAdvice(b, a);
}

function qm(b: BrokerView, a: Advice): Decision {
  if (a.action === "export" || !b.open) return followAdvice(b, a);
  if (adviceCuts(b, a)) return followAdvice(b, a);
  // Cores flowing: up 5, or the advice's raise if that's bigger.
  const flowing = stock(b, "core") >= target("core");
  if (flowing && b.scrip >= QM_SPEND) {
    const up = Math.max(b.stance + 5, adviceRaises(b, a) ? (a.stance as number) : 0);
    const d = stanceTo(b, up, "cores", "core");
    if (d) return d;
  }
  return followAdvice(b, a);
}

const CHARACTERS: Record<BrokerId, (b: BrokerView, a: Advice) => Decision> = { moss, ines, qm };

/**
 * A move the contract would accept from this broker, or null: an export of cargo it buys, more than zero and no
 * more than it holds; a stance inside 80–120 that differs from the current one.
 */
export function checkMove(b: BrokerView, move: Move): Move | null {
  const whole = (n: number) => Number.isSafeInteger(n) && n > 0;
  if (move.action === "hold") return move;
  if (move.action === "export") {
    const buys: readonly CargoId[] = BROKERS[b.id].buys;
    return buys.includes(move.tokenId) && whole(move.amount) && move.amount <= stock(b, move.tokenId) ? move : null;
  }
  return Number.isInteger(move.stance) && move.stance >= STANCE_MIN && move.stance <= STANCE_MAX && move.stance !== b.stance
    ? move
    : null;
}

/** The broker's decision for this round. A move that doesn't add up becomes a hold, never a guess. */
export function decide(b: BrokerView, a: Advice): Decision & { invalid?: true } {
  const d = CHARACTERS[b.id](b, a);
  return checkMove(b, d.move) ? d : { ...hold(b.open ? "steady" : "shut"), invalid: true };
}

// ---------------------------------------------------------------------------------------------------------------
// Memos, in the dockside voice

const NOUNS: Record<CargoId, [one: string, many: string]> = {
  copper: ["coil", "coils"],
  meds: ["crate of meds", "crates of meds"],
  chips: ["box of electronics", "boxes of electronics"],
  fuel: ["fuel cell", "fuel cells"],
  core: ["relay core", "relay cores"],
};

/** "14 coils", "1 relay core". */
export const count = (t: CargoId, n: number) => `${n} ${NOUNS[t][n === 1 ? 0 : 1]}`;

type Templates = Partial<Record<Why, string[]>>;

// {count}: "14 coils". {things}: the plural noun. {price}: export price per unit. {scrip}, {stance}, {float}.
const SHARED: Templates = {
  thin: ["Till's light at {scrip} scrip. Bidding tighter: stance {stance}.", "Cash is thin at {scrip}. Stance down to {stance}."],
  flush: ["Till's heavy at {scrip}. Paying up: stance {stance}.", "Plenty in the till at {scrip}. Stance {stance}."],
};

const TEMPLATES: Record<BrokerId, Templates> = {
  moss: {
    ship: [
      "Freighter's in. Shipping {count} before they rust.",
      "Shed's heaving. {count} to the freighter at {price} each.",
      "{count} over target. Out at {price} a piece. Waste is waste.",
    ],
    "ship-shut": [
      "Shutters down, not sunk. {count} out at {price} to get going.",
      "Shut till someone invests. Shipping {count} meanwhile.",
    ],
    "shed-full": [
      "Shed's full of {things} and the freighter's not due. Stance {stance}.",
      "No room for more {things}. Bidding less till the boat: {stance}.",
    ],
    "shed-full-floor": ["Shed's full, bids at the floor. Waiting on the freighter."],
    "shed-clear": ["Shed's clear. Paying fair again: stance {stance}.", "Room on the floor. Stance back up to {stance}."],
    steady: ["Nothing to ship, nothing to fix. Kettle's on.", "Holding. Shed's tidy, till's steady."],
    shut: ["Shut, and nothing to ship. Waiting on investors."],
  },
  ines: {
    ship: [
      "Moving {count} to the freighter at {price}. Cash beats a full shed.",
      "Cold store's full. {count} out at {price} each.",
      "Freighter takes {count} at {price}. I sleep better on cash.",
    ],
    "ship-shut": ["Shut, so I ship. {count} at {price} towards the reopen line."],
    float: ["Float's under {float}. Tightening early: stance {stance}.", "{scrip} in the till is thin for me. Stance {stance}."],
    "float-floor": ["Float's thin and my bids are at the floor. Holding."],
    cautious: ["Till's fine at {scrip}, not fat. Bids stay put.", "Not paying up on {scrip} scrip. Ask me at {flush}."],
    steady: ["Holding. Float's fine and the cold store's fine.", "Nothing moves today. The float stays fat."],
    shut: ["Shut. Holding what I've got till someone invests."],
  },
  qm: {
    ship: [
      "The client wants scrip, not shelf. {count} out at {price}.",
      "Shelf's too deep. {count} to the freighter at {price}.",
    ],
    "ship-shut": ["Books closed. Shipping {count} at {price} to reopen."],
    cores: [
      "Cores are flowing. Paying up for more: stance {stance}.",
      "{count} on the shelf and the client wants more. Stance {stance}.",
      "Keep the cores coming. Stance {stance}.",
    ],
    thin: ["Spent fast, now short at {scrip}. Bidding tighter: stance {stance}."],
    steady: ["Holding. The client hasn't called.", "Shelf's right, till's right. Holding."],
    shut: ["Closed on the client's orders. Waiting on investors."],
  },
};

/** The last resort when every template runs long (huge numbers): plain, short, true. */
function plainMemo(d: Decision): string {
  const m = d.move;
  if (m.action === "export") return `Shipping ${count(m.tokenId, m.amount)}.`;
  if (m.action === "stance") return `Stance ${m.stance}.`;
  return "Holding.";
}

/** FNV-1a, so a seed and a broker always pick the same template. */
function hash(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193) >>> 0;
  return h;
}

/** Every template a broker might use for a decision (exported for the length test). */
export function templatesFor(id: BrokerId, why: Why): string[] {
  return TEMPLATES[id][why] ?? SHARED[why] ?? [];
}

export function fill(template: string, b: BrokerView, d: Decision): string {
  const m = d.move;
  const t = d.tokenId ?? (m.action === "export" ? m.tokenId : undefined);
  const n = m.action === "export" ? m.amount : t ? stock(b, t) : 0;
  const values: Record<string, string> = {
    count: t ? count(t, n) : "",
    things: t ? NOUNS[t][1] : "stock",
    price: t ? String(ITEMS[t].export ?? "") : "",
    scrip: String(b.scrip),
    stance: String(m.action === "stance" ? m.stance : b.stance),
    float: String(INES_FLOAT),
    flush: String(INES_FLUSH),
  };
  const out = template.replace(/\{(\w+)\}/g, (_, k: string) => values[k] ?? "");
  return out.charAt(0).toUpperCase() + out.slice(1);
}

/** The decision's memo: one line, at most MEMO_MAX characters, the same for the same seed. */
export function memoFor(b: BrokerView, d: Decision, seed: number): string {
  const options = templatesFor(b.id, d.why);
  const start = options.length ? hash(`${seed}|${b.id}|${d.why}`) % options.length : 0;
  for (let i = 0; i < options.length; i++) {
    const memo = fill(options[(start + i) % options.length], b, d);
    if (memo.length <= MEMO_MAX) return memo;
  }
  return plainMemo(d).slice(0, MEMO_MAX);
}

/** The facts the memo must stay true to (the LLM voice gets these and may not add a number to them). */
export function factsFor(b: BrokerView, d: Decision): string {
  const m = d.move;
  const name = BROKERS[b.id].name;
  const state = `${name} is ${b.open ? "open" : "shut"} with ${b.scrip} scrip at stance ${b.stance}.`;
  if (m.action === "export") return `${state} Shipping ${count(m.tokenId, m.amount)} to the freighter at ${ITEMS[m.tokenId].export} each.`;
  if (m.action === "stance") return `${state} Setting stance ${m.stance}.`;
  return `${state} Holding.`;
}
