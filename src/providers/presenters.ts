// Signal presentation registry (task 5.3): how each provider's SignalResult
// is explained inside the popover's "How do we know?" disclosure.
//
// This file is part of the providers layer on purpose (plan.md §8,
// constraint 4): a new provider ships its presenter here, and the popover
// code never changes — a provider without a presenter gets the generic
// fallback below, so the UI degrades honestly instead of breaking.
//
// Presenters must stay pure (no WASM, no network, no chrome.*): they are
// bundled into the content script.

import type { SignalResult } from "../core/types";
import { C2PA_PROVIDER_ID, presentC2paSignal } from "./c2pa/present";

/** One plain-language evidence row. */
export interface SignalFact {
  label: string;
  value: string;
}

/** What the popover shows for one signal: a sentence plus evidence rows. */
export interface SignalPresentation {
  summary: string;
  facts: SignalFact[];
}

// A Map, not an object literal: provider ids index it, and an id that
// collides with an Object.prototype key ("constructor", "toString") must
// miss and fall back generically, not resolve an inherited function.
const presenters = new Map<
  string,
  (signal: SignalResult) => SignalPresentation
>([[C2PA_PROVIDER_ID, presentC2paSignal]]);

/** Generic fallback for providers with no presenter registered. Placeholder
 * wording (Phase 3 brand work), deliberately factual and unadorned. */
function presentGenericSignal(signal: SignalResult): SignalPresentation {
  return {
    summary: `Signal from provider "${signal.providerId}".`,
    facts: [
      { label: "Finding", value: signal.finding },
      { label: "Confidence", value: `${Math.round(signal.confidence * 100)}%` },
    ],
  };
}

export function presentSignal(signal: SignalResult): SignalPresentation {
  const presenter = presenters.get(signal.providerId);
  return presenter ? presenter(signal) : presentGenericSignal(signal);
}
