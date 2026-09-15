/**
 * What a workspace object wakes for, as one map.
 *
 * Its own module because the object that registers these callbacks and the
 * `JobLifecycle` in `./install.ts` that schedules some of them by name both type
 * against it, and neither should own it. A name that exists in one and not the
 * other is then a compile error rather than a schedule that is rejected at
 * runtime.
 */

import type { SyncDrainIntent } from "./sync.js";

// A `type`, not an `interface`: the scheduler constrains its handler map to a
// `Record<string, …>`, and only a type alias carries the implicit index
// signature that satisfies. An interface here fails with a message that names
// neither cause nor cure.
export type WorkspaceWakeHandlers = {
  installRun: () => Promise<void>;
  installWatch: () => Promise<void>;
  idleReclaim: () => Promise<void>;
  containerIdle: () => Promise<void>;
  syncRetry: (payload?: SyncDrainIntent) => Promise<void>;
};
