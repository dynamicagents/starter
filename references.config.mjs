/**
 * What `npm run verify:references` reads here, and what it is allowed to find.
 *
 * The checker is core's, run through its `da-verify-references` bin, and core is
 * where what a reference is and why only comments are read is explained.
 */
export default {
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
   * Empty, and it was not always: the entries it used to need were all paths
   * inside strings, two of them example filenames in a sub-agent's prompt copy.
   * Reading comments and not data is what retired them. Add to this only for a
   * path that genuinely lives elsewhere, never to silence one that has gone
   * stale: that one is the finding.
   */
  external: new Map()
};
