// The raid: the in-game half of Saltline v2 (docs/GAME.md → The loop, Risk, The invoice).
//
// - Signing on: it owns G.ext.beforeRun. The briefing plays the first time, then the contract locks the loadout
//   (chain.startRaid) behind a short card, and only then does the run start, with the gun the loadout names driving
//   the shooter (G.ext.weapon). A refusal or no confirmation is said plainly and offers one raid off the books.
// - Loot: the manifest's containers are sealed (bonded ones differently, and they take longer), wrecks lie beside
//   them, destroyed machines drop parts. Everything carried slows the player and is refused over the limit.
// - The invoice: everything taken, cut and destroyed goes on a live meter, and its thresholds bring more
//   Inspection Units, the Bailiff, a second Bailiff, and at foreclosure the Assessor, which holds the boat.
// - The end: the boat sends chain.extract with an honest report; a death sends chain.die, `bailiff` when the
//   Bailiff's grab was what killed. The debrief and dead cards say what happened to the gun.
//
// The shooter never depends on any of it: every handler is guarded, and without a signed raid a run is the issue
// rifle and nothing else.
import "../../story/story.css";
import { SPAWN } from "../../bailiff/rules";
import { startAssessor, type Boss } from "../../boss";
import { createBriefing, type Briefing } from "../../story/briefing";
import { defaultStore, loadMemory, saveMemory } from "../../story/memory";
import { createPacer, type Pacer } from "../../story/pacing";
import { createChannel, type TimedChannel } from "../../story/radio";
import { NO_BONUS, waveBonus } from "../../story/waves";
import { WRECK_SLOTS, sealPoint, wreckPoint, type Point } from "../../salvage/place";
import { SALVAGE_SPOTS } from "../../salvage/spots";
import { CONDITION, INVOICE, MATERIALS, RAID } from "../items";
import type { DeathBy, Loadout, Raid, V2, Weapon } from "../types";
import { LINES, SIGN, THRESHOLD_NOTE, THRESHOLD_WARN } from "./copy";
import { createRaidHud, type Marker, type RaidHud, type Row } from "./hud";
import {
  HOLD,
  PART_OF,
  RaidLedger,
  SHORT,
  Thresholds,
  deathBy,
  dropsPart,
  foreclosureCores,
  formatItems,
  gearUsed,
  gunName,
  gunTag,
  money,
  nearestSpot,
  roll,
  shooterSpec,
  thresholdsOf,
  toItems,
  wreckWeight,
  zoneOf,
  type LineItem,
  type MachineType,
  type Threshold,
} from "./rules";
import { signOn, type SignOn } from "./signon";
import { createRaidWorld, type RaidWorld } from "./world";

/* eslint-disable @typescript-eslint/no-explicit-any -- the game context is the untyped bundle's G */
type Game = any;

/** The same reach and facing as the relays (game.js Yi.interactRange, Yi.interactFacing). */
const RANGE = 2.2;
const FACING = 0.45;
const NEAR_MARKERS = 2;
/**
 * Supply lockers in a signed raid, placed from the raid's id. Half the arsenal's default of six: magazines are
 * something a player buys and brings in v2, and each locker is about thirty meshes to draw.
 */
const LOCKERS = 3;
/** A part is taken by walking within this of it (m). */
const PART_REACH = 1.35;
/** The sign-on card stays up at least this long, so it reads as a step and not a flicker (ms). */
const CARD_MS = 900;
/** How long each Harbormaster line may wait for its turn on the radio (ms). */
const WAIT = { fence: 40_000, seal: 14_000, uplink: 16_000, evidence: 14_000, unit: 14_000, notice: 20_000, boat: 25_000 };
/** The view model's furniture per frame (game.js's `pac9_polymer_tan`, the Longshore's tan): the issue rifle is plain black. */
const FINISH: Record<string, number> = { longshore: 0x5a4f3f, stevedore: 0x2b3a42, pilot: 0x3b4630, issue: 0x151515 };

interface Target {
  key: string;
  kind: "seal" | "wreck";
  bonded: boolean;
  spot: number;
  wreckId: number;
  at: Point;
  out: { x: number; z: number };
  what: string;
  weight: number;
  callsign: string;
  slot: number;
}

interface Pending {
  mode: "signed" | "offbooks";
  raid: Raid | null;
  weapon: Weapon | null;
  loadout: Loadout;
  fellBack: boolean;
  /** performance.now() when the contract signed it: the raid's clock starts there, as the contract's does. */
  at: number;
}

interface Live extends Pending {
  token: number;
  ledger: RaidLedger | null;
  thresholds: Thresholds | null;
  /** ?invoice=N (dev and mock only): added at the fence. */
  extra: number;
  total: number;
  ended: "dead" | "extracted" | null;
  targets: Target[];
  hold: { key: string; t: number; refused: boolean; spark: number } | null;
  parts: { id: number; kind: "servo" | "rotor"; at: Point }[];
  killN: number;
  said: Set<string>;
  /** The greeting at the fence while it waits for the radio: the lines after it queue behind it. */
  fence: { text: string; until: number } | null;
  /** Thresholds reached before play began (arrears carried in), fired once the player has control. */
  due: Threshold[];
  grabs: number[];
}

export interface RaidApi {
  /** Signs on now (as DEPLOY does) so the next start, however it is made, plays the signed raid. For tests. */
  prepare(): Promise<SignOn["kind"] | "closed">;
  readonly state: {
    mode: "none" | "signed" | "offbooks";
    raidId: number | null;
    total: number;
    weapon: string;
    opened: number[];
    wrecks: number[];
    parts: { servo: number; rotor: number };
    kills: { gull: number; hound: number };
    weight: number;
    targets: Target[];
    drops: { id: number; kind: string; at: Point }[];
    fired: string[];
    ended: string | null;
  };
  readonly briefing: Briefing;
  update(dt: number): void;
  dispose(): void;
}

