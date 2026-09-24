import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { makeDoHelpers } from "@dynamicagents/core/testing";
import type { CfCoderWorkspaceDO } from "@/index";

/**
 * The credentialed git operations, and the one thing about them that can be
 * asserted without a network.
 *
 * These methods exist so that `GITHUB_TOKEN` never enters the container:
 * they run isomorphic-git inside this Durable Object, against the same SQLite
 * filesystem the container mounts, and read the token from this object's own
 * `env`. What that buys is verified end-to-end against a real forge; what is
 * verified here is the seam `/repo` depends on — that a git failure comes back
 * as **data**, not as a throw.
 *
 * That distinction is load-bearing on the far side. `/repo` tells a command that
 * ran and failed apart from one that never ran, and answers the model very
 * differently for each. A `GitError` crossing a Durable Object boundary loses its
 * prototype, so it has to be translated here, while it is still itself, or the
 * caller is left matching on a string.
 */

const { freshStub: freshWorkspace } = makeDoHelpers<CfCoderWorkspaceDO>(
  env.CF_CODER_WORKSPACE
);

/**
 * Both cases carry an explicit timeout, and the number is a fact about
 * production rather than test slack.
 *
 * `@cloudflare/computer/git` loads isomorphic-git and the `@platformatic/vfs`
 * adapter through dynamic `import()`, so the *first* credentialed operation in a
 * fresh isolate pays for both — measured at ~4.7 s here, against ~6 ms for every
 * one after it. That is a one-off against a clone that takes seconds anyway, and
 * it is why these two tests kept passing alone and timing out at the default 5 s
 * when the suite ran together.
 */
const FIRST_CALL_MS = 30_000;

describe("credentialed git", () => {
  it(
    "reports a missing repository as a result, not an exception",
    async () => {
      const stub = freshWorkspace("no-repo");

      // Nothing has been cloned here, so there is no `.git` to push from. git
      // answers that question itself, without reaching the network — which is
      // exactly the case that must not arrive as a throw.
      const result = await stub.gitPush({
        url: "https://github.com/owner/repo",
        dir: "/workspace/absent",
        branch: "work",
        allowedHosts: ["github.com"]
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        // git's own words, not the runtime's — and worth pinning as they are,
        // because they are less helpful than they look: pushing from a directory
        // with no repository in it fails on the *ref* it cannot resolve
        // ("Could not find work."), never mentioning that there is no checkout.
        // `/repo` is the layer that has the context to say so; this one must at
        // least hand it something to say it about.
        expect(result.message).toMatch(/could not find/i);
      }
    },
    FIRST_CALL_MS
  );

  it(
    "carries git's own error code across the boundary",
    async () => {
      const stub = freshWorkspace("code");

      const result = await stub.gitFetch({
        url: "https://github.com/owner/repo",
        dir: "/workspace/absent",
        allowedHosts: ["github.com"]
      });

      expect(result.ok).toBe(false);
      // `code` is what survives serialisation and what a caller can branch on;
      // `instanceof GitError` is not available on the far side of RPC.
      if (!result.ok) expect(typeof result.code).toBe("string");
    },
    FIRST_CALL_MS
  );
});
