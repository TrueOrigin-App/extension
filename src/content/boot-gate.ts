// The tiny-frame boot gate (roadmap chunk 2, hardened in the PR #13
// review): decides whether a frame's content-script instance should
// install anything at all. Split from index.ts so the gate — the boot
// path's only logic — is testable without importing the module whose
// evaluation installs observers jsdom cannot construct.

/** The slice of `window` the gate reads and arms listeners on — narrow so
 * tests can drive it with a plain object. */
export interface GateWindow {
  innerWidth: number;
  innerHeight: number;
  self: unknown;
  top: unknown;
  addEventListener: (type: "resize", listener: () => void) => void;
  removeEventListener: (type: "resize", listener: () => void) => void;
}

/** True when this document should scan now. A child frame whose viewport
 * short side is under `minShortSide` returns false and instead arms a
 * one-shot resize listener: the first resize that grows the frame past
 * the minimum calls `onRevive` (which re-enters the caller's boot path)
 * and disarms itself. Top frames always pass — the gate exists for
 * tracking-pixel and ad-slot frames, and a small top-level window is
 * still a real page.
 *
 * Safe to call repeatedly: each call arms at most one new listener, and
 * a rewrite (document.open()) that erased a previously armed listener is
 * exactly the case the caller re-enters for. */
export function passesBootGate(
  win: GateWindow,
  minShortSide: number,
  onRevive: () => void,
): boolean {
  if (win.self === win.top) return true;
  const shortSide = (): number => Math.min(win.innerWidth, win.innerHeight);
  if (shortSide() >= minShortSide) return true;
  const revive = (): void => {
    if (shortSide() < minShortSide) return;
    win.removeEventListener("resize", revive);
    onRevive();
  };
  win.addEventListener("resize", revive);
  return false;
}
