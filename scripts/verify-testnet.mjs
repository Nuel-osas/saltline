// Reads Saltline's live economy straight from NEAR testnet, with no wallet and no dependencies, so anyone can check
// what the README claims. It doubles as the judging-week preflight: it exits 1 if the faucet is running dry, the
// brokers have gone quiet, or the contract can't be read.
//
//   npm run verify:testnet            (or: node scripts/verify-testnet.mjs [contract-id])
const CONTRACT = process.argv[2] || process.env.CONTRACT_ID || "saltline.testnet";
const RPCS = ["https://test.rpc.fastnear.com", "https://rpc.testnet.near.org"];
const NEAR = 10n ** 24n;
const near = (y) => (Number((BigInt(y) * 1000n) / NEAR) / 1000).toFixed(3);

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
      return j.result;
    } catch (e) {
      last = e;
    }
  }
  throw last;
}
const account = (id) => rpc({ request_type: "view_account", account_id: id });
const view = async (method, args = {}) => {
  const r = await rpc({
    request_type: "call_function",
    account_id: CONTRACT,
    method_name: method,
    args_base64: Buffer.from(JSON.stringify(args)).toString("base64"),
  });
  return JSON.parse(Buffer.from(r.result).toString());
};

let problems = 0;
const warn = (msg) => {
  problems++;
  console.log(`  ! ${msg}`);
};

const c = await account(CONTRACT);
console.log(`Contract ${CONTRACT} on NEAR testnet`);
console.log(`  code hash ${c.code_hash} · ${c.storage_usage} bytes stored · ${near(c.amount)} NEAR`);
console.log(`  explorer  https://testnet.nearblocks.io/address/${CONTRACT}`);

const rules = await view("rules");
console.log(
  `\nRun rules: ${rules.containers_per_run} sealed boxes of ${rules.spot_count} spots, carry ${rules.carry_limit}, ` +
    `minimum ${rules.min_run_seconds} s + ${rules.per_container_seconds} s a box, wreck finder ${rules.finder_share_pct}%`,
);

console.log("\nBrokers (each a NEAR account that signs its own moves; prices and reasons come from contract/src/pricing.rs):");
for (const b of await view("brokers")) {
  console.log(`  ${b.name.padEnd(13)} ${b.open ? "OPEN    " : "SHUTTERED"} scrip ${b.scrip.padStart(5)} · stance ${b.stance} · ${b.account_id}`);
  for (const q of b.bids) console.log(`    pays  ${q.token_id.padEnd(7)} ${q.price.padStart(4)}  "${q.reason}"`);
  for (const q of b.asks) console.log(`    sells ${q.token_id.padEnd(7)} ${q.price.padStart(4)}  "${q.reason}"`);
  if (b.last_memo) console.log(`    agent's last note: "${b.last_memo}"`);
}

const recent = await view("recent", { limit: 64 });
console.log("\nLedger, newest first:");
for (const e of recent.slice(0, 8)) console.log(`  ${new Date(e.at).toISOString().slice(0, 16)}Z  ${e.text}`);
const lastBroker = recent.find((e) => e.kind === "export" || e.kind === "stance");
const quietHours = lastBroker ? (Date.now() - lastBroker.at) / 3.6e6 : Infinity;
if (quietHours > 6) warn(`no broker move in ${Number.isFinite(quietHours) ? quietHours.toFixed(1) + " h" : "the last 64 events"} (the cron runs every 15 min)`);

const board = await view("leaderboard");
const players = board.net_worth.length;
console.log(`\nBoard: ${players ? board.net_worth.slice(0, 3).map((r) => `${r.callsign} ${r.value}`).join(" · ") : "no players yet"}`);

const week = await view("simulate", { hours: 168, traders: 30, seed: 7 });
const first = week[0].brokers, last = week.at(-1).brokers;
const closures = week.reduce((n, p, i) => n + (i ? Object.keys(p.brokers).filter((k) => !p.brokers[k].open && week[i - 1].brokers[k].open).length : 0), 0);
console.log(
  `\nA simulated week (the fast-forward view, free to call): ${week.length} hourly points, ${closures} broker closure(s); ` +
    `Moss's copper bid ${first.moss.bids.copper} → ${last.moss.bids.copper}`,
);

const faucet = await account(`faucet.${CONTRACT}`);
const left = Number(BigInt(faucet.amount) / 10n ** 21n) / 1000;
console.log(`\nFaucet faucet.${CONTRACT}: ${left.toFixed(3)} NEAR, about ${Math.floor(left / 0.1)} more dock passes`);
if (left < 2) warn("the faucet is under 2 NEAR: top it up");

console.log(problems ? `\n${problems} problem(s)` : "\nAll good.");
process.exit(problems ? 1 : 0);
