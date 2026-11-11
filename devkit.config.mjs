/**
 * What the devkit checkers read here, a section per checker.
 *
 * The checkers themselves are `.devkit/`, vendored from dev-agents'
 * `packages/devkit`; that package's README is the home of what each one fails
 * on and of every key below. This file is only what is this repo's.
 */
export default {
  references: {
    scan: ["src", "test", "scripts"],

    // Every root file here that carries prose. The container image and the
    // environment sample are in because both explain themselves in `#` comments,
    // and those comments name modules in `src/`.
    loose: [
      "README.md",
      "AGENTS.md",
      "wrangler.jsonc",
      "Dockerfile",
      ".env.example"
    ],

    /**
     * Paths that are deliberately not this repo's, with the reason.
     *
     * Add to this only for a path that genuinely lives elsewhere, never to
     * silence one that has gone stale: that one is the finding. A path inside a
     * string is not a reference at all and needs no entry, an example filename in
     * a sub-agent's prompt copy included; the devkit's reference engine says why.
     */
    external: new Map()
  },

  linkLocal: {
    /** Checkouts this repo composes. A missing one is an error. */
    siblings: ["core", "plugins"],

    /**
     * Packed too when present, skipped when not.
     *
     * `g2a-protocol` is the wire contract `@dynamicagents/core` and
     * slack-gatekeeper both depend on. Nothing here imports it directly and it
     * changes about once a year, so requiring the checkout would break
     * `link:local` for everyone who only has the two above. But when it *is*
     * checked out, an edit to it must reach this build, or a linked core
     * silently resolves the published copy and the change under test is not the
     * one running.
     */
    optional: ["g2a-protocol"]
  }
};
