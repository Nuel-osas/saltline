// Prints the game's numbers as a table: GET /api/stats (server/stats.ts) with the admin token. What the numbers
// mean, and what is and isn't stored behind them, is in docs/DATA.md.
//
//   npm run stats                                  asks STATS_URL (default: the local dev server)
//   npm run stats -- --url https://saltline-lac.vercel.app/api/stats
//   npm run stats -- --users 20                    also the 20 newest sign-ins
//   npm run stats -- --json                        the raw answer
//
// STATS_ADMIN_TOKEN and STATS_URL come from the environment, else from .env in the folder it is run from. The token
// goes in the Authorization header and is never printed. A number the server couldn't read is shown as "unknown",
// never as 0. No dependencies.
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const DEFAULT_URL = "http://127.0.0.1:5280/api/stats";

// ---------------------------------------------------------------------------------------------------------------
// Formatting (pure, tested in test/v2-stats-script.test.ts)

const UNKNOWN = "unknown";
const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v.toLocaleString("en-US") : UNKNOWN);
const when = (iso) => (typeof iso === "string" && !Number.isNaN(Date.parse(iso)) ? `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC` : UNKNOWN);

const COLUMNS = [
  ["visits", "visits"],
  ["devices", "devices"],
  ["signIns", "sign-ins"],
  ["sessions", "wallets"],
  ["passes", "passes"],
  ["raidsStarted", "raids"],
  ["raidsExtracted", "extracted"],
  ["raidsDied", "died"],
  ["dockOpens", "dock"],
  ["practiceStarts", "practice"],
];

/** Rows of cells as lines: the first column left-aligned, the rest right-aligned, each as wide as its widest cell. */
export function table(rows) {
  const widths = rows[0].map((_, i) => Math.max(...rows.map((r) => String(r[i]).length)));
  return rows.map((r) => r.map((c, i) => (i === 0 ? String(c).padEnd(widths[i]) : String(c).padStart(widths[i]))).join("  ").trimEnd());
}

const FUNNEL = [
  ["visited", "visited"],
  ["signedIn", "signed in"],
  ["gotPass", "got a pass"],
  ["startedRaid", "started a raid"],
  ["extracted", "extracted"],
];

/** The lines `npm run stats` prints for one answer from GET /api/stats. */
export function formatStats(s) {
  const out = [];
  out.push(`Saltline · read ${when(s.at)} · store: ${s.store ?? UNKNOWN}`);
  if (s.store === "off") out.push("The database is off on that server: nothing is being kept, and every number below is unknown.");
  else if (!s.recordingSince) out.push("Nothing has been counted yet (or when counting began couldn't be read): days show as unknown, not 0.");
  else out.push(`Counting since ${when(s.recordingSince)}. Days before that are unknown, not 0.`);
  out.push("");

  const days = [s.today, ...(Array.isArray(s.days) ? s.days : [])].filter(Boolean);
  out.push(...table([["day (UTC)", ...COLUMNS.map(([, label]) => label)], ...days.map((d, i) => [`${d.day}${i === 0 ? " today" : ""}`, ...COLUMNS.map(([key]) => num(d[key]))])]));
  out.push("");
  out.push(`Online now (heard from in the last 2 minutes): ${num(s.onlineNow)}`);
  out.push(`Users on record: ${num(s.totalUsers)}`);
  out.push("");

  const f = s.funnel ?? {};
  out.push(`Funnel: distinct devices over the last ${num(f.days)} days`);
  const steps = FUNNEL.map(([key, label], i) => {
    const [here, before] = [f[key], i ? f[FUNNEL[i - 1][0]] : null];
    const share = typeof here === "number" && typeof before === "number" && before > 0 ? `${Math.round((here / before) * 100)}% of the step before` : "";
    return [label, num(here), share];
  });
  const [labelWidth, numWidth] = [0, 1].map((i) => Math.max(...steps.map((step) => step[i].length)));
  out.push(...steps.map(([label, n, share]) => `  ${label.padEnd(labelWidth)}  ${n.padStart(numWidth)}${share ? `  ${share}` : ""}`));

  if ("users" in s) {
    out.push("");
    if (!Array.isArray(s.users)) out.push(`Newest users: ${UNKNOWN}`);
    else if (!s.users.length) out.push("Newest users: none on record");
    else {
      out.push("Newest users");
      out.push(...table([["callsign", "first seen", "last seen", "pass", "wallets", "visits", "account"], ...s.users.map((u) => [u.callsign ?? "(no pass)", when(u.firstSeen), when(u.lastSeen), u.passAt ? when(u.passAt) : "none", num(u.sessions), num(u.visits), u.accountId ?? UNKNOWN])]).map((l) => `  ${l}`));
    }
  }
  return out;
}

