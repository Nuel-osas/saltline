// Checks a deployed Saltline v2 contract against the client's copy of its numbers, with no wallet and no dependencies.
//
//   node scripts/v2-chain-check.mjs <contract-id>        (or CONTRACT_ID_V2=<id> node scripts/v2-chain-check.mjs)
//
// It calls every view in docs/CONTRACT_V2.md on NEAR testnet, and compares `rules`, `materials`, `frames` and
// `blueprints` with src/economy/v2/items.ts number by number, printing each mismatch. Exit code 1 if a view fails or
// a number differs. Run it after every deploy: the game's HUD, the mock and the contract must agree on all of them.
//
// items.ts is imported as TypeScript, which Node runs directly from 22.18 on (it only strips the types).
import { pathToFileURL } from "node:url";

const RPCS = ["https://test.rpc.fastnear.com", "https://rpc.testnet.near.org"];

// ---------------------------------------------------------------------------------------------------------------
// Comparing (pure, tested in test/v2-chain-check.test.ts)

/** camelCase → snake_case, the way the contract's serde does it (`minSeconds` → `min_seconds`). */
export const snake = (k) => k.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);

/** A JSON number or a U128 string as a number; anything else as it is. */
const value = (v) => (typeof v === "string" && /^\d+$/.test(v) ? Number(v) : v);

/** `{ a: { bC: 1 }, d: [2, 3] }` → `{ "a.b_c": 1, "d[0]": 2, "d[1]": 3 }`. `raw` leaves U128 strings as strings. */
export function flatten(o, prefix = "", out = {}, raw = false) {
  if (Array.isArray(o)) o.forEach((x, i) => flatten(x, `${prefix}[${i}]`, out, raw));
  else if (o && typeof o === "object") for (const [k, v] of Object.entries(o)) flatten(v, prefix ? `${prefix}.${snake(k)}` : snake(k), out, raw);
  else out[prefix] = raw ? o : value(o);
  return out;
}

/** Numbers only the game client uses; a contract that leaves them out is noted, not failed. */
const CLIENT_ONLY = new Set(["raid.slow_per_weight", "raid.plate_health", "raid.issued_mags"]);

/**
 * `rules` against items.ts (docs/CONTRACT_V2.md → Views): `{ raid, invoice, harbormaster, market, condition,
 * vendor_pricing }`, each the snake_case of the same-named constant, every number a JSON number. A number sent as a
 * string is a mismatch here, unlike the U128 amounts of the other views.
 */
export function compareRules(wire, items) {
  const want = flatten({ raid: items.RAID, invoice: items.INVOICE, harbormaster: items.HARBORMASTER, market: items.MARKET, condition: items.CONDITION, vendorPricing: items.VENDOR_PRICING });
  const got = flatten(wire, "", {}, true);
  const problems = [];
  const notes = [];
  for (const [path, expected] of Object.entries(want)) {
    if (!(path in got)) {
      if (CLIENT_ONLY.has(path)) notes.push(`rules.${path}: not sent (the client's own number, ${expected})`);
      else problems.push(`rules.${path}: missing on the contract (items.ts has ${expected})`);
    } else if (got[path] !== expected) problems.push(`rules.${path}: contract ${JSON.stringify(got[path])}, items.ts ${JSON.stringify(expected)}`);
  }
  for (const k of Object.keys(got)) if (!(k in want)) notes.push(`rules.${k}: on the contract (${JSON.stringify(got[k])}), not in items.ts`);
  return { problems, notes };
}

