// The item table (docs/ECONOMY.md → Items). The contract's contract/src/items.rs holds the same numbers; the
// contract is the authority and test/items.test.ts checks this copy against its items() view when a contract id is
// configured.
import type { BrokerId, CargoId, GearId, ItemInfo, TokenId } from "./types";

export const ITEMS: Record<TokenId, ItemInfo> = {
  scrip: { id: "scrip", name: "Dock scrip", kind: "currency", weight: 0, base: 1 },
  copper: { id: "copper", name: "Copper coil", kind: "cargo", weight: 1, base: 60, export: 35, target: 12 },
  meds: { id: "meds", name: "Cold-chain meds", kind: "cargo", weight: 1, base: 90, export: 55, target: 8 },
  chips: { id: "chips", name: "Boxed electronics", kind: "cargo", weight: 1, base: 75, export: 45, target: 10 },
  fuel: { id: "fuel", name: "Fuel cells", kind: "cargo", weight: 2, base: 110, export: 70, target: 6 },
  core: { id: "core", name: "Relay core", kind: "cargo", weight: 1, base: 160, export: 100, target: 4 },
  plate: { id: "plate", name: "Armour plate", kind: "gear", weight: 0, base: 80 },
  mag: { id: "mag", name: "Extended mag", kind: "gear", weight: 0, base: 50 },
  cutter: { id: "cutter", name: "Seal cutter", kind: "gear", weight: 0, base: 65 },
};

export const CARGO: CargoId[] = ["copper", "meds", "chips", "fuel", "core"];
export const GEAR: GearId[] = ["plate", "mag", "cutter"];

export const BROKERS: Record<BrokerId, { name: string; buys: CargoId[]; sells: GearId[]; blurb: string }> = {
  moss: { name: "Moss", buys: ["copper", "chips"], sells: ["cutter"], blurb: "Scrap metal. Thinks in tonnes, hates waste." },
  ines: { name: "Ines", buys: ["meds", "fuel"], sells: ["plate"], blurb: "Cold chain and fuel. Cautious, holds cash." },
  qm: { name: "Quartermaster", buys: ["core", "fuel"], sells: ["mag"], blurb: "Buys relay cores for the client. Pays well, spends fast." },
};

/** The run rules both sides enforce (the contract checks them; the game shows them). */
export const RULES = {
  /** Salvage spots in the level; the contract's loot tables index the same spots. */
  spotCount: 16,
  /** Sealed containers in one run's manifest. */
  containersPerRun: 8,
  wrecksPerRun: 3,
  carryLimit: 6,
  /** Move speed scale per unit of carried weight. */
  slowPerWeight: 0.06,
  /** A run must last at least this long, plus perContainerSeconds for each container opened. */
  minRunSeconds: 45,
  perContainerSeconds: 8,
  /** Of a recovered wreck's cargo, the finder keeps this share; the rest goes back to whoever died. */
  finderShare: 0.7,
  starterScrip: 150,
  gear: { plateHealth: 40, magRounds: 15, cutterSpeed: 0.4 },
} as const;

export const carriedWeight = (carried: Partial<Record<CargoId, number>>) =>
  CARGO.reduce((w, id) => w + (carried[id] ?? 0) * ITEMS[id].weight, 0);

export const speedScale = (weight: number) => Math.max(0.5, 1 - RULES.slowPerWeight * weight);
