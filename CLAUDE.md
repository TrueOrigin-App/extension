# TrueOrigin — extension

Chrome extension (MV3) answering "is this AI-generated?" for images on the web,
by aggregating provenance signals (C2PA at launch).

## Required reading

Read plan.md before any work. §8 defines your hard constraints, what you may
decide freely, what requires asking first, and the task order. The verdict
taxonomy (§2) and its rules are non-negotiable.

Then read ROADMAP.md — the current task queue (one chunk = one session = one
PR), with per-chunk context pointers and status. plan.md §8's original task
order is exhausted; ROADMAP.md supersedes it as the source of what to work on
next. Take the topmost queued chunk unless directed otherwise, and update its
status line as part of the chunk's PR.

## Working conventions

- Record every free-choice decision in DECISIONS.md (what, why, alternatives rejected).
- Small, reviewable diffs. One task per session where possible.
- Run tests before declaring any task complete: `npm test` (update this once the
  test runner exists).
- This repo is public under Apache 2.0 — no secrets, keys, or proprietary logic,
  ever (plan.md §8, constraint 6).

## Commands

- `npm run build` — bundle the extension into `dist/`
- `npm run dev` — watch mode (rebuilds `dist/` on change)
- `npm test` — run unit tests (Vitest)
- `npm run typecheck` — `tsc --noEmit`
- `npm run format` / `npm run format:check` — Prettier
- Load unpacked: `npm run build`, then `chrome://extensions` → enable
  Developer mode → "Load unpacked" → select the `dist/` directory.
