// What the raid says. The Harbormaster's billing lines are docs/STORY.md's (story/copy.ts), now literal: each one is
// said because the invoice really moved. The threshold lines below are new to v2 and written in the same voice;
// the Bailiff and the Assessor announce themselves (bailiff/copy.ts, boss/copy.ts).
import { HARBORMASTER, fill } from "../../story/copy";
import { money, type ThresholdId } from "./rules";

/** The big HUD line when a threshold is reached. */
export const THRESHOLD_WARN: Record<ThresholdId, string> = {
  second_notice: "Second notice",
  bailiff: "Final demand",
  second_bailiff: "Second Bailiff",
  foreclosure: "Foreclosure",
};

/** What it brings, in the HUD's feed beside it: `FINAL DEMAND the Bailiff is sent`. */
export const THRESHOLD_NOTE: Record<ThresholdId, string> = {
  second_notice: "more Inspection Units",
  bailiff: "the Bailiff is sent",
  second_bailiff: "a second Bailiff is sent",
  foreclosure: "the Assessor holds the boat",
};

export const LINES = {
  /** At the fence. `{fee}` is what is really on the invoice there. */
  fence: (callsign: string | null, fee: number) => fill(HARBORMASTER.trespass, { callsign: callsign ?? "", fee }) ?? `Good morning, Breacher. Your visit is not authorised. A trespass surcharge of ${fee} scrip has been added to your account.`,
  seal: HARBORMASTER.sealCut,
  uplink: HARBORMASTER.relayCut,
  evidence: (weight: number) => fill(HARBORMASTER.evidence, { weight }),
  unit: (fee: number) => `An Inspection Unit has been written off. Replacement cost, ${fee} scrip, has been added to your account.`,
  secondNotice: (total: number) => `Second notice. Your account stands at ${money(total)} scrip. Additional Inspection Units have been assigned to your case.`,
  secondBailiff: "Your case now requires two officers. Please do not keep them waiting.",
  /** At the boat, with the invoice as it stands. */
  boat: (invoice: number) => fill(HARBORMASTER.invoice, { haul: invoice }),
} as const;

export const SIGN = {
  title: "Over the fence…",
  settling: "Settling the last raid…",
  refused: "Raid not signed",
  unconfirmed: "Not confirmed",
  closed: "The dock office isn't answering. No raid can be signed.",
  /** No dock pass: the raid card's line, and what Control says once the raid is on. */
  passlessCard: "No dock pass on file. The issue rifle, and nothing to carry out.",
  passless: "No dock pass on file, Breacher. This one is off the books: the yard's cargo stays sealed. Sign on at the dock.",
} as const;

/** What the cards say when the contract answers that the raid had lapsed (E_RAID_CLOSED). */
export const LAPSED = {
  warn: (minutes: number) => `The raid's papers lapse in ${minutes} minutes. Make the boat`,
  now: "This raid has lapsed. Nothing you carry will be logged",
  ledger: (minutes: number) => `The raid lapsed after ${minutes} minutes. Nothing was logged.`,
  gun: "Back in your stash. The gear you brought is lost.",
  haul: "Lost: the raid had lapsed",
} as const;
