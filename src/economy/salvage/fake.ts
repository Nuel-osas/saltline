// A small in-memory chain for the salvage lane's own tests and smoke runs, until the shared mock (mock.ts) lands. It
// implements the whole Chain interface, enforces the run rules the salvage code depends on (manifest indices, each
// listed once, the carry limit, the finder's share) and records every call so tests can check what was sent.
import { BROKERS, ITEMS, RULES } from "../items";
import type {
  Amounts,
  BrokerId,
  BrokerView,
  CargoId,
  Chain,
  Economy,
  GearId,
  Manifest,
  TxResult,
  Wallet,
  WreckView,
} from "../types";
import { SALVAGE_SPOTS } from "./spots";

export type FakeMode = "ok" | "refuse" | "reject" | "hang";

export interface FakeChainOptions {
  /** Milliseconds before each call settles (0 = next microtask). */
  delayMs?: number;
  seed?: number;
  /** How each run call behaves; "ok" by default. */
  modes?: Partial<Record<"startRun" | "extract" | "die" | "brokers", FakeMode>>;
  /** Explorer base for txUrl; null (the default) behaves like the mock: no link. */
  txBase?: string | null;
  /** Wrecks offered per manifest (0–3, default 2). */
  wrecks?: number;
}

export interface FakeCall {
  method: string;
  args: unknown[];
}

