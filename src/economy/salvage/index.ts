// In-run salvage (docs/ECONOMY.md → The loop on paper, Runs on-chain). On each run start it asks the chain for a
// manifest without waiting for it, seals the manifest's containers in the yard, lays out other players' wrecks, lets
// the player cut seals and turn over wrecks with E (refused over the carry limit), slows them by what they carry, and
// on death or at the boat sends the run's bookkeeping to the chain and shows the result on the dead or debrief card.
//
// The shooter never waits on any of it: a pending, refused or malformed manifest leaves the baseline game.
import { RULES } from "../items";
import type { Economy, GearId } from "../types";
import { createSalvageHud, type DebriefView, type Marker } from "./hud";
import { WRECK_SLOTS, sealPoint, wreckPoint, type Point } from "./place";
import {
  SEAL_SECONDS,
  SHORT,
  SalvageLedger,
  checkManifest,
  cleanGear,
  cutTime,
  formatItems,
  haulValue,
  resetBonuses,
  toItems,
  type GearBonuses,
  type Items,
} from "./run";
import { SALVAGE_SPOTS } from "./spots";
import { createSalvageWorld } from "./world";

/* eslint-disable @typescript-eslint/no-explicit-any -- the game context is the untyped bundle's G */
type Game = any;

/** The same reach and facing as the relays (game.js Yi.interactRange, Yi.interactFacing). */
const RANGE = 2.2;
const FACING = 0.45;
/** World markers for the nearest few; the compass shows them all. */
const NEAR_MARKERS = 2;

interface Target {
  key: string;
  kind: "seal" | "wreck";
  spot: number;
  wreckId: number;
  at: Point;
  /** The doors' outward direction: seals are only reachable from in front. */
  out: { x: number; z: number };
  items: Items;
  callsign: string;
  /** Wrecks: the WRECK_SLOTS index it lies in. */
  slot: number;
}

interface Run {
  token: number;
  /** Gear the reset applied for this run, sent to startRun. */
  gear: GearId[];
  status: "pending" | "live" | "off";
  ledger: SalvageLedger | null;
  ended: "dead" | "extracted" | null;
  targets: Target[];
  hold: { key: string; t: number; refused: boolean; spark: number } | null;
}

export interface Salvage {
  update(dt: number): void;
  /** G.ext.interact: takes the prompt slot when a seal or wreck is in reach. */
  interact(dt: number): boolean;
  dispose(): void;
  /** For debugging and the smoke test. */
  readonly state: {
    status: Run["status"] | "none";
    runId: number | null;
    opened: number[];
    wrecks: number[];
    targets: Target[];
  };
}