/** A view that is a list of `{ id, … }` against a table in items.ts, on the fields named. */
export function compareTable(name, wire, table, fields) {
  const problems = [];
  if (!Array.isArray(wire)) return { problems: [`${name}: expected a list`], notes: [] };
  const byId = new Map(wire.map((x) => [x?.id, x]));
  for (const [id, row] of Object.entries(table)) {
    const w = byId.get(id);
    if (!w) {
      problems.push(`${name}.${id}: missing on the contract`);
      continue;
    }
    for (const f of fields) {
      const want = flatten(row[f], snake(f));
      const got = flatten(w[snake(f)], snake(f));
      for (const k of new Set([...Object.keys(want), ...Object.keys(got)])) {
        // An input the blueprint doesn't use is 0 whether it is sent or left out.
        const a = got[k] ?? (name === "blueprints" ? 0 : undefined);
        const b = want[k] ?? (name === "blueprints" ? 0 : undefined);
        if (a !== b) problems.push(`${name}.${id}.${k}: contract ${JSON.stringify(a)}, items.ts ${JSON.stringify(b)}`);
      }
    }
  }
  for (const id of byId.keys()) if (!(id in table)) problems.push(`${name}.${String(id)}: on the contract, not in items.ts`);
  return { problems, notes: [] };
}

/** The Harbormaster view against the rules for its own balance and posture. */
export function checkHarbormaster(h, items) {
  const problems = [];
  const n = (k) => value(h?.[k]);
  const strength = Math.min(100, Math.floor(n("balance") / items.HARBORMASTER.scripPerStrength));
  const pursuit = h?.posture === "pursuit";
  const want = {
    strength,
    bonus_drones: pursuit ? 0 : Math.floor(strength / items.HARBORMASTER.strengthPerDrone),
    second_notice_at: items.INVOICE.secondNotice,
    bailiff_at: pursuit ? items.INVOICE.bailiff - items.HARBORMASTER.bailiffDropPerStrength * strength : items.INVOICE.bailiff,
    second_bailiff_at: items.INVOICE.secondBailiff,
    foreclosure_at: items.INVOICE.foreclosure,
  };
  for (const [k, v] of Object.entries(want)) if (n(k) !== v) problems.push(`harbormaster.${k}: contract ${JSON.stringify(n(k))}, the rules give ${v} (balance ${n("balance")}, ${h?.posture})`);
  return problems;
}

/** items.ts as the contract would send it, for the self-check and the tests. */
export function toWire(items) {
  const u = (n) => String(n);
  const amounts = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, u(v)]));
  const sn = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [snake(k), v && typeof v === "object" ? sn(v) : v]));
  return {
    rules: { raid: sn(items.RAID), invoice: sn(items.INVOICE), harbormaster: sn(items.HARBORMASTER), market: sn(items.MARKET), condition: sn(items.CONDITION), vendor_pricing: sn(items.VENDOR_PRICING) },
    materials: Object.values(items.MATERIALS).map((m) => ({ id: m.id, name: m.name, weight: m.weight, bid: u(m.bid), export: u(m.export), target: m.target })),
    frames: Object.values(items.FRAMES).map((f) => ({ id: f.id, name: f.name, bands: f.bands, base: u(f.base) })),
    blueprints: Object.entries(items.BLUEPRINTS).map(([id, b]) => ({ id, kind: b.kind, inputs: amounts(b.inputs), fee: u(b.fee), yields: b.yields })),
  };
}

const withIds = (table) => Object.fromEntries(Object.entries(table).map(([id, row]) => [id, { id, ...row }]));

/** Every number comparison at once. `views` holds the four views' replies. */
export function compareAll(views, items) {
  const parts = [
    compareRules(views.rules, items),
    compareTable("materials", views.materials, items.MATERIALS, ["name", "weight", "bid", "export", "target"]),
    compareTable("frames", views.frames, items.FRAMES, ["name", "bands", "base"]),
    compareTable("blueprints", views.blueprints, withIds(items.BLUEPRINTS), ["kind", "inputs", "fee", "yields"]),
  ];
  return { problems: parts.flatMap((p) => p.problems), notes: parts.flatMap((p) => p.notes) };
}

// ---------------------------------------------------------------------------------------------------------------
// Reading testnet