const CALLSIGNS = ["K. OSEI", "M. VARGA", "T. ABARA", "R. LINDQVIST", "D. MENSAH", "J. CORREIA"];

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function createFakeChain(
  opts: FakeChainOptions = {},
): Chain & { calls: FakeCall[]; runs: Map<number, Manifest> } {
  const calls: FakeCall[] = [];
  const runs = new Map<number, Manifest>();
  const closed = new Set<number>();
  const rand = rng(opts.seed ?? 4207);
  let nextRun = 1,
    nextTx = 1,
    nextWreck = 100;
  const mode = (m: keyof NonNullable<FakeChainOptions["modes"]>) => opts.modes?.[m] ?? "ok";
  const tx = () => `fake${String(nextTx++).padStart(4, "0")}`;

  function settle<T>(
    method: "startRun" | "extract" | "die" | "brokers" | null,
    make: () => T,
    refused?: T,
  ): Promise<T> {
    const m = method ? mode(method) : "ok";
    if (m === "hang") return new Promise<T>(() => {});
    return new Promise<T>((resolve, reject) => {
      const go = () => {
        if (m === "reject") reject(new Error("fake chain: no response"));
        else if (m === "refuse" && refused !== undefined) resolve(refused);
        else
          try {
            resolve(make());
          } catch (e) {
            reject(e);
          }
      };
      if (opts.delayMs) setTimeout(go, opts.delayMs);
      else queueMicrotask(go);
    });
  }

  function makeManifest(): Manifest {
    const spots = SALVAGE_SPOTS.map((s) => s.id);
    for (let i = spots.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [spots[i], spots[j]] = [spots[j], spots[i]];
    }
    const pick = (): CargoId => {
      const r = rand();
      return r < 0.3 ? "copper" : r < 0.55 ? "chips" : r < 0.75 ? "meds" : r < 0.9 ? "fuel" : "core";
    };
    const containers = spots.slice(0, RULES.containersPerRun).map((spot) => {
      const tokenId = pick();
      return { spot, tokenId, amount: tokenId === "fuel" || tokenId === "core" ? 1 : 1 + Math.floor(rand() * 2) };
    });
    const nW = Math.max(0, Math.min(RULES.wrecksPerRun, opts.wrecks ?? 2));
    const wrecks: WreckView[] = spots.slice(RULES.containersPerRun, RULES.containersPerRun + nW).map((spot, i) => ({
      id: nextWreck++,
      spot,
      owner: `fake-${i}.testnet`,
      callsign: CALLSIGNS[Math.floor(rand() * CALLSIGNS.length)],
      items: [{ tokenId: pick(), amount: 1 }],
      at: Date.now() - Math.round((0.6 + rand() * 5) * 3600_000),
    }));
    return { runId: nextRun++, startedAt: Date.now(), containers, wrecks };
  }

  function check(runId: number, opened: number[], wreckIds: number[]): Manifest {
    const m = runs.get(runId);
    if (!m) throw new Error("E_NO_RUN");
    if (closed.has(runId)) throw new Error("E_RUN_CLOSED");
    if (new Set(opened).size !== opened.length || new Set(wreckIds).size !== wreckIds.length)
      throw new Error("E_DUPLICATE");
    let weight = 0;
    for (const s of opened) {
      const c = m.containers.find((e) => e.spot === s);
      if (!c) throw new Error("E_NOT_IN_MANIFEST");
      weight += ITEMS[c.tokenId].weight * c.amount;
    }
    for (const id of wreckIds) {
      const w = m.wrecks.find((e) => e.id === id);
      if (!w) throw new Error("E_NOT_IN_MANIFEST");
      for (const it of w.items) weight += ITEMS[it.tokenId].weight * it.amount;
    }
    if (weight > RULES.carryLimit) throw new Error("E_OVER_LIMIT");
    return m;
  }

  const refusedOn = (e: unknown): TxResult => ({ ok: false, error: String((e as Error).message || e) });

  const chain = {
    network: "mock" as const,
    contractId: "fake.saltline.testnet",
    calls,
    runs,
    txUrl: (h: string) => (opts.txBase ? opts.txBase + encodeURIComponent(h) : null),

    profile: async () => null,
    balances: async () => ({}),
    brokers(): Promise<BrokerView[]> {
      calls.push({ method: "brokers", args: [] });
      return settle("brokers", () =>
        (Object.keys(BROKERS) as BrokerId[]).map((id) => {
          const b = BROKERS[id];
          const stock: Amounts<CargoId> = {};
          const bids = b.buys.map((t) => {
            const target = ITEMS[t].target!;
            const s = Math.floor(target * 0.75);
            stock[t] = s;
            const price = Math.floor((ITEMS[t].base * 2 * target) / (target + s));
            return { tokenId: t, price, reason: `Holding ${s} against a target of ${target}.` };
          });
          return {
            id,
            accountId: `${id}.fake.saltline.testnet`,
            name: b.name,
            open: true,
            scrip: 1500,
            stance: 100,
            stock,
            bids,
            asks: b.sells.map((t) => ({ tokenId: t, price: ITEMS[t].base, reason: "No recent sales." })),
            shares: [],
            lastMemo: null,
          };
        }),
      );
    },
    wrecks: async () => [...runs.values()].flatMap((m) => m.wrecks),
    listings: async () => [],
    recent: async () => [],
    leaderboard: async () => ({ netWorth: [], bestHaul: [], investors: [] }),
    simulate: async () => [],

    startRun(gear: GearId[]) {
      calls.push({ method: "startRun", args: [[...gear]] });
      return settle<TxResult & { manifest?: Manifest }>(
        "startRun",
        () => {
          const manifest = makeManifest();
          runs.set(manifest.runId, manifest);
          return { ok: true, txHash: tx(), manifest };
        },
        { ok: false, error: "Equipping gear you don't have" },
      );
    },
    extract(runId: number, opened: number[], wreckIds: number[]) {
      calls.push({ method: "extract", args: [runId, [...opened], [...wreckIds]] });
      return settle<TxResult & { minted?: Amounts<CargoId> }>(
        "extract",
        () => {
          let m: Manifest;
          try {
            m = check(runId, opened, wreckIds);
          } catch (e) {
            return refusedOn(e);
          }
          closed.add(runId);
          const minted: Amounts<CargoId> = {};
          const add = (t: CargoId, n: number) => n > 0 && (minted[t] = (minted[t] ?? 0) + n);
          for (const s of opened) {
            const c = m.containers.find((e) => e.spot === s)!;
            add(c.tokenId, c.amount);
          }
          // The finder keeps 70%, rounded down: the rounding goes the original owner's way.
          for (const id of wreckIds)
            for (const it of m.wrecks.find((e) => e.id === id)!.items)
              add(it.tokenId, Math.floor(it.amount * RULES.finderShare));
          return { ok: true, txHash: tx(), minted };
        },
        { ok: false, error: "Too soon" },
      );
    },
    die(runId: number, opened: number[], wreckIds: number[], spot: number) {
      calls.push({ method: "die", args: [runId, [...opened], [...wreckIds], spot] });
      return settle<TxResult>(
        "die",
        () => {
          try {
            check(runId, opened, wreckIds);
          } catch (e) {
            return refusedOn(e);
          }
          closed.add(runId);
          return { ok: true, txHash: tx() };
        },
        { ok: false, error: "The run is already closed" },
      );
    },
    sell: async () => ({ ok: false, error: "Not in the fake" }),
    buy: async () => ({ ok: false, error: "Not in the fake" }),
    invest: async () => ({ ok: false, error: "Not in the fake" }),
    list: async () => ({ ok: false, error: "Not in the fake" }),
    buyListing: async () => ({ ok: false, error: "Not in the fake" }),
    cancelListing: async () => ({ ok: false, error: "Not in the fake" }),
  };
  return chain;
}

export function createFakeEconomy(
  opts: FakeChainOptions = {},
): Economy & { chain: ReturnType<typeof createFakeChain> } {
  const wallet: Wallet = {
    kind: "mock",
    accountId: () => "breacher.fake.saltline.testnet",
    registered: async () => true,
    claim: async () => ({ ok: true }),
  };
  return { chain: createFakeChain(opts), wallet, manifest: null, carried: {}, equipped: [] };
}