export function createSalvage(G: Game, economy: Economy): Salvage {
  const ext = (G.ext ??= { speedScale: 1, gear: {} });
  const hud = createSalvageHud(G);
  const world = createSalvageWorld(G);
  const offs: (() => void)[] = [];
  const on = (name: string, fn: (e: any) => void) => {
    const off = G.events?.on?.(name, (e: any) => guard(name, () => fn(e)));
    if (typeof off === "function") offs.push(off);
  };
  const warned = new Set<string>();
  function guard<T>(where: string, fn: () => T): T | undefined {
    try {
      return fn();
    } catch (e) {
      if (!warned.has(where)) (warned.add(where), console.warn(`[salvage] ${where} failed; the run plays on`, e));
      return undefined;
    }
  }
  const call = (o: any, m: string, ...a: unknown[]) =>
    guard(m, () => (o && typeof o[m] === "function" ? o[m](...a) : undefined));

  let run: Run | null = null;
  let tokens = 0;
  /** The gear the next reset will apply (economy.equipped, cleaned). */
  let nextGear: GearId[] = [];
  let gearKey = "";
  let interactedAt = -1;
  let markT = 0;
  let cargoT = 0;
  /** A radio line held until the run is on (the HUD is down during the intro). */
  let say: string | null = null;

  // ---- gear: the reset reads health and rounds; the cutter is read live, so it follows the current run ----
  function syncGear() {
    nextGear = cleanGear(economy.equipped);
    const live = run && !run.ended && run.status !== "off" ? run.gear : [];
    const g: GearBonuses = { ...resetBonuses(nextGear) };
    if (cutTime(live) !== 1) g.cutTime = cutTime(live);
    const key = JSON.stringify(g);
    if (key !== gearKey) ((gearKey = key), (ext.gear = g));
  }

  /** Take back gear the reset applied when the chain didn't confirm the run burned it (fail closed). */
  function revokeGear(gear: GearId[]) {
    const b = resetBonuses(gear);
    const p = G.player,
      w = G.weapon;
    if (b.health && p && typeof p.maxHealth === "number") {
      p.maxHealth -= b.health;
      p.health = Math.min(p.health, p.maxHealth);
    }
    if (b.rounds && w && typeof w.magSize === "number") {
      w.magSize -= b.rounds;
      w.ammo = Math.min(w.ammo, w.magSize);
    }
  }

  // ---- run lifecycle ----
  function startRun() {
    say = null;
    world.clear();
    hud.setLost(null);
    hud.setDebrief(null);
    hud.setMarkers([]);
    const token = ++tokens;
    run = { token, gear: [...nextGear], status: "pending", ledger: null, ended: null, targets: [], hold: null };
    economy.manifest = null;
    economy.carried = {};
    ext.speedScale = 1;
    syncGear();
    refreshCargo();
    // "Play without a pass" (the Dockside's deploy gate): this one run is the baseline. No start_run is sent, since
    // the contract would only refuse it, and Control says why once the run is on.
    if (economy.passless) {
      economy.passless = false;
      say = "No dock pass on file, Breacher. The yard's cargo stays sealed this run. Sign on at the Dockside.";
      noManifest(token, "played without a pass", undefined, false);
      return;
    }
    let p: Promise<any>;
    try {
      p = Promise.resolve(economy.chain.startRun([...run.gear]));
    } catch (e) {
      p = Promise.reject(e);
    }
    p.then(
      (res) => guard("manifest", () => onManifest(token, res)),
      (e) => guard("manifest", () => noManifest(token, "unreachable", e)),
    );
  }

  function onManifest(token: number, res: any) {
    if (!run || run.token !== token || run.ended) return;
    const m = res && res.ok ? checkManifest(res.manifest) : null;
    if (!m) return noManifest(token, res && !res.ok ? "refused" : "unreadable", res && res.error);
    const r = run;
    r.status = "live";
    r.ledger = new SalvageLedger(m);
    economy.manifest = m;
    // The chain burned the gear: it's off the equipped list now.
    if (r.gear.length && Array.isArray(economy.equipped))
      economy.equipped = economy.equipped.filter((g) => !r.gear.includes(g));
    r.targets = buildTargets(r.ledger);
    world.build(m, new Map(r.targets.filter((t) => t.kind === "wreck").map((t) => [t.wreckId, t.slot])));
    G.events?.emit?.("run:manifest", { manifest: m });
    const n = m.containers.length;
    call(
      G.hud,
      "radio",
      `Manifest's in. ${n} sealed ${n === 1 ? "box" : "boxes"}${m.wrecks.length ? ", and wrecks from the last crews" : ""}. Every crate slows you.`,
      3.8,
    );
    refreshMarkers(true);
    refreshCargo();
  }

  function noManifest(token: number, why: string, detail?: unknown, notice = true) {
    if (!run || run.token !== token) return;
    const gear = run.gear;
    run.status = "off";
    run.gear = [];
    economy.manifest = null;
    if (!run.ended) {
      revokeGear(gear);
      syncGear();
      if (notice) call(G.hud, "message", "No manifest — salvage closed this run", 3);
    }
    refreshCargo();
    console.info(`[salvage] no manifest (${why}); baseline run`, detail ?? "");
  }

  function buildTargets(ledger: SalvageLedger): Target[] {
    const out: Target[] = [];
    for (const c of ledger.sealed()) {
      const s = SALVAGE_SPOTS[c.spot];
      out.push({
        key: "s" + c.spot,
        kind: "seal",
        spot: c.spot,
        wreckId: -1,
        at: sealPoint(s),
        out: { x: Math.cos(s.yaw), z: -Math.sin(s.yaw) },
        items: [{ tokenId: c.tokenId, amount: c.amount }],
        callsign: "",
        slot: -1,
      });
    }
    // Wrecks lie beside the doors, in the first slot whose whole footprint is open floor and not already taken.
    const used = new Set<string>();
    for (const w of ledger.standing()) {
      const s = SALVAGE_SPOTS[w.spot];
      let slot = WRECK_SLOTS.findIndex((_, i) => !used.has(w.spot + ":" + i) && clearFloor(wreckPoint(s, i)));
      if (slot < 0) slot = WRECK_SLOTS.findIndex((_, i) => !used.has(w.spot + ":" + i));
      used.add(w.spot + ":" + slot);
      const p = wreckPoint(s, slot);
      out.push({
        key: "w" + w.id,
        kind: "wreck",
        spot: w.spot,
        wreckId: w.id,
        at: { x: p.x, y: 0.55, z: p.z },
        out: { x: Math.cos(s.yaw), z: -Math.sin(s.yaw) },
        items: w.items,
        callsign: w.callsign,
        slot,
      });
    }
    return out;
  }
  /** Open floor for a wreck: the nav grid (which already keeps 0.5 m off obstacles) at its centre and corners. */
  const clearFloor = (p: Point) => {
    const nav = G.physics && G.physics.nav;
    if (!nav || typeof nav.isWalkable !== "function") return true;
    return (
      guard("nav", () =>
        [
          [0, 0],
          [0.6, 0.6],
          [0.6, -0.6],
          [-0.6, 0.6],
          [-0.6, -0.6],
        ].every(([dx, dz]) => nav.isWalkable(p.x + dx, p.z + dz)),
      ) ?? true
    );
  };

  // ---- interaction: G.ext.interact, called by the relay loop when no relay holds the prompt ----
  function target(): Target | null {
    const p = G.player;
    if (!run || !p || !p.pos) return null;
    const f = p.forward || { x: 0, z: -1 };
    const fl = Math.max(0.2, Math.hypot(f.x, f.z));
    let best: Target | null = null,
      bestD: number = RANGE;
    for (const t of run.targets) {
      const dx = t.at.x - p.pos.x,
        dz = t.at.z - p.pos.z,
        d = Math.hypot(dx, dz);
      if (d > bestD || Math.abs(t.at.y - (p.pos.y || 0)) > 2.5) continue;
      if (d > 0.9 && (dx * f.x + dz * f.z) / (d * fl) < FACING) continue;
      // A seal is cut from in front of the doors, never through the container.
      if (t.kind === "seal" && -dx * t.out.x - dz * t.out.z < 0.15) continue;
      best = t;
      bestD = d;
    }
    return best;
  }

  function interact(dt: number): boolean {
    interactedAt = performance.now();
    return (
      guard("interact", () => {
        const r = run;
        if (!r || r.status !== "live" || r.ended || !r.ledger || !G.player?.alive) return release();
        const t = target();
        if (!t) return release();
        if (!r.hold || r.hold.key !== t.key) r.hold = { key: t.key, t: 0, refused: false, spark: 0 };
        const h = r.hold;
        const held = !!call(G.input, "down", "interact");
        const what = formatItems(t.items);
        const verb = t.kind === "seal" ? "Cut seal" : `Recover wreck · ${t.callsign}`;
        if (held && !r.ledger.fits(t.items)) {
          if (!h.refused) {
            h.refused = true;
            call(G.hud, "message", `Load limit ${RULES.carryLimit}. You carry ${r.ledger.weight()}.`, 2.6);
          }
          h.t = 0;
          call(G.hud, "setPrompt", `Too heavy · ${what}`, 0);
          return true;
        }
        if (!held) h.refused = false;
        if (held) {
          h.t += dt / (SEAL_SECONDS * cutTime(r.gear));
          h.spark -= dt;
          if (h.spark <= 0) ((h.spark = 0.07), world.working(t.at, t.out.x, t.out.z));
          if (h.t >= 1) {
            take(r, t);
            r.hold = null;
            call(G.hud, "setPrompt", null);
            return true;
          }
        } else h.t = Math.max(0, h.t - dt * 1.6);
        call(G.hud, "setPrompt", `${verb} · ${what}`, Math.min(1, h.t));
        return true;
      }) ?? false
    );
  }
  const release = () => {
    if (run) run.hold = null;
    return false;
  };

  function take(r: Run, t: Target) {
    const res = t.kind === "seal" ? r.ledger!.cut(t.spot) : r.ledger!.recover(t.wreckId);
    if (!res.ok) return;
    r.targets = r.targets.filter((e) => e !== t);
    economy.carried = { ...r.ledger!.carried };
    ext.speedScale = r.ledger!.speed();
    const what = formatItems(t.items);
    if (t.kind === "seal") {
      world.cutSeal(t.spot);
      G.events?.emit?.("cargo:taken", { spot: t.spot, items: t.items, carried: economy.carried, weight: res.weight });
      call(G.hud, "feed", `<b>${what}</b> taken`);
    } else {
      world.recoverWreck(t.wreckId);
      G.events?.emit?.("wreck:found", {
        id: t.wreckId,
        callsign: t.callsign,
        items: t.items,
        carried: economy.carried,
        weight: res.weight,
      });
      call(G.hud, "feed", `<b>Wreck</b> recovered · ${what}`);
    }
    guard("fx", () => {
      const V = G.THREE && G.THREE.Vector3;
      if (V && G.fx?.sparks) G.fx.sparks(new V(t.at.x, t.at.y, t.at.z), new V(t.out.x, 0.7, t.out.z).normalize(), 16);
    });
    call(G.audio, "play", "relay_cut", {
      pos: { x: t.at.x, y: t.at.y, z: t.at.z },
      gain: 0.7,
      pitch: t.kind === "seal" ? 1.15 : 0.9,
    });
    refreshMarkers(true);
    refreshCargo();
  }

  // ---- the end of a run ----
  function onDeath() {
    const r = run;
    if (!r || r.ended) return;
    r.ended = "dead";
    r.hold = null;
    ext.speedScale = 1;
    hud.setMarkers([]);
    syncGear();
    refreshCargo();
    if (r.status !== "live" || !r.ledger) return;
    const args = r.ledger.dieArgs(G.player?.pos?.x ?? 0, G.player?.pos?.z ?? 0);
    const lost = formatItems(r.ledger.carried);
    economy.manifest = null;
    economy.carried = {};
    if (lost) G.events?.emit?.("cargo:dropped", { spot: args[3], items: toItems(r.ledger.carried) });
    if (lost) hud.setLost(`${lost} — logging the wreck…`, "pending");
    settle(() => economy.chain.die(...args)).then(
      (res) => {
        if (!lost || !run || run.token !== r.token) return;
        if (res.ok) hud.setLost(`${lost} — left as a wreck`);
        else hud.setLost(`${lost} — not logged: ${res.error || "refused"}`, "refused");
      },
      () => {
        // No answer is not a refusal: the wreck may well be on the ledger.
        if (lost && run && run.token === r.token) hud.setLost(`${lost} — wreck unconfirmed`, "pending");
      },
    );
  }

  function onExtract() {
    const r = run;
    if (!r || r.ended) return;
    r.ended = "extracted";
    r.hold = null;
    ext.speedScale = 1;
    hud.setMarkers([]);
    syncGear();
    refreshCargo();
    if (r.status !== "live" || !r.ledger) return;
    const args = r.ledger.extractArgs();
    const carried = { ...r.ledger.carried };
    economy.manifest = null;
    economy.carried = {};
    const lines = (a: typeof carried) => toItems(a).map((it) => `${SHORT[it.tokenId]} ×${it.amount}`);
    const view: DebriefView = {
      haul: lines(carried),
      value: "settling…",
      ledger: { text: "settling…", state: "pending" },
    };
    hud.setDebrief(view);
    // The bids are a view: if they don't come back in time the value is unknown, never a guess.
    const bids = Promise.race([
      settle(() => economy.chain.brokers()).catch(() => null),
      new Promise<null>((ok) => setTimeout(() => ok(null), 5000)),
    ]);
    settle(() => economy.chain.extract(...args)).then(
      async (res) => {
        if (!run || run.token !== r.token) return;
        if (res.ok) {
          const minted = res.minted ?? carried;
          const v = haulValue(minted, await bids);
          if (!run || run.token !== r.token) return;
          view.haul = lines(minted).length ? lines(minted) : ["Nothing minted"];
          view.value = v == null ? "unknown" : `${v} scrip`;
          view.ledger = res.txHash
            ? {
                text: res.txHash.length > 14 ? `${res.txHash.slice(0, 6)}…${res.txHash.slice(-4)}` : res.txHash,
                href: economy.chain.txUrl(res.txHash),
                state: "ok",
              }
            : { text: "recorded", state: "ok" };
          // The story's Harbormaster invoices the haul at the debrief's value (story/index.ts); null when unknown.
          guard("extracted", () => G.events?.emit?.("run:extracted", { minted: { ...minted }, value: v ?? null }));
        } else {
          view.value = "none minted";
          view.ledger = { text: `Refused: ${res.error || "no reason given"}`, state: "refused" };
        }
        hud.setDebrief(view);
      },
      () => {
        if (!run || run.token !== r.token) return;
        // Ambiguous, so pending: the haul may have minted. The Dockside reads the real balance.
        view.value = "unknown";
        view.ledger = { text: "unconfirmed — check the Dockside", state: "pending" };
        hud.setDebrief(view);
      },
    );
  }

  /** A chain call as a promise, even when the call throws before returning one. */
  function settle<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return Promise.resolve(fn());
    } catch (e) {
      return Promise.reject(e);
    }
  }

  // ---- HUD ----
  function refreshCargo() {
    const r = run;
    const live = !!r && r.status === "live" && !r.ended && !!r.ledger;
    hud.setCargo({
      mode: !r || r.ended || r.status === "off" ? "off" : live ? "live" : "pending",
      carried: live ? r!.ledger!.carried : {},
      weight: live ? r!.ledger!.weight() : 0,
      pace: live ? r!.ledger!.speed() : 1,
      sealed: live ? r!.targets.filter((t) => t.kind === "seal").length : 0,
      wrecks: live ? r!.targets.filter((t) => t.kind === "wreck").length : 0,
    });
  }

  function refreshMarkers(force = false) {
    const r = run;
    if (!r || r.ended || r.status !== "live") return;
    if (force) markT = 0.5;
    const p = G.player?.pos;
    const by = (t: Target) => (p ? Math.hypot(t.at.x - p.x, t.at.z - p.z) : 0);
    const near = new Set([...r.targets].sort((a, b) => by(a) - by(b)).slice(0, NEAR_MARKERS));
    const list: Marker[] = r.targets.map((t) => ({
      id: t.key + (near.has(t) ? "" : "~"),
      short: t.kind === "seal" ? SHORT[t.items[0].tokenId] : "WRECK",
      label: t.kind === "seal" ? `Sealed · ${formatItems(t.items)}` : `Wreck · ${t.callsign}`,
      // The HUD floats world markers 1.9 m over pos: a metre up puts them over the box, clear of the seal.
      pos: { x: t.at.x, y: t.kind === "seal" ? 1 : 0, z: t.at.z },
      // "far" markers keep their compass tick but hide the floating world marker (salvage.css).
      kind: (t.kind === "seal" ? "cargo" : "wreck") + (near.has(t) ? "" : " far"),
    }));
    hud.setMarkers(list);
  }

  on("run:start", startRun);
  on("player:dead", onDeath);
  on("extraction:reached", onExtract);
  ext.interact = interact;
  syncGear();
  // Attached mid-run (an ?autostart run starts before the economy loads): this run gets a manifest too, with no gear.
  const st = G.game && G.game.state;
  if (st === "intro" || st === "playing" || st === "paused") guard("late start", () => ((nextGear = []), startRun()));

  return {
    interact,
    update(dt: number) {
      if (G.game?.state === "paused") return;
      guard("update", () => {
        if (say && G.game?.state === "playing") {
          call(G.hud, "radio", say, 5);
          say = null;
        }
        syncGear();
        world.update(dt);
        // The relay loop stopped calling us (a relay took the slot, or the run ended): let go of the seal.
        if (run?.hold && performance.now() - interactedAt > 150) run.hold = null;
        if ((markT -= dt) <= 0) ((markT = 0.5), refreshMarkers());
        if ((cargoT -= dt) <= 0) ((cargoT = 0.25), refreshCargo());
      });
    },
    dispose() {
      for (const off of offs) off();
      if (ext.interact === interact) delete ext.interact;
      ext.speedScale = 1;
      ext.gear = {};
      world.clear();
      hud.dispose();
    },
    get state() {
      return {
        status: run ? run.status : ("none" as const),
        runId: run?.ledger?.runId ?? null,
        opened: run?.ledger ? [...run.ledger.opened] : [],
        wrecks: run?.ledger ? [...run.ledger.wrecks] : [],
        targets: run ? run.targets : [],
      };
    },
  };
}

/**
 * Starts salvage beside a booted game and drives its update on animation frames, on G.economy (the offline mock or
 * testnet, set by main.ts). Without an economy, or on any failure, it leaves the baseline game.
 */
export function startSalvage(G: Game): Salvage | null {
  try {
    const economy: Economy | undefined = G.economy;
    if (!economy) return null; // no economy attached (?noeconomy, or it failed to start): the baseline game
    const s = createSalvage(G, economy);
    G.salvage = s;
    let last = performance.now();
    const loop = (now: number) => {
      const dt = Math.min(0.05, Math.max(0, (now - last) / 1000));
      last = now;
      s.update(dt);
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
    return s;
  } catch (e) {
    console.warn("[salvage] off:", e);
    return null;
  }
}
