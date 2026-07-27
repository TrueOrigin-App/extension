// Provider registry: the providers the extension actually runs. Adding a
// signal means implementing it in this directory and listing it here —
// nothing outside src/providers/ changes (plan.md §8, constraint 4; §6
// Phase 1 exit criterion).

import type { SignalProvider } from "../core/types";
import { createC2paProvider } from "./c2pa";

export const activeProviders: SignalProvider[] = [createC2paProvider()];
