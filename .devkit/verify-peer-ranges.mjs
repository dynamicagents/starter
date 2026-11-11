#!/usr/bin/env node
/**
 * Hold this repository's peer ranges and its installed tree to each other.
 *
 * Why a peer range needs a checker at all, what the three checks are and why
 * `--latest` is not one of them live in `lib/peer-ranges.mjs`, which this prints
 * the findings of.
 *
 * ```sh
 * npm run verify:peer-ranges              # in `check`: offline, deterministic
 * npm run verify:peer-ranges -- --latest  # by hand: asks the registry
 * ```
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { classifyLatest, verifyPeerRanges } from "./lib/peer-ranges.mjs";
import { repositoryRoot } from "./lib/repo.mjs";

const { name, failures, peers, checked } = verifyPeerRanges(repositoryRoot());

if (failures.length > 0) {
  console.error(`\n✘ ${name} declares peer ranges it does not meet:\n`);
  for (const failure of failures) console.error(`  • ${failure}`);
  console.error("");
  process.exit(1);
}

console.log(
  `✓ ${name}: every installed peer satisfies its declared range` +
    (peers.length > checked.length ? " (optional peers absent: skipped)" : "")
);

// --- --latest. by hand, never in `check` -------------------------------------

if (!process.argv.includes("--latest")) process.exit(0);

/**
 * `npm view` rather than a `fetch` of the registry, because it is the only way
 * to inherit the registry, proxy and auth this repo is actually configured with.
 * A hardcoded `registry.npmjs.org` reports the wrong answer for a scoped peer
 * published somewhere else, and reports it confidently.
 */
const view = promisify(execFile);
const latestOf = async (name) => {
  try {
    const { stdout } = await view("npm", ["view", name, "version"], {
      encoding: "utf8"
    });
    return stdout.trim();
  } catch {
    return undefined;
  }
};

const latest = new Map(
  await Promise.all(
    checked.map(async ([peer]) => [peer, await latestOf(peer)])
  )
);
const { rows, outsideRange, untested } = classifyLatest(checked, latest);

console.log(`\n  ${"peer".padEnd(28)} ${"range".padEnd(22)} installed → latest`);

for (const [peer, range, version, newest, verdict] of rows) {
  console.log(
    `  ${peer.padEnd(28)} ${range.padEnd(22)} ` +
      `${version} → ${newest ?? "?"}`.padEnd(20) +
      ` ${verdict}`
  );
}

if (outsideRange.length > 0) {
  console.log(
    `\n  Excluded by the declared range. Widen one only after installing that ` +
      `version\n  and running the suite green — the ceiling is the claim, and ` +
      `this is the evidence:\n`
  );
  for (const [peer, range, newest] of outsideRange) {
    console.log(`    ${peer}: "${range}" excludes ${newest}`);
  }
}

if (untested.length > 0) {
  console.log(
    `\n  Admitted by the declared range and never run here. Either install it ` +
      `and\n  keep the range, or lower the ceiling to what has actually been ` +
      `tested:\n`
  );
  for (const [peer, range, version, newest] of untested) {
    console.log(
      `    ${peer}: "${range}" admits ${newest}; ${version} installed`
    );
  }
}

console.log("");
