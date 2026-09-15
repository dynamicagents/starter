/**
 * What a workspace object wakes for, as one map.
 *
 * Its own module because two things type against it and neither should own it:
 * the object that registers the callbacks, and the `JobLifecycle` in
 * `./install.ts` that schedules two of them by name. A name that exists in one
 * and not the other is then a compile error rather than a schedule that is
 * rejected at runtime.
 */

// A `type`, not an `interface`: the scheduler constrains its handler map to a
// `Record<string, …>`, and only a type alias carries the implicit index
// signature that satisfies. An interface here fails with a message that names
// neither cause nor cure.
export type WorkspaceWakeHandlers = {
  installRun: () => Promise<void>;
  installWatch: () => Promise<void>;
  idleReclaim: () => Promise<void>;
  containerIdle: () => Promise<void>;
  syncRetry: () => Promise<void>;
};
