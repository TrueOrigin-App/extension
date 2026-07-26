// Service worker entry point. Will host the WASM C2PA validator and the
// signal pipeline (plan.md §4); nothing is wired up yet — this file exists so
// the scaffold builds to a loadable extension.

chrome.runtime.onInstalled.addListener(() => {
  // No setup required yet.
});
