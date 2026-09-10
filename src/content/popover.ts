// Popover content (task 5.3): builds the detail panel a badge click opens —
// verdict headline, plain-language explanation, and the "How do we know?"
// progressive disclosure (plan.md §4). Pure DOM construction so jsdom tests
// can pin the content; positioning and open/close lifecycle live in
// badge.ts.
//
// Evidence rows come from the providers-layer presenter registry
// (src/providers/presenters.ts), so a new provider needs zero changes here
// (plan.md §8, constraint 4).

import { verdictClassForSignal } from "../core/verdict";
import type { WireVerdict } from "../messaging/protocol";
import { presentSignal, providerDisplayName } from "../providers/presenters";
import { activeElementIn } from "./focus";
import {
  POPOVER_STRINGS,
  VERDICT_EXPLANATIONS,
  VERDICT_LABELS,
} from "./labels";
import { buildRing, ringStateForVerdict } from "./ring";

let nextEvidenceId = 0;

/** Keeps the evidence region keyboard-reachable exactly when it scrolls.
 *
 * The region is the panel's primary scroll container (badge.ts flex
 * column), but its content is static text with no focusable descendants,
 * so nothing inside it can ever hold focus — and keyboard scrolling
 * targets the focused element's nearest scroller. With focus resting on
 * the disclosure button, outside the region, arrow keys scroll the panel,
 * which has no overflow of its own once the region absorbed the excess:
 * rows past the region's scroll edge were unreachable without a pointer
 * (5.3 deferred finding). A tab stop is the fix, but only while there is
 * something to scroll — an always-present stop would land keyboard
 * users on a non-scrolling region (a focus ring with no purpose) on the
 * common short Unknown disclosure. Overflow is re-read on expand (the
 * synchronous read is the layout the un-hide already needs), and tracked
 * by a ResizeObserver while expanded, since the panel's viewport-relative
 * height cap (70vh) can change the answer under a window resize. A
 * region that currently holds focus keeps its stop even when overflow
 * disappears: dropping focusability under the reader's focus would eject
 * focus to the document. The stop leaves with the reader instead —
 * focusout re-runs the check.
 *
 * Returns the open/closed switch the disclosure drives. */
function trackScrollFocusability(
  evidence: HTMLDivElement,
): (open: boolean) => void {
  const update = (): void => {
    if (!evidence.isConnected) {
      // Teardown. badge.ts removes the panel (light dismiss, verdict
      // rebuild, removeAllBadges) with no hook into this module; the
      // observer's next delivery — a 0×0 box for the detached region — is
      // the signal to let go.
      observer.disconnect();
      return;
    }
    if (evidence.scrollHeight > evidence.clientHeight) {
      evidence.tabIndex = 0;
      return;
    }
    if (activeElementIn(evidence) !== evidence) {
      evidence.removeAttribute("tabindex");
    }
  };
  const observer = new ResizeObserver(update);
  // Both Blink and jsdom clear the active element before dispatching
  // focusout, so the focus guard above sees the region as unfocused here.
  evidence.addEventListener("focusout", update);
  return (open) => {
    if (open) {
      update();
      observer.observe(evidence);
    } else {
      observer.disconnect();
      evidence.removeAttribute("tabindex");
    }
  };
}

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
  // Each signal is its own ring — the aggregation architecture drawn as
  // geometry; a future provider arrives as one more ring, no new grammar.
  // The ring's class comes from core's verdictClassForSignal, so it can
  // never claim more than mapVerdict would grant the same signal — a
  // below-threshold probabilistic signal draws the unknown trace, not
  // the near-closed "Likely AI" band.
  section.append(
    buildRing(ringStateForVerdict(verdictClassForSignal(signal)), "ring"),
    paragraph("summary", summary),
  );

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

  // Headline row: the verdict's ring at reading size beside its name; the
  // arc re-sweeps to its honest band each time the panel opens. The name
  // is a real heading — the one stop screen-reader heading navigation
  // finds inside the dialog (the dialog's aria-label carries the fuller
  // "<verdict> — details"; this is structure, not the accessible name).
  const headline = document.createElement("h2");
  headline.className = "headline";
  headline.textContent = VERDICT_LABELS[verdict.verdict];
  const header = document.createElement("div");
  header.className = "verdict";
  header.append(
    buildRing(ringStateForVerdict(verdict.verdict), "ring"),
    headline,
  );
  fragment.append(
    header,
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
  // Failures name their check by the presenters-layer display name
  // ("Content Credentials", not "c2pa"); only a provider with no presenter
  // entry is named by its raw id, and the registry entry is the fix. The
  // error text stays as the provider reported it — technical, but true.
  for (const failure of verdict.failures) {
    evidence.append(
      paragraph(
        "failure",
        POPOVER_STRINGS.failureLine(
          providerDisplayName(failure.providerId),
          failure.message,
        ),
      ),
    );
  }

  const disclosure = document.createElement("button");
  disclosure.type = "button";
  disclosure.className = "disclosure";
  // The id lets the evidence region borrow the button's text as its
  // accessible name (aria-labelledby): "How do we know?" names the region
  // a keyboard user lands in, with no second string to maintain.
  disclosure.id = `${evidence.id}-disclosure`;
  disclosure.textContent = POPOVER_STRINGS.disclosureLabel;
  disclosure.setAttribute("aria-expanded", "false");
  disclosure.setAttribute("aria-controls", evidence.id);
  evidence.setAttribute("role", "region");
  evidence.setAttribute("aria-labelledby", disclosure.id);
  const setOpen = trackScrollFocusability(evidence);
  disclosure.addEventListener("click", () => {
    const open = disclosure.getAttribute("aria-expanded") !== "true";
    disclosure.setAttribute("aria-expanded", String(open));
    evidence.hidden = !open;
    setOpen(open);
  });

  fragment.append(
    disclosure,
    evidence,
    paragraph("privacy", POPOVER_STRINGS.privacyNote),
  );
  return fragment;
}