/** KEY=value lines of a .env file, for the keys asked for and no others. */
export function readDotEnv(text, keys) {
  const out = {};
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m || !keys.includes(m[1])) continue;
    out[m[1]] = m[2].replace(/^(['"])(.*)\1$/, "$2");
  }
  return out;
}

/** `--url X --users 20 --json` → { url, users, json }. Throws on anything it doesn't know. */
export function parseArgs(argv) {
  const out = { url: null, users: null, json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--json") out.json = true;
    else if (a === "--url" && argv[i + 1]) out.url = argv[++i];
    else if (a === "--users" && /^\d{1,3}$/.test(argv[i + 1] ?? "")) out.users = Number(argv[++i]);
    else throw new Error(`Unknown option: ${a}. Use --url <address>, --users <1-200>, --json.`);
  }
  return out;
}

/**
 * Where to ask and with which token: the command line first, then the environment, then .env. A setting left empty
 * counts as not set. Throws, in words for the terminal, when there is no token or the address would send it in clear.
 */
export function settings(args, env, fromFile) {
  const pick = (...values) => values.map((v) => (v ?? "").trim()).find(Boolean) ?? "";
  const token = pick(env.STATS_ADMIN_TOKEN, fromFile.STATS_ADMIN_TOKEN);
  if (!token) throw new Error("STATS_ADMIN_TOKEN isn't set (in the environment or in .env). It is the same value the server has.");
  let url;
  try {
    url = new URL(pick(args.url, env.STATS_URL, fromFile.STATS_URL, DEFAULT_URL));
  } catch {
    throw new Error("The stats address isn't a URL. Set STATS_URL or pass --url https://…/api/stats.");
  }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && ["127.0.0.1", "localhost"].includes(url.hostname))) throw new Error("The stats address must be https: the admin token goes with the request.");
  if (args.users) url.searchParams.set("users", String(args.users));
  return { token, url };
}

// ---------------------------------------------------------------------------------------------------------------

async function main() {
  const args = parseArgs(process.argv.slice(2));
  let fromFile = {};
  try {
    fromFile = readDotEnv(readFileSync(".env", "utf8"), ["STATS_ADMIN_TOKEN", "STATS_URL"]);
  } catch {
    // no .env here: the environment is enough
  }
  const { token, url } = settings(args, process.env, fromFile);

  let res;
  try {
    res = await fetch(url, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15_000) });
  } catch (e) {
    throw new Error(`Couldn't reach ${url.origin}${url.pathname} (${e?.name ?? "error"}).`);
  }
  if (res.status === 404) throw new Error(`${url.origin} has no stats: STATS_ADMIN_TOKEN isn't set there (or this build doesn't have /api/stats).`);
  if (res.status === 401) throw new Error("The server refused the admin token: it isn't the one set there.");
  if (!res.ok) throw new Error(`The server answered ${res.status}.`);
  const body = await res.json();
  if (!body || body.ok !== true) throw new Error("The server's answer isn't a stats answer.");
  console.log(args.json ? JSON.stringify(body, null, 2) : formatStats(body).join("\n"));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.error(e?.message ?? String(e));
    process.exit(1);
  });
}