export function createRaid(G: Game): RaidApi {
  const ext = (G.ext ??= { speedScale: 1, gear: {} });
  const hud: RaidHud = createRaidHud(G);
  const world: RaidWorld = createRaidWorld(G);
  const now = () => performance.now();
  const warned = new Set<string>();
  function guard<T>(where: string, fn: () => T): T | undefined {
    try {
      return fn();
    } catch (e) {
      if (!warned.has(where)) (warned.add(where), console.warn(`[raid] ${where} failed; the game plays on`, e));
      return undefined;
    }
  }
  const call = (o: any, m: string, ...a: unknown[]) => guard(m, () => (o && typeof o[m] === "function" ? o[m](...a) : undefined));
  const emit = (name: string, e: unknown) => guard(`emit ${name}`, () => G.events?.emit?.(name, e));
  const offs: (() => void)[] = [];
  const on = (name: string, fn: (e: any) => void) => {
    const off = G.events?.on?.(name, (e: any) => guard(name, () => fn(e)));
    if (typeof off === "function") offs.push(off);
  };

  // ---- one radio channel for every voice: the Bailiff and the Assessor pick it up from G.story.channel ----
  const ownChannel: TimedChannel | null = G.story?.channel ? null : createChannel(G);
  const channel: TimedChannel = G.story?.channel ?? ownChannel!;
  if (ownChannel) {
    if (G.bailiff) console.warn("[raid] started after the Bailiff: its lines may be relabelled. Start the raid first (v2/index.ts).");
    G.story = { ...(G.story ?? {}), channel };
  }
  const pacer: Pacer = createPacer({ now, busy: () => channel.busy(), lastHarbormasterEnd: () => channel.lastHarbormasterEnd(), say: (line, seconds) => channel.say(line, seconds) });
  const boss: Boss | null = G.boss ?? startAssessor(G);

  // ---- G.v2: the chain lane's, or in DEV a stand-in when nothing has set it after 2 s ----
  const born = now();
  let faking: Promise<void> | null = null;
  async function v2Ready(): Promise<V2 | null> {
    while (!G.v2 && now() - born < 2000) await new Promise((ok) => setTimeout(ok, 100));
    if (!G.v2 && import.meta.env.DEV) {
      faking ??= import("./fake").then((m) => {
        if (!G.v2) ((G.v2 = m.createFakeV2()), console.info("[raid] dev fake: not the chain"));
      });
      await faking.catch((e) => console.warn("[raid] no dev fake", e));
    }
    return (G.v2 as V2 | undefined) ?? null;
  }
  void v2Ready().then((v2) => v2 && readCallsign(v2));

  let callsign: string | null = null;
  async function readCallsign(v2: V2) {
    try {
      const id = v2.wallet.accountId();
      const p = id ? await v2.chain.profile(id) : null;
      const c = p && typeof p.callsign === "string" ? p.callsign.trim() : "";
      if (c && c.length <= 32) ((callsign = c), (ext.callsign = c)); // game.js fills Control's {callsign} from it
    } catch {
      /* unknown: Control says "Breacher" */
    }
  }

  // ---- what the shooter reads at a run's reset. Until a raid is signed it is the issue rifle and nothing else. ----
  function arm(p: Pending | null) {
    ext.weapon = shooterSpec(p?.weapon ?? null, p?.loadout.mags ?? 0);
    ext.gear = { ...(ext.gear ?? {}), health: p && p.mode === "signed" && p.loadout.plates > 0 ? RAID.plateHealth : 0 };
    patrols(p?.raid ?? null);
  }
  /** The Harbormaster's extra Inspection Units: game.js reads them for the patrol at the reset and for every wave after. */
  function patrols(raid: Raid | null) {
    ext.waveBonus = raid ? waveBonus(raid.harbormaster.bonusDrones) : { ...NO_BONUS };
  }
  ext.gateRetries = true; // game.js asks beforeRun on a retry too
  arm(null);

  // ---- the briefing, once, before the first sign-on ----
  const store = defaultStore();
  const memory = loadMemory(store);
  const host = document.getElementById("ui") ?? document.body;
  const app = document.getElementById("app");
  const briefing = createBriefing({
    host,
    seen: () => memory.briefed,
    markSeen: () => {
      if (!memory.briefed) ((memory.briefed = true), saveMemory(store, memory));
    },
    onToggle: (o) => app?.classList.toggle("st-briefing", o),
    onGesture: (run) =>
      guard("lock", () => {
        const input = G.input;
        if (run && input && input.mode === "lock" && !input.locked && G.game?.state === "title") input.requestLock?.();
      }),
  });

  // ---- signing on ----
  let pending: Pending | null = null;
  let passing = false;
  let signing = false;
  /** The last raid's extract or die, still on its way: the next sign-on waits for it, so it can't be abandoned. */
  let closing: Promise<unknown> | null = null;
  let live: Live | null = null;
  let tokens = 0;

  const offBooks = (): Pending => ({ mode: "offbooks", raid: null, weapon: null, loadout: { weapon: null, plates: 0, charges: 0, mags: 0 }, fellBack: false, at: now() });

  async function sign(): Promise<SignOn | { kind: "closed"; why: string }> {
    hud.signing(closing ? SIGN.settling : SIGN.title, "The Dock Office is writing you into the ledger.");
    const shown = new Promise((ok) => setTimeout(ok, CARD_MS));
    if (closing) await closing.catch(() => {});
    const v2 = await v2Ready();
    if (!v2) return { kind: "closed", why: SIGN.closed };
    const issue = "The issue rifle. Nothing to lose but the cargo.";
    hud.signing(SIGN.title, v2.loadout?.weapon ? `Locking ${v2.loadout.weapon} on the ledger.` : issue);
    void readCallsign(v2);
    const res = await signOn({
      chain: v2.chain,
      wallet: v2.wallet,
      loadout: v2.loadout,
      onGun: (w, fellBack) => hud.signing(SIGN.title, w ? `Locking ${gunTag(w)} on the ledger. It is yours to lose.` : fellBack ? `That gun isn't in your stash. ${issue}` : issue),
    });
    await shown;
    return res;
  }

  function accept(res: Extract<SignOn, { kind: "signed" }>) {
    pending = { mode: "signed", raid: res.raid, weapon: res.weapon, loadout: res.loadout, fellBack: res.fellBack, at: now() };
    arm(pending);
    hud.raidCard(`Raid ${res.raid.raidId} · Saltline Terminal`, `On the invoice at the fence: ${money(res.raid.invoiceStart + devExtra())}`, `Berth 4 · 05:42 · ${gunName(res.weapon)}`);
  }

  function beforeRun(go: () => void): boolean {
    if (passing || pending) return false; // go() re-enters the game's start; a prepared raid starts as it is
    if (signing) return true;
    const start = () => {
      signing = true;
      // The last raid's officers leave before the next one is signed.
      guard("clear", clearYard);
      sign().then(
        (res) =>
          guard("signed", () => {
            if (res.kind === "signed") {
              accept(res);
              launch(go);
              return;
            }
            const title = res.kind === "refused" ? SIGN.refused : res.kind === "unconfirmed" ? SIGN.unconfirmed : SIGN.refused;
            console.info(`[raid] sign-on ${res.kind}: ${res.why}`);
            hud.offer(
              title,
              res.why,
              () => {
                pending = offBooks();
                arm(pending);
                hud.raidCard("Off the books · Saltline Terminal", "No raid signed. The issue rifle, and nothing to carry out.", "Berth 4 · 05:42");
                launch(go);
              },
              () => {
                signing = false;
                hud.signDone();
              },
            );
          }),
        (e) => {
          console.warn("[raid] sign-on failed", e);
          signing = false;
          hud.signDone();
        },
      );
    };
    if (guard("briefing", () => briefing.beforeRun(start, G.game?.state))) return true;
    start();
    return true;
  }
  function launch(go: () => void) {
    signing = false;
    hud.signDone();
    passing = true;
    try {
      go();
    } finally {
      passing = false;
    }
  }
  ext.beforeRun = (go: () => void) => guard("beforeRun", () => beforeRun(go)) ?? false;

  /** ?invoice=N adds N at the fence, so thresholds can be reached quickly. Dev builds and the mock only. */
  function devExtra(): number {
    const mock = (G.v2 as V2 | undefined)?.chain?.network === "mock";
    if (!import.meta.env.DEV && !mock) return 0;
    const n = Number(new URLSearchParams(location.search).get("invoice"));
    return Number.isSafeInteger(n) && n > 0 && n <= 100_000 ? n : 0;
  }

  // ---- a run ----
  function clearYard() {
    call(G.bailiff, "clear");
    call(G.arsenal, "clear");
    call(boss, "dismiss");
  }

  function startRun() {
    const p = pending ?? offBooks();
    pending = null;
    arm(null); // whatever starts next without signing on gets the issue rifle
    patrols(p.raid); // this raid's waves keep the extra units the patrol started with
    world.clear();
    pacer.clear();
    hud.setDead(null);
    hud.setDebrief(null);
    hud.setMarkers([]);
    ext.speedScale = 1;
    const token = ++tokens;
    const signed = p.mode === "signed" && !!p.raid;
    live = {
      ...p,
      token,
      ledger: signed ? new RaidLedger(p.raid!) : null,
      thresholds: signed ? new Thresholds(thresholdsOf(p.raid!.harbormaster)) : null,
      extra: signed ? devExtra() : 0,
      total: 0,
      ended: null,
      targets: [],
      hold: null,
      parts: [],
      killN: 0,
      said: new Set(),
      fence: null,
      due: [],
      grabs: [],
    };
    guard("finish", () => finish(p.weapon));
    if (!signed) {
      if (G.v2) (G.v2 as V2).raid = null;
      hud.setInvoice({ on: false, total: 0, next: null });
      refreshCargo();
      return;
    }
    const r = live;
    const raid = p.raid!;
    (G.v2 as V2).raid = raid;
    r.targets = buildTargets(r.ledger!);
    world.build(raid, new Map(r.targets.filter((t) => t.kind === "wreck").map((t) => [t.wreckId, t.slot])));
    r.total = current(r);
    r.due = r.thresholds!.cross(r.total);
    showInvoice();
    refreshCargo();
    refreshMarkers(true);
    emit("raid:started", raid);
    emit("invoice:changed", { total: r.total, added: r.total, why: "AT THE FENCE", next: r.thresholds!.next() });
    hud.addLine({ added: raid.invoiceStart, why: "TRESPASS · AT THE FENCE" });
    if (r.extra) hud.addLine({ added: r.extra, why: "TEST SURCHARGE · ?INVOICE" });
    const greeting = LINES.fence(callsign, raid.invoiceStart);
    r.fence = { text: greeting, until: now() + WAIT.fence };
    pacer.add(greeting, { seconds: 5, ttl: WAIT.fence });
    // The kit, after every run:start listener (the arsenal sets its own defaults on the same event).
    queueMicrotask(() =>
      guard("kit", () => {
        if (!live || live.token !== token) return;
        call(G.arsenal, "setCharges", p.loadout.charges);
        call(G.arsenal, "placeLockers", raid.raidId, LOCKERS);
      }),
    );
    if (p.fellBack) setTimeout(() => live?.token === token && call(G.hud, "message", "The gun in your loadout isn't in your stash. Issue rifle this raid.", 5), 4200);
  }

  /** The view model's furniture takes the frame's finish (cheap: one material's colour). */
  function finish(w: Weapon | null) {
    const root = G.weapon?.root;
    const hex = FINISH[w?.frame ?? "issue"];
    if (!root || typeof root.traverse !== "function" || hex === undefined) return;
    root.traverse((o: any) => {
      if (o.material && o.material.name === "pac9_polymer_tan" && o.material.color?.setHex) o.material.color.setHex(hex);
    });
  }

  function buildTargets(ledger: RaidLedger): Target[] {
    const out: Target[] = [];
    for (const c of ledger.sealed()) {
      const s = SALVAGE_SPOTS[c.spot];
      out.push({ key: "s" + c.spot, kind: "seal", bonded: c.bonded, spot: c.spot, wreckId: -1, at: sealPoint(s), out: { x: Math.cos(s.yaw), z: -Math.sin(s.yaw) }, what: `${SHORT[c.tokenId]} ×${c.amount}`, weight: MATERIALS[c.tokenId].weight * c.amount, callsign: "", slot: -1 });
    }
    const used = new Set<string>();
    for (const w of ledger.standing()) {
      const s = SALVAGE_SPOTS[w.spot];
      let slot = WRECK_SLOTS.findIndex((_, i) => !used.has(w.spot + ":" + i) && clearFloor(wreckPoint(s, i)));
      if (slot < 0) slot = WRECK_SLOTS.findIndex((_, i) => !used.has(w.spot + ":" + i));
      used.add(w.spot + ":" + slot);
      const p = wreckPoint(s, slot);
      const what = [w.weapon ? `${gunName(w.weapon)}` : "", formatItems(w.items)].filter(Boolean).join(" · ") || "Empty";
      out.push({ key: "w" + w.id, kind: "wreck", bonded: false, spot: w.spot, wreckId: w.id, at: { x: p.x, y: 0.55, z: p.z }, out: { x: Math.cos(s.yaw), z: -Math.sin(s.yaw) }, what, weight: wreckWeight(w), callsign: w.callsign, slot });
    }
    return out;
  }
  const clearFloor = (p: Point) => {
    const nav = G.physics && G.physics.nav;
    if (!nav || typeof nav.isWalkable !== "function") return true;
    return guard("nav", () => [[0, 0], [0.6, 0.6], [0.6, -0.6], [-0.6, 0.6], [-0.6, -0.6]].every(([dx, dz]) => nav.isWalkable(p.x + dx, p.z + dz))) ?? true;
  };

  // ---- the invoice ----
  /** Seconds since the contract signed the raid: the intro and any pause included, as on its clock. */
  const elapsed = (r: Live) => (now() - r.at) / 1000;
  const current = (r: Live) => r.ledger!.invoice(elapsed(r)) + r.extra;
  function showInvoice() {
    const r = live;
    const on = !!r && r.mode === "signed" && !r.ended && !!r.thresholds;
    hud.setInvoice({ on, total: r?.total ?? 0, next: on ? r!.thresholds!.next() : null });
  }

  /** Line items for what was just done: each is listed, announced as an event, and may reach a threshold. */
  function bill(items: (LineItem | null)[]) {
    const r = live;
    if (!r || !r.ledger || r.ended) return;
    const list = items.filter((i): i is LineItem => !!i && i.added > 0);
    const total = current(r);
    let running = total - list.reduce((a, i) => a + i.added, 0);
    for (const item of list) {
      running += item.added;
      hud.addLine(item);
      crossed(r, running);
      emit("invoice:changed", { total: running, added: item.added, why: item.why, next: r.thresholds!.next() });
    }
    r.total = total;
    showInvoice();
  }

  function crossed(r: Live, total: number) {
    for (const t of r.thresholds!.cross(total)) {
      if (G.game?.state === "playing") fire(r, t);
      else r.due.push(t);
    }
  }

  let warnAt = 0;
  function fire(r: Live, t: Threshold) {
    emit("invoice:threshold", { at: t.at, what: t.id });
    // Announcements a few seconds apart, so two reached at once are both read.
    const wait = Math.max(0, warnAt - now());
    warnAt = now() + wait + 3600;
    setTimeout(() => {
      if (!live || live.token !== r.token || live.ended) return;
      hud.flag(THRESHOLD_WARN[t.id]);
      call(G.hud, "warn", THRESHOLD_WARN[t.id], 3.2);
      call(G.hud, "feed", `<b>${THRESHOLD_WARN[t.id]}</b> ${THRESHOLD_NOTE[t.id]}`); // the feed, clear of the radio's subtitles
      call(G.audio, "play", "alert", { pitch: 0.8, gain: 0.8 });
    }, wait);
    const p = G.player?.pos;
    const far = (list: readonly { x: number; z: number }[]) => [...list].sort((a, b) => (p ? Math.hypot(b.x - p.x, b.z - p.z) - Math.hypot(a.x - p.x, a.z - p.z) : 0));
    if (t.id === "second_notice") {
      bills(r, LINES.secondNotice(current(r)), WAIT.notice, 5);
      guard("units", () => {
        // Two more Inspection Units, from the far side of the yard.
        const at = far([SPAWN.shed, SPAWN.yard, ...SPAWN.shedAlt])[0];
        const V = G.THREE?.Vector3;
        const vec = (x: number, y: number, z: number) => (V ? new V(x, y, z) : { x, y, z });
        G.enemies?.spawn?.("gull", vec(at.x, 8, at.z), { state: "alert", target: p ?? undefined });
        G.enemies?.spawn?.("hound", vec(at.x + 1.5, 0, at.z + 1), { state: "alert", target: p ?? undefined });
        if (p) G.enemies?.alert?.(p, 60);
      });
    } else if (t.id === "bailiff" || t.id === "second_bailiff") {
      if (t.id === "second_bailiff") bills(r, LINES.secondBailiff, WAIT.notice, 4.4);
      guard("bailiff", () => {
        // The first rises in the shed, the second in the yard; either moves if the player is standing there.
        const home = t.id === "bailiff" ? SPAWN.shed : SPAWN.yard;
        const near = !!p && Math.hypot(home.x - p.x, home.z - p.z) < 14;
        const at = near ? far(t.id === "bailiff" ? [SPAWN.yard, ...SPAWN.shedAlt] : [SPAWN.shed, ...SPAWN.shedAlt])[0] : home;
        G.bailiff?.spawn?.({ at: { x: at.x, z: at.z } });
      });
    } else if (t.id === "foreclosure") {
      guard("assessor", () => boss?.summon(foreclosureCores(r.raid!.harbormaster.strength)));
    }
  }

  // ---- interaction: G.ext.interact, called by the relay loop when no relay holds the prompt ----
  let interactedAt = -1;
  function target(r: Live): Target | null {
    const p = G.player;
    if (!p || !p.pos) return null;
    const f = p.forward || { x: 0, z: -1 };
    const fl = Math.max(0.2, Math.hypot(f.x, f.z));
    let best: Target | null = null,
      bestD: number = RANGE;
    for (const t of r.targets) {
      const dx = t.at.x - p.pos.x,
        dz = t.at.z - p.pos.z,
        d = Math.hypot(dx, dz);
      if (d > bestD || Math.abs(t.at.y - (p.pos.y || 0)) > 2.5) continue;
      if (d > 0.9 && (dx * f.x + dz * f.z) / (d * fl) < FACING) continue;
      if (t.kind === "seal" && -dx * t.out.x - dz * t.out.z < 0.15) continue; // never through the container
      best = t;
      bestD = d;
    }
    return best;
  }
  const release = () => {
    if (live) live.hold = null;
    return false;
  };
  function interact(dt: number): boolean {
    interactedAt = now();
    return (
      guard("interact", () => {
        const r = live;
        if (!r || !r.ledger || r.ended || !G.player?.alive) return release();
        const t = target(r);
        if (!t) return release();
        if (!r.hold || r.hold.key !== t.key) r.hold = { key: t.key, t: 0, refused: false, spark: 0 };
        const h = r.hold;
        const held = !!call(G.input, "down", "interact");
        const verb = t.kind === "seal" ? (t.bonded ? "Cut bonded seal" : "Cut seal") : `Recover wreck · ${t.callsign}`;
        if (held && !r.ledger.fits(t.weight)) {
          if (!h.refused) {
            h.refused = true;
            call(G.hud, "message", `Load limit ${RAID.carryLimit}. You carry ${r.ledger.weight()}.`, 2.6);
          }
          h.t = 0;
          call(G.hud, "setPrompt", `Too heavy · ${t.what}`, 0);
          return true;
        }
        if (!held) h.refused = false;
        if (held) {
          h.t += dt / (t.kind === "wreck" ? HOLD.wreck : t.bonded ? HOLD.bonded : HOLD.seal);
          h.spark -= dt;
          if (h.spark <= 0) ((h.spark = 0.07), world.working(t.at, t.out.x, t.out.z));
          if (h.t >= 1) {
            take(r, t);
            r.hold = null;
            call(G.hud, "setPrompt", null);
            return true;
          }
        } else h.t = Math.max(0, h.t - dt * 1.6);
        call(G.hud, "setPrompt", `${verb} · ${t.what}`, Math.min(1, h.t));
        return true;
      }) ?? false
    );
  }

  function take(r: Live, t: Target) {
    const before = r.ledger!.weight();
    const res = t.kind === "seal" ? r.ledger!.cut(t.spot) : r.ledger!.recover(t.wreckId);
    if (!res.ok) return;
    r.targets = r.targets.filter((e) => e !== t);
    carrying(r, before);
    if (t.kind === "seal") {
      world.cutSeal(t.spot);
      call(G.hud, "feed", `<b>${t.what}</b> taken`);
      once(r, "seal", () => bills(r, LINES.seal, WAIT.seal));
    } else {
      world.recoverWreck(t.wreckId);
      call(G.hud, "feed", `<b>Wreck</b> recovered · ${t.what}`);
    }
    bill(res.items);
    guard("fx", () => {
      const V = G.THREE && G.THREE.Vector3;
      if (V && G.fx?.sparks) G.fx.sparks(new V(t.at.x, t.at.y, t.at.z), new V(t.out.x, 0.7, t.out.z).normalize(), 16);
    });
    call(G.audio, "play", "relay_cut", { pos: { x: t.at.x, y: t.at.y, z: t.at.z }, gain: 0.7, pitch: t.kind === "seal" ? 1.15 : 0.9 });
    refreshMarkers(true);
    refreshCargo();
  }
  const once = (r: Live, id: string, fn: () => void) => {
    if (!r.said.has(id)) (r.said.add(id), fn());
  };
  /** The load changed: the pace follows it, and the Harbormaster counts the evidence past 4 weight. */
  function carrying(r: Live, before: number) {
    const w = r.ledger!.weight();
    ext.speedScale = r.ledger!.speed();
    if (w > 4 && before <= 4) once(r, "evidence", () => bills(r, LINES.evidence(w), WAIT.evidence));
  }
  /**
   * A billing line takes its turn on the Harbormaster's channel (pacing.ts says the nearest deadline first). The
   * greeting at the fence is said first: while it is still waiting, a line that would beat it queues behind it.
   */
  function bills(r: Live, text: string | null, ttl: number, seconds?: number) {
    if (!text) return;
    if (r.fence && now() > r.fence.until) r.fence = null;
    pacer.add(text, { seconds, ttl: Math.max(ttl, r.fence ? r.fence.until - now() + 500 : 0) });
  }

  // ---- machines: each one destroyed is billed, and may drop its part ----
  function onKill(e: { type?: string; pos?: Point }) {
    const r = live;
    if (!r || !r.ledger || r.ended || G.game?.state !== "playing") return;
    const type = e?.type === "hound" ? "hound" : e?.type === "gull" ? "gull" : null;
    if (!type) return;
    const item = r.ledger.kill(type as MachineType);
    const n = r.killN++;
    if (!item) return;
    bill([item]);
    if (type === "hound") once(r, "unit", () => bills(r, LINES.unit(INVOICE.hound), WAIT.unit));
    if (e.pos && dropsPart(r.raid!.raidId, n, type as MachineType)) {
      const kind = PART_OF[type as MachineType].part;
      const land = landing(e.pos, roll(r.raid!.raidId, n + 4096) * 6.283);
      if (!land) return; // nowhere a player could reach: it went into the harbour
      const at = { x: land.x, y: land.y + 0.45, z: land.z };
      r.parts.push({ id: n, kind, at });
      world.addPart(n, kind, at);
    }
  }
  /** Open ground near where a machine fell: on the nav grid and not a container's roof (a gull dies in the air). */
  function landing(pos: Point, a0: number): Point | null {
    const nav = G.physics?.nav;
    for (const rad of [1.2, 1.9, 2.8, 4, 5.5])
      for (let k = 0; k < 8; k++) {
        const x = pos.x + Math.cos(a0 + (k * 6.283) / 8) * rad,
          z = pos.z + Math.sin(a0 + (k * 6.283) / 8) * rad;
        if (nav && typeof nav.isWalkable === "function" && !nav.isWalkable(x, z)) continue;
        const y = guard("ground", () => G.physics?.groundHeight?.(x, z, 1)) ?? 0;
        if (!Number.isFinite(y) || y > 0.5) continue;
        return { x, y, z };
      }
    return null;
  }
  function pickParts(r: Live) {
    const p = G.player;
    if (!r.parts.length || !p?.pos || !p.alive) return;
    for (const part of [...r.parts]) {
      if (Math.hypot(part.at.x - p.pos.x, part.at.z - p.pos.z) > PART_REACH || Math.abs(part.at.y - p.pos.y) > 2.2) continue;
      const before = r.ledger!.weight();
      const res = r.ledger!.takePart(part.kind);
      if (!res.ok) continue; // no room: it stays on the ground
      r.parts = r.parts.filter((x) => x !== part);
      world.removePart(part.id);
      carrying(r, before);
      call(G.hud, "feed", `<b>${SHORT[part.kind]}</b> taken`);
      call(G.audio, "play", "ui_click", { gain: 0.8, pitch: 1.3 });
      bill(res.items);
      refreshCargo();
    }
  }

  // ---- the end ----
  function used(r: Live) {
    const w = G.weapon;
    const rounds = w && typeof w.ammo === "number" && typeof w.reserve === "number" ? w.ammo + w.reserve : null;
    const left = guard("charges", () => (typeof G.arsenal?.charges === "function" ? Number(G.arsenal.charges()) : null)) ?? null;
    return gearUsed(r.loadout, shooterSpec(r.weapon, r.loadout.mags).mag, { chargesLeft: Number.isFinite(left as number) ? left : null, roundsLeft: rounds });
  }
  function close(r: Live, how: "dead" | "extracted") {
    r.ended = how;
    r.hold = null;
    ext.speedScale = 1;
    patrols(null);
    hud.setMarkers([]);
    pacer.clear();
    showInvoice();
    refreshCargo();
    if (G.v2) (G.v2 as V2).raid = null;
  }
  const settle = <T>(fn: () => Promise<T>): Promise<T> => {
    try {
      return Promise.resolve(fn());
    } catch (e) {
      return Promise.reject(e);
    }
  };
  const txRow = (v2: V2, hash: string | undefined): Row =>
    hash ? { k: "Ledger", v: hash.length > 14 ? `${hash.slice(0, 6)}…${hash.slice(-4)}` : hash, href: v2.chain.txUrl(hash), state: "ok" } : { k: "Ledger", v: "recorded", state: "ok" };

  function onExtract() {
    const r = live;
    if (!r || r.ended) return;
    const signed = r.mode === "signed" && !!r.ledger;
    const seconds = elapsed(r);
    const total = signed ? current(r) : 0;
    close(r, "extracted");
    guard("clear", clearYard);
    if (!signed) {
      hud.setDebrief([{ k: "Raid", v: "Off the books. Nothing on the ledger.", state: "pending" }]);
      return;
    }
    const v2 = G.v2 as V2;
    const ledger = r.ledger!;
    const raid = r.raid!;
    const report = ledger.report(seconds, used(r));
    const haul = toItems(ledger.carried).map((it) => `${SHORT[it.tokenId as keyof typeof SHORT]} ×${it.amount}`);
    const gunRow = (w: Weapon | null, pendingText: string): Row =>
      r.weapon ? { k: "Your gun", v: w ? `${gunTag(w)} · ${w.grade} · condition ${w.condition}` : pendingText } : { k: "Your gun", v: "Issue rifle. Nothing to wear." };
    const rows = (o: { haul: string[]; gun: Row; guns: string[]; invoice: string; arrears: string; ledger: Row; state?: Row["state"] }): Row[] => [
      { k: "Haul", v: o.haul.length ? o.haul : ["Nothing taken"], state: o.state },
      o.gun,
      { k: "Guns recovered", v: o.guns.length ? o.guns : ["None"], state: o.state },
      { k: "Invoice", v: o.invoice, state: o.state },
      { k: "Arrears now", v: o.arrears, state: o.state },
      o.ledger,
    ];
    const recovered = ledger.guns.map((g) => `${gunTag(g)} · ${g.grade}`);
    const wearing = r.weapon ? `${gunTag(r.weapon)} · wear −${CONDITION.perRaid}, settling…` : "";
    hud.setDebrief(rows({ haul, gun: gunRow(null, wearing), guns: recovered, invoice: `${money(total)} · settling…`, arrears: "settling…", ledger: { k: "Ledger", v: "settling…", state: "pending" }, state: "pending" }));
    pacer.add(LINES.boat(total), { seconds: 5, ttl: WAIT.boat });
    // The contract won't take an extraction younger than 45 s plus 8 s a container: wait it out, never send early.
    const wait = Math.max(0, (RAID.minSeconds + RAID.perContainerSeconds * report.opened.length + 2 - seconds) * 1000);
    const sent = new Promise((ok) => setTimeout(ok, wait)).then(() => settle(() => v2.chain.extract(raid.raidId, report)));
    closing = sent.then(
      (res) => {
        if (res.ok) {
          const minted = Object.entries(res.minted ?? {})
            .filter(([, n]) => (n ?? 0) > 0)
            .map(([id, n]) => `${(SHORT as Record<string, string>)[id] ?? id.toUpperCase()} ×${n}`);
          emit("raid:extracted", { ok: true, invoice: res.invoice ?? null, arrears: res.arrears ?? null });
          emit("stash:changed", {});
          if (live?.token !== r.token) return;
          hud.setDebrief(
            rows({
              haul: res.minted ? minted : haul,
              gun: gunRow(res.weapon ?? null, r.weapon ? `${gunTag(r.weapon)} · returned` : ""),
              guns: res.recovered ? res.recovered.map((g) => `${gunTag(g)} · ${g.grade} · condition ${g.condition}`) : recovered,
              invoice: res.invoice == null ? "unknown" : `${money(res.invoice)} scrip`,
              arrears: res.arrears == null ? "unknown" : `${money(res.arrears)} scrip`,
              ledger: txRow(v2, res.txHash),
            }),
          );
          return;
        }
        // Sent but not confirmed is pending, never failed: the haul may have minted.
        const state: Row["state"] = res.pending ? "pending" : "refused";
        emit("raid:extracted", { ok: false, invoice: null, arrears: null });
        if (live?.token !== r.token) return;
        hud.setDebrief(rows({ haul, gun: gunRow(null, res.pending ? "unconfirmed" : "held by the contract"), guns: recovered, invoice: "unknown", arrears: "unknown", ledger: { k: "Ledger", v: res.pending ? "Unconfirmed. Check the dock." : `Refused: ${res.error || "no reason given"}`, state }, state }));
      },
      () => {
        emit("raid:extracted", { ok: false, invoice: null, arrears: null });
        if (live?.token !== r.token) return;
        hud.setDebrief(rows({ haul, gun: gunRow(null, "unconfirmed"), guns: recovered, invoice: "unknown", arrears: "unknown", ledger: { k: "Ledger", v: "Unconfirmed. Check the dock.", state: "pending" }, state: "pending" }));
      },
    );
  }

  function onDeath() {
    const r = live;
    if (!r || r.ended) return;
    const diedAt = now();
    const seconds = elapsed(r);
    const pos = { x: G.player?.pos?.x ?? 0, z: G.player?.pos?.z ?? 0 };
    const signed = r.mode === "signed" && !!r.ledger;
    const report = signed ? r.ledger!.report(seconds, used(r)) : null;
    close(r, "dead");
    if (!signed || !report) {
      hud.setDead([{ k: "Your gun", v: "Issue rifle. Off the books. Nothing lost." }]);
      return;
    }
    // The clamp's damage, the death and the Bailiff's own event land in one call: read the grabs after it unwinds.
    queueMicrotask(() =>
      guard("die", () => {
        const v2 = G.v2 as V2;
        const by: DeathBy = deathBy(diedAt, r.grabs);
        const spot = nearestSpot(pos.x, pos.z);
        const carried = r.ledger!.weight() > 0;
        const fate = !r.weapon
          ? carried
            ? "Nothing lost but the cargo"
            : "Nothing lost"
          : by === "bailiff"
            ? `IMPOUNDED · ${gunTag(r.weapon)} · buy it back at the dock within ${RAID.impoundHours} hours`
            : `LEFT IN A WRECK ${zoneOf(spot)} · someone may carry it out`;
        const rows = (state: Row["state"], invoice: string, arrears: string, ledger: Row): Row[] => [{ k: "Your gun", v: fate, state: state === "refused" ? "refused" : undefined }, { k: "Invoice", v: invoice, state }, { k: "Arrears now", v: arrears, state }, ledger];
        hud.setDead(rows("pending", "settling…", "settling…", { k: "Ledger", v: "logging…", state: "pending" }));
        closing = settle(() => v2.chain.die(r.raid!.raidId, report, spot, by)).then(
          (res) => {
            emit("raid:died", { by, impounded: res.ok ? (res.impounded ?? null) : null });
            if (res.ok) emit("stash:changed", {});
            if (live?.token !== r.token) return;
            if (res.ok) hud.setDead(rows("ok", res.invoice == null ? "unknown" : `${money(res.invoice)} scrip`, res.arrears == null ? "unknown" : `${money(res.arrears)} scrip`, txRow(v2, res.txHash)));
            else hud.setDead(rows(res.pending ? "pending" : "refused", "unknown", "unknown", { k: "Ledger", v: res.pending ? "Unconfirmed. Check the dock." : `Not logged: ${res.error || "refused"}`, state: res.pending ? "pending" : "refused" }));
          },
          () => {
            emit("raid:died", { by, impounded: null });
            if (live?.token === r.token) hud.setDead(rows("pending", "unknown", "unknown", { k: "Ledger", v: "Unconfirmed. Check the dock.", state: "pending" }));
          },
        );
      }),
    );
  }

  // ---- HUD ----
  function refreshCargo() {
    const r = live;
    const on = !!r && !!r.ledger && !r.ended;
    hud.setCargo({
      mode: on ? "live" : "off",
      items: on ? formatItems(toItems(r!.ledger!.carried)) : "",
      weight: on ? r!.ledger!.weight() : 0,
      pace: on ? r!.ledger!.speed() : 1,
      sealed: on ? r!.targets.filter((t) => t.kind === "seal").length : 0,
      wrecks: on ? r!.targets.filter((t) => t.kind === "wreck").length : 0,
      guns: on ? r!.ledger!.guns.length : 0,
    });
  }
  let markT = 0;
  function refreshMarkers(force = false) {
    const r = live;
    if (!r || r.ended || !r.ledger) return;
    if (force) markT = 0.5;
    const p = G.player?.pos;
    const by = (t: Target) => (p ? Math.hypot(t.at.x - p.x, t.at.z - p.z) : 0);
    const near = new Set([...r.targets].sort((a, b) => by(a) - by(b)).slice(0, NEAR_MARKERS));
    const list: Marker[] = r.targets.map((t) => ({
      id: t.key + (near.has(t) ? "" : "~"),
      short: t.kind === "seal" ? (t.bonded ? "BOND" : t.what.split(" ")[0]) : "WRECK",
      label: t.kind === "seal" ? `${t.bonded ? "Bonded" : "Sealed"} · ${t.what}` : `Wreck · ${t.callsign}`,
      pos: { x: t.at.x, y: t.kind === "seal" ? 1 : 0, z: t.at.z },
      kind: (t.kind === "seal" ? (t.bonded ? "cargo bonded" : "cargo") : "wreck") + (near.has(t) ? "" : " far"),
    }));
    hud.setMarkers(list);
  }

  on("run:start", startRun);
  on("player:dead", onDeath);
  on("extraction:reached", onExtract);
  on("enemy:killed", onKill);
  on("objective:done", () => {
    const r = live;
    if (!r || !r.ledger || r.ended) return;
    bill([r.ledger.cutUplink()]);
    once(r, "uplink", () => bills(r, LINES.uplink, WAIT.uplink));
  });
  on("radio:line", (e: { text?: string }) => {
    if (live?.fence && e?.text === live.fence.text) live.fence = null; // the greeting is out: nothing queues behind it now
  });
  on("bailiff:grab", () => live?.grabs.push(now()));
  on("game:state", (e: { state?: string }) => {
    if (e?.state !== "title") return;
    // Back to the title: whatever raid was in play is over, and nothing of it carries into the next start.
    if (live && !live.ended) close(live, "dead");
    world.clear();
    hud.setInvoice({ on: false, total: 0, next: null });
    guard("clear", clearYard);
  });
  ext.interact = interact;
  // Attached mid-run (an ?autostart run starts before the economy loads): that run was never signed.
  const st = G.game?.state;
  if (st === "intro" || st === "playing" || st === "paused") guard("late start", startRun);

  let cargoT = 0;
  const api: RaidApi = {
    async prepare() {
      if (pending) return pending.mode === "signed" ? "signed" : "refused";
      guard("clear", clearYard);
      const res = await sign();
      hud.signDone();
      if (res.kind === "signed") accept(res);
      return res.kind;
    },
    get state() {
      const r = live;
      return {
        mode: r ? r.mode : ("none" as const),
        raidId: r?.raid?.raidId ?? null,
        total: r?.total ?? 0,
        weapon: ext.weapon?.name ?? "",
        opened: r?.ledger ? [...r.ledger.opened] : [],
        wrecks: r?.ledger ? [...r.ledger.wrecks] : [],
        parts: r?.ledger ? { ...r.ledger.parts } : { servo: 0, rotor: 0 },
        kills: r?.ledger ? { ...r.ledger.kills } : { gull: 0, hound: 0 },
        weight: r?.ledger ? r.ledger.weight() : 0,
        targets: r ? r.targets : [],
        drops: r ? r.parts : [],
        fired: r?.thresholds ? r.thresholds.list.filter((t) => r.thresholds!.has(t.id)).map((t) => t.id) : [],
        ended: r?.ended ?? null,
      };
    },
    briefing,
    update(dt: number) {
      const state = G.game?.state;
      guard("update", () => {
        if (state !== "paused") world.update(dt);
        // The Harbormaster's turn on the radio: in play, and over the debrief for its line about the boat.
        if (state === "playing" || state === "complete") pacer.tick();
        const r = live;
        if (!r || r.ended || !r.ledger) return;
        if (state === "playing") {
          if (r.due.length) for (const t of r.due.splice(0)) fire(r, t);
          pickParts(r);
        }
        // The relay loop stopped calling us (a relay took the slot, or the raid ended): let go of the seal.
        if (r.hold && now() - interactedAt > 150) r.hold = null;
        const total = current(r);
        if (total !== r.total) {
          const added = total - r.total;
          r.total = total;
          crossed(r, total);
          emit("invoice:changed", { total, added, why: "TIME ON SITE", next: r.thresholds!.next() });
          showInvoice();
        }
        if ((markT -= dt) <= 0) ((markT = 0.5), refreshMarkers());
        if ((cargoT -= dt) <= 0) ((cargoT = 0.25), refreshCargo());
      });
    },
    dispose() {
      for (const off of offs) off();
      if (ext.interact === interact) delete ext.interact;
      delete ext.beforeRun;
      delete ext.weapon;
      delete ext.gateRetries;
      ext.speedScale = 1;
      ext.gear = {};
      ext.waveBonus = { ...NO_BONUS };
      world.clear();
      hud.dispose();
      briefing.dispose();
      ownChannel?.dispose();
    },
  };
  return api;
}

/** Starts the raid beside a booted game (v2/index.ts) and drives it on animation frames. */
export function startRaid(G: Game): RaidApi | null {
  try {
    const r = createRaid(G);
    G.raid = r;
    let last = performance.now();
    const loop = (t: number) => {
      const dt = Math.min(0.05, Math.max(0, (t - last) / 1000));
      last = t;
      r.update(dt);
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
    return r;
  } catch (e) {
    console.warn("[raid] off:", e);
    return null;
  }
}
