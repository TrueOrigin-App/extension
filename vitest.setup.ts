// Shared test-environment shims (vitest.config.ts setupFiles).
//
// jsdom has no ResizeObserver, and the content code constructs one
// unguarded — as it does in Chrome — so every test file gets an inert one.
// A test that needs to drive the callback stubs the global itself
// (vi.stubGlobal); vi.unstubAllGlobals restores this shim.
globalThis.ResizeObserver ??= class ResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
};
