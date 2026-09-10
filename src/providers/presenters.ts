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
import {
  C2PA_DISPLAY_NAME,
  C2PA_PROVIDER_ID,
  presentC2paSignal,
} from "./c2pa/present";

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

/** One provider's presentation contract. `name` is how the popover refers
 * to the check wherever a provider must be named to the reader (the
 * failure line) — plain language in the disclosure register, never the
 * wire id. A provider without an entry is named by its raw id, which is
 * honest but unpolished: the registry entry is the fix, and it lives here
 * (constraint 4). */
export interface SignalPresenter {
  name: string;
  // Property syntax, not method shorthand: TypeScript checks method
  // parameters bivariantly even under strictFunctionTypes, which would let
  // a presenter typed for a narrower signal register and then read
  // undefined detail fields at runtime.
  present: (signal: SignalResult) => SignalPresentation;
}

// A Map, not an object literal: provider ids index it, and an id that
// collides with an Object.prototype key ("constructor", "toString") must
// miss and fall back generically, not resolve an inherited function.
const presenters = new Map<string, SignalPresenter>([
  [C2PA_PROVIDER_ID, { name: C2PA_DISPLAY_NAME, present: presentC2paSignal }],
]);

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

/** Whether a provider ships a presenter entry. Exists for the registry
 * test that ties activeProviders to this Map — a provider without one
 * degrades to the generic fallbacks below, honestly but visibly. */
export function hasPresenter(providerId: string): boolean {
  return presenters.has(providerId);
}

export function presentSignal(signal: SignalResult): SignalPresentation {
  const presenter = presenters.get(signal.providerId);
  return presenter ? presenter.present(signal) : presentGenericSignal(signal);
}

/** The reader-facing name of a provider's check, for popover lines that
 * must name one (failure lines). Falls back to the raw id for providers
 * without a presenter — the same generic honesty as presentGenericSignal.
 * `||`, not `??`: a registered entry with a blank name is a bug, and it
 * must degrade to the same raw-id fallback rather than render
 * `The "" check failed`. */
export function providerDisplayName(providerId: string): string {
  return presenters.get(providerId)?.name || providerId;
}
