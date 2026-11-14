// scripts/stats.mjs (`npm run stats`), offline: how an answer from GET /api/stats is printed. The rule it must keep
// is the one the API keeps: a number that couldn't be read is "unknown" on screen, never 0.
import { describe, expect, it } from "vitest";
import { readStats } from "../server/counts";
import { memoryStore, offStore } from "../server/store";

interface Script {
  formatStats(stats: unknown): string[];
  readDotEnv(text: string, keys: string[]): Record<string, string>;
  parseArgs(argv: string[]): { url: string | null; users: number | null; json: boolean };
  settings(args: { url: string | null; users: number | null }, env: Record<string, string | undefined>, fromFile: Record<string, string>): { token: string; url: URL };
  table(rows: (string | number)[][]): string[];
}
const path = "../scripts/stats.mjs";
const load = async () => (await import(/* @vite-ignore */ path)) as Script;

const NOON = Date.UTC(2027, 0, 15, 12, 0, 0);
const day = (name: string, n: number | null) => ({ day: name, visits: n, devices: n, signIns: n, sessions: n, passes: n, raidsStarted: n, raidsExtracted: n, raidsDied: n, dockOpens: n, practiceStarts: n });

describe("npm run stats", () => {
  it("prints the days, who is online, the users and the funnel", async () => {
    const { formatStats } = await load();
    const lines = formatStats({
      ok: true,
      at: "2027-01-15T12:00:00.000Z",
      store: "upstash",
      recordingSince: "2027-01-14T09:30:00.000Z",
      onlineNow: 3,
      totalUsers: 1204,
      today: { ...day("2027-01-15", 0), visits: 1500, devices: 40, signIns: 12, passes: 4, raidsStarted: 9, raidsExtracted: 5, raidsDied: 3 },
      days: [day("2027-01-14", 2), day("2027-01-13", null)],
      funnel: { days: 15, visited: 40, signedIn: 12, gotPass: 6, startedRaid: 6, extracted: 0 },
    });
    expect(lines).toEqual([
      "Saltline · read 2027-01-15 12:00 UTC · store: upstash",
      "Counting since 2027-01-14 09:30 UTC. Days before that are unknown, not 0.",
      "",
      "day (UTC)          visits  devices  sign-ins  wallets   passes    raids  extracted     died     dock  practice",
      "2027-01-15 today    1,500       40        12        0        4        9          5        3        0         0",
      "2027-01-14              2        2         2        2        2        2          2        2        2         2",
      "2027-01-13        unknown  unknown   unknown  unknown  unknown  unknown    unknown  unknown  unknown   unknown",
      "",
      "Online now (heard from in the last 2 minutes): 3",
      "Users on record: 1,204",
      "",
      "Funnel: distinct devices over the last 15 days",
      "  visited         40",
      "  signed in       12  30% of the step before",
      "  got a pass       6  50% of the step before",
      "  started a raid   6  100% of the step before",
      "  extracted        0  0% of the step before",
    ]);
  });

  it("prints unknown, and never a 0, for a server whose database is off", async () => {
    const { formatStats } = await load();
    const lines = formatStats({ ok: true, ...(await readStats(offStore(), NOON)), users: null });
    expect(lines[1]).toBe("The database is off on that server: nothing is being kept, and every number below is unknown.");
    expect(lines).toContain("Online now (heard from in the last 2 minutes): unknown");
    expect(lines).toContain("Users on record: unknown");
    expect(lines).toContain("  visited         unknown");
    expect(lines).toContain("Newest users: unknown");
    const numbers = lines.slice(4).join("\n").replace(/\d{4}-\d{2}-\d{2}/g, "").replace("last 2 minutes", "").replace("last 15 days", "");
    expect(numbers).not.toMatch(/\d/);
  });

  it("says so when nothing has been counted yet, and shows a real zero as 0", async () => {
    const { formatStats } = await load();
    const lines = formatStats({ ok: true, ...(await readStats(memoryStore(), NOON)), users: [] });
    expect(lines[1]).toContain("Nothing has been counted yet");
    expect(lines).toContain("Users on record: 0");
    expect(lines).toContain("Online now (heard from in the last 2 minutes): unknown");
    expect(lines).toContain("Newest users: none on record");
  });

  it("lists the newest users without their Privy ids", async () => {
    const { formatStats } = await load();
    const base = await readStats(memoryStore(), NOON);
    const lines = formatStats({
      ok: true,
      ...base,
      users: [
        { id: "did:privy:cmalice000000000000000001", accountId: "ab".repeat(32), callsign: "ROOK", firstSeen: "2027-01-15T10:00:00.000Z", lastSeen: "2027-01-15T11:59:00.000Z", passAt: "2027-01-15T10:02:00.000Z", sessions: 1, visits: 7 },
        { id: "did:privy:cmbob00000000000000000002", accountId: "cd".repeat(32), callsign: null, firstSeen: "2027-01-14T10:00:00.000Z", lastSeen: null, passAt: null, sessions: 2, visits: 0 },
      ],
    });
    const at = lines.indexOf("Newest users");
    expect(lines.slice(at + 1)).toEqual([
      "  callsign             first seen             last seen                  pass  wallets  visits                                                           account",
      `  ROOK       2027-01-15 10:00 UTC  2027-01-15 11:59 UTC  2027-01-15 10:02 UTC        1       7  ${"ab".repeat(32)}`,
      `  (no pass)  2027-01-14 10:00 UTC               unknown                  none        2       0  ${"cd".repeat(32)}`,
    ]);
    expect(lines.join("\n")).not.toContain("did:privy");
  });

  it("reads only the keys it asks for from .env, quoted or not", async () => {
    const { readDotEnv } = await load();
    const text = ['# comment', 'WALLET_SECRET=do-not-read-me', 'STATS_ADMIN_TOKEN="abc123"', "export STATS_URL = https://example.com/api/stats ", "STATS_URLS=nope"].join("\n");
    expect(readDotEnv(text, ["STATS_ADMIN_TOKEN", "STATS_URL"])).toEqual({ STATS_ADMIN_TOKEN: "abc123", STATS_URL: "https://example.com/api/stats" });
  });

  it("asks the address on the command line, else the environment's, else .env's, else the local dev server", async () => {
    const { settings } = await load();
    const none = { url: null, users: null };
    const T = "admin-token-0123456789abcdef";
    expect(settings(none, { STATS_ADMIN_TOKEN: T }, {}).url.href).toBe("http://127.0.0.1:5280/api/stats");
    expect(settings(none, {}, { STATS_ADMIN_TOKEN: T, STATS_URL: "https://file.example/api/stats" })).toEqual({ token: T, url: new URL("https://file.example/api/stats") });
    expect(settings(none, { STATS_URL: "https://env.example/api/stats", STATS_ADMIN_TOKEN: T }, { STATS_URL: "https://file.example/api/stats" }).url.host).toBe("env.example");
    expect(settings({ url: "https://arg.example/api/stats", users: 20 }, { STATS_URL: "https://env.example/api/stats", STATS_ADMIN_TOKEN: T }, {}).url.href).toBe("https://arg.example/api/stats?users=20");
    // .env.example ships these keys empty: empty is not set, not "ask the empty address with the empty token".
    expect(settings(none, { STATS_URL: "", STATS_ADMIN_TOKEN: " " }, { STATS_ADMIN_TOKEN: T, STATS_URL: "" }).url.href).toBe("http://127.0.0.1:5280/api/stats");
  });

  it("won't go without a token, and won't send the token in clear to another machine", async () => {
    const { settings } = await load();
    const none = { url: null, users: null };
    expect(() => settings(none, {}, {})).toThrow("STATS_ADMIN_TOKEN isn't set");
    expect(() => settings(none, { STATS_ADMIN_TOKEN: "" }, { STATS_ADMIN_TOKEN: "" })).toThrow("STATS_ADMIN_TOKEN isn't set");
    const T = { STATS_ADMIN_TOKEN: "admin-token-0123456789abcdef" };
    expect(() => settings({ url: "http://saltline.example/api/stats", users: null }, T, {})).toThrow("must be https");
    expect(() => settings({ url: "ftp://127.0.0.1/api/stats", users: null }, T, {})).toThrow("must be https");
    expect(() => settings({ url: "not a url", users: null }, T, {})).toThrow("isn't a URL");
    expect(settings({ url: "http://localhost:5295/api/stats", users: null }, T, {}).url.port).toBe("5295");
  });

  it("takes --url, --users and --json, and refuses anything else", async () => {
    const { parseArgs } = await load();
    expect(parseArgs([])).toEqual({ url: null, users: null, json: false });
    expect(parseArgs(["--url", "https://x.example/api/stats", "--users", "20", "--json"])).toEqual({ url: "https://x.example/api/stats", users: 20, json: true });
    expect(() => parseArgs(["--token", "abc"])).toThrow("Unknown option: --token");
    expect(() => parseArgs(["--users", "many"])).toThrow("Unknown option");
  });
});
