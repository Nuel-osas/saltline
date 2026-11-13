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
} as const;
