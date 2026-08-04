// Popover content (task 5.3): builds the detail panel a badge click opens —
// verdict headline, plain-language explanation, and the "How do we know?"
// progressive disclosure (plan.md §4). Pure DOM construction so jsdom tests
// can pin the content; positioning and open/close lifecycle live in
// badge.ts.
//
// Evidence rows come from the providers-layer presenter registry
// (src/providers/presenters.ts), so a new provider needs zero changes here
// (plan.md §8, constraint 4).

import type { WireVerdict } from "../messaging/protocol";
import { presentSignal } from "../providers/presenters";
import {
  POPOVER_STRINGS,
  VERDICT_EXPLANATIONS,
  VERDICT_LABELS,
} from "./labels";

let nextEvidenceId = 0;

function paragraph(className: string, text: string): HTMLParagraphElement {
  const element = document.createElement("p");
  element.className = className;
  element.textContent = text;
  return element;
}

function signalSection(signal: WireVerdict["signals"][number]): HTMLDivElement {
  const { summary, facts } = presentSignal(signal);
  const section = document.createElement("div");
  section.className = "signal";
  section.append(paragraph("summary", summary));

  if (facts.length > 0) {
    const list = document.createElement("dl");
    list.className = "facts";
    for (const fact of facts) {
      const term = document.createElement("dt");
      term.textContent = fact.label;
      const value = document.createElement("dd");
      value.textContent = fact.value;
      list.append(term, value);
    }
    section.append(list);
  }
  return section;
}

/**
 * Builds the popover's inner content for one verdict. The disclosure toggle
 * is self-wired; everything else is static text.
 */
export function buildPopoverContent(verdict: WireVerdict): DocumentFragment {
  const fragment = document.createDocumentFragment();

  fragment.append(
    paragraph("headline", VERDICT_LABELS[verdict.verdict]),
    paragraph("explain", VERDICT_EXPLANATIONS[verdict.verdict]),
  );

  // A verdict that carries provider failures is degraded: it still renders
  // (the signals that did run are real evidence), but the popover must say
  // the check was incomplete rather than present it as a full result.
  if (verdict.failures.length > 0) {
    fragment.append(paragraph("notice", POPOVER_STRINGS.degradedNotice));
  }

  const evidence = document.createElement("div");
  evidence.className = "evidence";
  evidence.id = `trueorigin-evidence-${nextEvidenceId++}`;
  evidence.hidden = true;

  // `signals` is every signal collected — basis signals included, plus
  // below-threshold and conflicting ones — which is exactly what honest
  // disclosure wants to show.
  for (const signal of verdict.signals) {
    evidence.append(signalSection(signal));
  }
  for (const failure of verdict.failures) {
    evidence.append(
      paragraph(
        "failure",
        POPOVER_STRINGS.failureLine(failure.providerId, failure.message),
      ),
    );
  }

  const disclosure = document.createElement("button");
  disclosure.type = "button";
  disclosure.className = "disclosure";
  disclosure.textContent = POPOVER_STRINGS.disclosureLabel;
  disclosure.setAttribute("aria-expanded", "false");
  disclosure.setAttribute("aria-controls", evidence.id);
  disclosure.addEventListener("click", () => {
    const expanded = disclosure.getAttribute("aria-expanded") === "true";
    disclosure.setAttribute("aria-expanded", String(!expanded));
    evidence.hidden = expanded;
  });

  fragment.append(
    disclosure,
    evidence,
    paragraph("privacy", POPOVER_STRINGS.privacyNote),
  );
  return fragment;
}