async function rpc(params) {
  let last;
  for (const url of RPCS) {
    try {
      const r = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "query", params: { finality: "optimistic", ...params } }),
      });
      const j = await r.json();
      if (j.error) throw new Error(JSON.stringify(j.error.cause ?? j.error));
      if (j.result?.error) throw new Error(String(j.result.error));
      return j.result;
    } catch (e) {
      last = e;
    }
  }
  throw last;
}

async function main(contract) {
  const items = await import(new URL("../src/economy/v2/items.ts", import.meta.url).href);
  const view = async (method, args = {}) => {
    const r = await rpc({ request_type: "call_function", account_id: contract, method_name: method, args_base64: Buffer.from(JSON.stringify(args)).toString("base64") });
    return JSON.parse(Buffer.from(r.result).toString());
  };
  let failed = 0;
  const got = {};
  const brief = (v) => {
    const s = JSON.stringify(v);
    return s.length > 110 ? `${s.slice(0, 107)}…` : s;
  };
  const call = async (method, args) => {
    try {
      got[method] = await view(method, args);
      console.log(`  ok    ${method.padEnd(22)} ${Array.isArray(got[method]) ? `${got[method].length} rows ` : ""}${brief(got[method])}`);
    } catch (e) {
      failed++;
      console.log(`  FAIL  ${method.padEnd(22)} ${String(e?.message ?? e).slice(0, 160)}`);
    }
  };

  console.log(`Saltline v2 on testnet: ${contract}\n\nViews`);
  for (const m of ["rules", "materials", "frames", "blueprints", "vendors", "export_prices", "listings", "wrecks", "harbormaster", "economy", "leaderboard"]) await call(m);
  const someone = got.vendors?.[0]?.account_id ?? contract;
  const serial = got.vendors?.flatMap((v) => v.guns ?? [])[0]?.weapon?.serial ?? "S-000001";
  await call("profile", { account_id: someone });
  await call("balances", { account_id: someone });
  await call("weapons", { account_id: someone });
  await call("weapon", { serial });
  await call("impound", { account_id: someone });
  await call("raid", { raid_id: 1 });
  await call("recent", { limit: 5 });
  await call("mt_balance_of", { account_id: someone, token_id: "scrip" });
  await call("mt_batch_balance_of", { account_id: someone, token_ids: ["scrip", "copper"] });
  await call("mt_supply", { token_id: "scrip" });
  await call("nft_total_supply");
  await call("nft_metadata");
  await call("nft_tokens", { from_index: "0", limit: 2 });
  await call("nft_tokens_for_owner", { account_id: someone, from_index: "0", limit: 2 });
  await call("nft_supply_for_owner", { account_id: someone });
  await call("nft_token", { token_id: serial });
  await call("nft_payout", { token_id: serial, balance: "10000", max_len_payout: 10 });

  console.log("\nNumbers against src/economy/v2/items.ts");
  const { problems, notes } = compareAll(got, items);
  if (got.harbormaster) problems.push(...checkHarbormaster(got.harbormaster, items));
  for (const q of got.export_prices ?? []) {
    const m = items.MATERIALS[q.token_id];
    if (m && value(q.price) > m.export) problems.push(`export_prices.${q.token_id}: ${q.price} is over the book price ${m.export}`);
  }
  for (const n of notes) console.log(`  note  ${n}`);
  for (const p of problems) console.log(`  DIFF  ${p}`);
  if (!problems.length) console.log("  every number matches");
  console.log(`\n${failed} view${failed === 1 ? "" : "s"} failed, ${problems.length} mismatch${problems.length === 1 ? "" : "es"}.`);
  return failed || problems.length ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const contract = process.argv[2] || process.env.CONTRACT_ID_V2;
  if (!contract) {
    console.error("usage: node scripts/v2-chain-check.mjs <contract-id>");
    process.exit(2);
  }
  main(contract).then(
    (code) => process.exit(code),
    (e) => {
      console.error(e);
      process.exit(1);
    },
  );
}
