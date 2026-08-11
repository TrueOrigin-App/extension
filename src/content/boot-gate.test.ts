import { describe, expect, it } from "vitest";
import { passesBootGate, type GateWindow } from "./boot-gate";

const MIN = 96;

interface FakeWindow extends GateWindow {
  /** Fires every armed resize listener (a real resize dispatches to all). */
  resize: (width: number, height: number) => void;
  listenerCount: () => number;
}

function makeWindow(options: {
  width: number;
  height: number;
  isChildFrame: boolean;
}): FakeWindow {
  const listeners = new Set<() => void>();
  const top = {};
  const win: FakeWindow = {
    innerWidth: options.width,
    innerHeight: options.height,
    self: options.isChildFrame ? {} : top,
    top,
    addEventListener: (_type, listener) => listeners.add(listener),
    removeEventListener: (_type, listener) => listeners.delete(listener),
    resize: (width, height) => {
      win.innerWidth = width;
      win.innerHeight = height;
      // Copied first: a listener removing itself mid-dispatch must not
      // perturb iteration, same as real event dispatch.
      for (const listener of [...listeners]) listener();
    },
    listenerCount: () => listeners.size,
  };
  return win;
}

describe("passesBootGate", () => {
  it("passes a top frame regardless of viewport size", () => {
    const win = makeWindow({ width: 40, height: 40, isChildFrame: false });
    expect(passesBootGate(win, MIN, () => undefined)).toBe(true);
    expect(win.listenerCount()).toBe(0);
  });

  it("passes a child frame at or above the minimum short side", () => {
    const win = makeWindow({ width: 300, height: MIN, isChildFrame: true });
    expect(passesBootGate(win, MIN, () => undefined)).toBe(true);
    expect(win.listenerCount()).toBe(0);
  });

  it("gates a child frame below the minimum and arms a revive listener", () => {
    const win = makeWindow({ width: 300, height: 80, isChildFrame: true });
    let revived = 0;
    expect(passesBootGate(win, MIN, () => (revived += 1))).toBe(false);
    expect(win.listenerCount()).toBe(1);
    expect(revived).toBe(0);
  });

  it("does not revive while still small, revives exactly once on growth", () => {
    const win = makeWindow({ width: 300, height: 80, isChildFrame: true });
    let revived = 0;
    passesBootGate(win, MIN, () => (revived += 1));
    win.resize(300, 90);
    expect(revived).toBe(0);
    win.resize(300, 200);
    expect(revived).toBe(1);
    expect(win.listenerCount()).toBe(0);
    // The listener disarmed itself: later shrink/grow cycles are the next
    // boot's business, not a second revival.
    win.resize(300, 80);
    win.resize(300, 200);
    expect(revived).toBe(1);
  });

  it("revives a 0×0 (display:none) frame on reveal", () => {
    const win = makeWindow({ width: 0, height: 0, isChildFrame: true });
    let revived = 0;
    passesBootGate(win, MIN, () => (revived += 1));
    win.resize(400, 300);
    expect(revived).toBe(1);
  });

  it("re-arms after a rewrite erased the listener (repeated calls stack safely)", () => {
    // document.open() erases the armed listener; the rewrite sentinel
    // calls the boot path again. Simulated by clearing listeners between
    // calls — and the double-arm case (listener NOT erased, boot path
    // re-entered anyway) must revive once per armed listener without
    // throwing, which the caller's mainStarted guard collapses to one
    // main() run.
    const win = makeWindow({ width: 300, height: 80, isChildFrame: true });
    let revived = 0;
    passesBootGate(win, MIN, () => (revived += 1));
    expect(win.listenerCount()).toBe(1);
    passesBootGate(win, MIN, () => (revived += 1));
    expect(win.listenerCount()).toBe(2);
    win.resize(300, 200);
    expect(revived).toBe(2);
    expect(win.listenerCount()).toBe(0);
  });
});
