/**
 * Every variable the image sets for a command actually reaches one.
 *
 * `computerd` hands a spawned command an allowlist — PATH, HOME, TMPDIR, TZ,
 * LANG, TERM and the LC_* family — plus anything named `COMPUTER_VAR_<NAME>`,
 * which arrives as `<NAME>`. That is what keeps the daemon's own secret out of a
 * cloned repository's `postinstall`. Everything else in the image's environment
 * configures the daemon and stops there.
 *
 * So an unprefixed `ENV HUSKY=0` is not a smaller version of the right thing, it
 * is nothing at all: the image builds, the container starts, every command runs,
 * and the variable is simply absent. `NODE_OPTIONS` is the one that hurts —
 * without it Node ignores the OS trust store and every intercepted TLS
 * connection fails with an error that names no cause.
 *
 * A build cannot catch that and neither can a test: it is a property of the
 * image, and the container it would fail in only exists in production. Hence a
 * script, and hence its place in `npm run check`.
 */

import { readFileSync } from "node:fs";

/** What `computerd` passes through under its own name. */
const INHERITED = ["PATH", "HOME", "TMPDIR", "TZ", "LANG", "TERM"];
const INHERITED_PREFIX = "LC_";

/**
 * The daemon's own configuration, which is read by `computerd` itself and must
 * therefore stay unprefixed. Named rather than pattern-matched: the point is
 * that adding one is a deliberate act.
 */
const DAEMON_CONFIG = [
  "PORT",
  "MOUNT_POINT",
  "FUSE_MOUNT",
  "RPC_CLIENT_SECRET"
];

const PREFIX = "COMPUTER_VAR_";

/** Variable names assigned by the `ENV` instructions in a Dockerfile. */
function envNames(dockerfile) {
  const names = [];
  const lines = dockerfile.split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    if (!/^ENV\s/.test(lines[i])) continue;
    // One instruction, which may be continued with a trailing backslash.
    let instruction = lines[i];
    while (instruction.trimEnd().endsWith("\\") && i + 1 < lines.length) {
      i += 1;
      instruction = `${instruction.trimEnd().slice(0, -1)} ${lines[i]}`;
    }
    for (const [, name] of instruction.matchAll(/([A-Za-z_][A-Za-z0-9_]*)=/g)) {
      names.push(name);
    }
  }
  return names;
}

function reaches(name) {
  return (
    name.startsWith(PREFIX) ||
    name.startsWith(INHERITED_PREFIX) ||
    INHERITED.includes(name) ||
    DAEMON_CONFIG.includes(name)
  );
}

const path = new URL("../Dockerfile", import.meta.url);
const unreachable = envNames(readFileSync(path, "utf8")).filter(
  (name) => !reaches(name)
);

if (unreachable.length > 0) {
  for (const name of unreachable) {
    console.error(
      `Dockerfile: ENV ${name} never reaches a command — computerd passes only ` +
        `its allowlist and ${PREFIX}* through. Rename it ${PREFIX}${name}, or ` +
        `add it to DAEMON_CONFIG in this script if computerd itself reads it.`
    );
  }
  process.exit(1);
}

console.log(
  `✓ Dockerfile: every ENV either reaches a command or configures computerd`
);
