import { getWorkspace } from "@cloudflare/computer";
import type { WorkspaceStub } from "@cloudflare/computer";

/**
 * Open a workspace over its Durable Object stub.
 *
 * `getWorkspace` is typed against the stub shape `withWorkspace` produces, and
 * these objects implement `__getWorkspaceStub` themselves rather than taking the
 * mixin — see `./object.ts` for why. The two shapes agree at runtime and not in
 * the type system, so the call needs a cast.
 *
 * It lives here so that cast is written once. Spread across every call site it
 * was the kind of line that gets copied without being read, and each copy is a
 * place where a stub for something else entirely would be accepted in silence.
 * The constraint below is what makes that a compile error instead: whatever is
 * passed has to carry the method the cast is claiming it has.
 */
export function openWorkspace<T extends { __getWorkspaceStub: unknown }>(
  stub: T
): ReturnType<typeof getWorkspace> {
  return getWorkspace(stub as unknown as Parameters<typeof getWorkspace>[0]);
}

export type { WorkspaceStub };
