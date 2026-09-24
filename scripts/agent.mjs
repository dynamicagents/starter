#!/usr/bin/env node
/**
 * Add or remove an agent, in one command.
 *
 * ## Why this exists
 *
 * An agent is not one edit and the edits are not adjacent: a directory, spots in
 * `src/index.ts`, blocks in `wrangler.jsonc`, an entry in
 * `verify-isolation.mjs`, and any secret the agent's plugins declared. Several of
 * them are stringly-typed, and a missed one fails at a different time each: a
 * forgotten DO binding fails at deploy, a forgotten `new_sqlite_classes` entry
 * fails at the first request, a forgotten isolation entry fails never — it just
 * stops checking the agent.
 *
 * "Grow the one you want, `rm -rf` the rest" is the starter's central claim, and
 * a claim the tooling does not back is a claim that decays.
 *
 * ## What it edits
 *
 *   src/agents/<tenant>/     the agent itself
 *   src/index.ts             the exports and the `agents` array
 *   wrangler.jsonc           DO binding, sqlite migration, workflow binding
 *   scripts/verify-isolation.mjs   the per-agent graph check
 *
 * `wrangler.jsonc` is edited as text, not parsed and re-emitted: it is JSONC and
 * carries load-bearing comments that a `JSON.parse`/`stringify` round trip would
 * silently delete.
 *
 * Usage:
 *   npm run agent:new <tenant> [--kind round|single]
 *   npm run agent:remove <tenant>
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const root = path.resolve(import.meta.dirname, "..");
const [, , command, tenant, ...rest] = process.argv;

const KINDS = new Set(["round", "single"]);
const kindFlag = rest.indexOf("--kind");
const kind = kindFlag === -1 ? "round" : rest[kindFlag + 1];

function die(message) {
  console.error(message);
  process.exit(1);
}

if (!command || !["new", "remove"].includes(command)) {
  die("usage: npm run agent:new <tenant> | npm run agent:remove <tenant>");
}
if (!tenant || !/^[a-z][a-z0-9]*(-[a-z0-9]+)*$/.test(tenant)) {
  die(
    `invalid tenant '${tenant ?? ""}'. A tenant id is lowercase letters, digits ` +
      "and single hyphens between them — no leading, trailing or repeated ones " +
      "— it is what a gatekeeper registers against, so it appears in a URL and in " +
      "a JWT claim."
  );
}
if (!KINDS.has(kind)) {
  die(`--kind must be 'round' or 'single' (got '${kind}')`);
}

/** `claude-coder` → `ClaudeCoder`. The DO class and binding name. */
const pascal = tenant
  .split("-")
  .map((part) => part[0].toUpperCase() + part.slice(1))
  .join("");
/** `claude-coder` → `CLAUDE_CODER`. The workflow binding name. */
const screaming = tenant.replace(/-/g, "_").toUpperCase();
/** `claude-coder` → `claudeCoder`. The `definition.ts` export and its import alias. */
const camel = pascal[0].toLowerCase() + pascal.slice(1);

/**
 * Words a bare `export const <name> = …` or `import { <name> } from …` cannot
 * be, in source or in strict mode. A tenant that camel-cases to one of these
 * (`"default"`, `"class"`, …) would otherwise generate TypeScript that fails to
 * parse rather than to type-check — the worst place to find out, since neither
 * `tsc` nor a linter names the actual cause.
 */
const RESERVED_WORDS = new Set([
  "break",
  "case",
  "catch",
  "class",
  "const",
  "continue",
  "debugger",
  "default",
  "delete",
  "do",
  "else",
  "enum",
  "export",
  "extends",
  "false",
  "finally",
  "for",
  "function",
  "if",
  "import",
  "in",
  "instanceof",
  "interface",
  "let",
  "new",
  "null",
  "package",
  "private",
  "protected",
  "public",
  "return",
  "static",
  "super",
  "switch",
  "this",
  "throw",
  "true",
  "try",
  "typeof",
  "var",
  "void",
  "while",
  "with",
  "yield",
  "await",
  "implements"
]);
if (RESERVED_WORDS.has(camel)) {
  die(
    `invalid tenant '${tenant}': camel-cases to '${camel}', a reserved word — ` +
      "it cannot be used as an export name. Pick a different tenant id."
  );
}

const dir = path.join(root, "src/agents", tenant);
const files = {
  index: path.join(root, "src/index.ts"),
  wrangler: path.join(root, "wrangler.jsonc"),
  isolation: path.join(root, "scripts/verify-isolation.mjs")
};

const read = (f) => readFileSync(f, "utf8");
const write = (f, s) => writeFileSync(f, s);

/** Apply an edit, reporting when the anchor was not found rather than silently skipping. */
function edit(file, label, fn) {
  const before = read(file);
  const after = fn(before);
  if (after === before) {
    console.warn(`  ! ${path.relative(root, file)}: ${label} — no change`);
    return;
  }
  write(file, after);
  console.log(`  ✓ ${path.relative(root, file)}: ${label}`);
}

// --- new -------------------------------------------------------------------

const AGENT_TS = (
  isRound
) => `import type { AgentPlugin, CoreConfigOverrides } from "@dynamicagents/core";
import type { PluginHost } from "@dynamicagents/core/host";
${
  isRound
    ? `import {
  RoundAgentBase,
  type RoundPolicy,
  type SubagentClass
} from "@dynamicagents/core/round";`
    : `import { DynamicAgent } from "@dynamicagents/core/host";`
}
import { ${screaming}_CONFIG } from "@/config";
${isRound ? 'import { roundPolicy } from "@/round-policy";\n' : ""}import { ${camel} } from "./definition";
import { plugins } from "./plugins";
import { soulPrompt } from "./soul";
${isRound ? `import { ${pascal}Subagent } from "./subagent";\n` : ""}
/**
 * The ${tenant} agent.
 *
 * ${
   isRound
     ? "A delegating round agent: the loop, the durable Subtask rows and the\n * subagent execution are all `@dynamicagents/core/round`. What is *this agent* is\n * the five methods below plus `./plugins.ts` and `./soul.ts`."
     : "A single-turn agent: it extends `DynamicAgent` directly and writes its own\n * loop, so it carries none of the delegation machinery. Add a `converse` method\n * (or whatever your turn is called) and a workflow that drives it."
 }
 */
export class ${pascal}Agent extends ${isRound ? "RoundAgentBase" : "DynamicAgent"}<Env> {
  protected agentConfig(): CoreConfigOverrides {
    return { ...${screaming}_CONFIG, agentName: ${camel}.tenant };
  }

  protected agentPlugins(host: PluginHost<Env>): AgentPlugin[] {
    return plugins(host);
  }

  protected agentSoul(capabilities: string): string {
    return soulPrompt(capabilities);
  }
${
  isRound
    ? `
  /** The words the loop says. Core ships none — see \`src/round-policy.ts\`. */
  protected roundPolicy(): RoundPolicy {
    return roundPolicy;
  }

  protected subagentClass(): SubagentClass {
    return ${pascal}Subagent;
  }
`
    : ""
}}
`;

const DEFINITION_TS = `import { defineAgent } from "@dynamicagents/core/worker";
import { manifest } from "./manifest";

/**
 * How this agent is reached: its tenant id, its card, its Durable Object, and the
 * Workflow its turns run on — declared once.
 *
 * \`src/index.ts\` mounts the tenant from this, and \`./workflow.ts\` resolves its DO
 * stub from this, so the two cannot address different Durable Objects.
 */
export const ${camel} = defineAgent({
  tenant: "${tenant}",
  manifest,
  agent: (env: Env) => env.${pascal}Agent,
  workflow: (env: Env) => env.${screaming}_WORKFLOW
});
`;

const SUBAGENT_TS = `import type { AgentPlugin, CoreConfigOverrides } from "@dynamicagents/core";
import type { PluginHost } from "@dynamicagents/core/host";
import { RecipeSubagentHost } from "@dynamicagents/core/round";
import { ${screaming}_CONFIG } from "@/config";
import { ${camel} } from "./definition";
import { plugins } from "./plugins";

/**
 * The ${tenant} agent's subagent facet.
 *
 * Named and exported by design: the framework resolves a facet by
 * \`this.constructor.name\`. It needs no wrangler binding — only the export from
 * \`src/index.ts\` — but it does need a test-only one; see \`vitest.config.ts\`.
 */
export class ${pascal}Subagent extends RecipeSubagentHost<Env> {
  protected agentConfig(): CoreConfigOverrides {
    return { ...${screaming}_CONFIG, agentName: ${camel}.tenant };
  }

  protected agentPlugins(host: PluginHost<Env>): AgentPlugin[] {
    return plugins(host);
  }
}
`;

const ROUND_WORKFLOW_TS = `import { WorkflowEntrypoint } from "cloudflare:workers";
import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers";
import { resolveConfig } from "@dynamicagents/core";
import {
  runHandleTask,
  type HandleTaskParams,
  type TaskVerdict
} from "@dynamicagents/core/round";
import { ${screaming}_CONFIG } from "@/config";
import { roundPolicy } from "@/round-policy";
import { ${camel} } from "./definition";

/**
 * The ${tenant} agent's task workflow: core's orchestration, its own binding.
 *
 * The verdict is returned rather than awaited and dropped: the platform records
 * what \`run()\` returns as the Workflow instance's \`output\`, and that is the only
 * thing telling a failed task from a successful one on a record where both are
 * \`complete\` with every step \`ok\`.
 */
export class ${pascal}Workflow extends WorkflowEntrypoint<Env, HandleTaskParams> {
  async run(
    event: Readonly<WorkflowEvent<HandleTaskParams>>,
    step: WorkflowStep
  ): Promise<TaskVerdict> {
    return await runHandleTask(event.payload, step, {
      resolveAgent: (identity) => ${camel}.resolveAgent(this.env, identity),
      config: resolveConfig(${screaming}_CONFIG),
      policy: roundPolicy,
      signingKey: this.env.A2A_SIGNING_KEY
    });
  }
}
`;

/**
 * defineAgent's "workflow" accessor is required for every agent, round or
 * single — there is no core-provided single-turn orchestration to call the way
 * runHandleTask covers the round case, so this is a stub, not a working
 * implementation. Without it, --kind single would leave definition.ts pointing
 * workflow: (env) => env.${screaming}_WORKFLOW at a class nothing exports — a
 * Worker that fails wrangler types --check and cannot deploy.
 */
const SINGLE_WORKFLOW_TS = `import { WorkflowEntrypoint } from "cloudflare:workers";
import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers";
import type { AcceptedTurn } from "@dynamicagents/core/a2a";

/**
 * The ${tenant} agent's task workflow.
 *
 * Core ships no single-turn orchestration — compare \`../reactive/workflow.ts\`,
 * which is entirely \`@dynamicagents/core/round\`. Resolve the agent DO (\`./definition\`
 * exports it), drive whatever turn method \`./agent.ts\` ends up exposing, and
 * persist + notify through the \`markWorking\`/\`saveTask\` RPCs every agent's
 * Durable Object already has. See \`../proactive/workflow.ts\` for a worked
 * example of the whole shape.
 */
export class ${pascal}Workflow extends WorkflowEntrypoint<Env, AcceptedTurn> {
  async run(
    _event: Readonly<WorkflowEvent<AcceptedTurn>>,
    _step: WorkflowStep
  ): Promise<void> {
    throw new Error(
      "TODO: ${pascal}Workflow has not been implemented yet — see ../proactive/workflow.ts"
    );
  }
}
`;

const PLUGINS_TS = `import type { AgentPlugin } from "@dynamicagents/core";
import type { PluginHost } from "@dynamicagents/core/host";

/**
 * The one file you edit to add or remove a capability for this agent.
 *
 * Delete a line and that module leaves the bundle entirely. Nothing in core
 * imports a plugin, and \`@dynamicagents/plugins\` has no root barrel — the bare
 * specifier does not resolve — so the guarantee is structural rather than a
 * tree-shaker's opinion. \`npm run verify:isolation\` asserts it on the built graph.
 *
 * Each agent has its own copy of this file. There is deliberately no shared one:
 * a single list would put every plugin in every agent.
 */
// Prefix removed once a plugin actually reads \`host\` — an empty list installs
// nothing, and this repo's own \`@typescript-eslint/no-unused-vars\` fails
// \`npm run check\` on an unused parameter.
export const plugins = (_host: PluginHost<Env>): AgentPlugin[] => [
  // e.g. browser({ binding: host.env.BROWSER }),
];
`;

const SOUL_TS = `/**
 * The ${tenant} agent's soul — its frozen identity and operating rules.
 *
 * Core ships no prompt copy at all, deliberately: this is the one part of an
 * agent nobody else can write for you.
 *
 * **Nothing about a capability belongs here.** Every installed plugin declares
 * what the agent can do with it, and \`runtime.renderCapabilities()\` collects
 * them — so removing a plugin removes its advice with it.
 */
export const SOUL: string[] = [
  "You are the ${tenant} agent.",
  "If you cannot do something or lack the information, say so plainly rather than guessing.",
  "Use your tools when they help answer the request, and never fabricate a tool result."
];

/** The frozen soul, plus whatever the installed plugins say they can do. */
export function soulPrompt(capabilities: string): string {
  const lines = [...SOUL];
  if (capabilities) lines.push(capabilities);
  return lines.join("\\n");
}
`;

const MANIFEST_TS = `import type { AgentManifest } from "@dynamicagents/core/a2a";

/**
 * The transport-independent half of this agent's AgentCard. \`buildBaseCard\` adds
 * \`supportedInterfaces\` (the deployment's shared \`/a2a\` url, tagged with this
 * agent's tenant id) and the security scheme. Served via \`GetExtendedAgentCard\`,
 * since the well-known path carries the deployment's stub card.
 */
export const manifest: AgentManifest = {
  name: "${pascal} Agent",
  description: "TODO: what this agent does, for a gatekeeper operator reading its card.",
  version: "0.1.0",
  // \`extensions\` is a required (repeated) protobuf field in v1.0 — we declare no
  // protocol extensions, so it stays empty.
  capabilities: { streaming: false, pushNotifications: true, extensions: [] },
  defaultInputModes: ["text/plain"],
  defaultOutputModes: ["text/plain"],
  skills: [
    {
      id: "chat",
      name: "Chat",
      description: "TODO",
      tags: [],
      examples: [],
      // Empty means "inherit the card's defaultInput/OutputModes".
      inputModes: [],
      outputModes: [],
      // Empty means "inherit the card-level requirement" (the gatekeeper JWT).
      securityRequirements: []
    }
  ]
};
`;

function createAgent() {
  if (existsSync(dir)) die(`src/agents/${tenant} already exists`);
  const isRound = kind === "round";

  mkdirSync(dir, { recursive: true });
  write(path.join(dir, "agent.ts"), AGENT_TS(isRound));
  write(path.join(dir, "definition.ts"), DEFINITION_TS);
  write(path.join(dir, "plugins.ts"), PLUGINS_TS);
  write(path.join(dir, "soul.ts"), SOUL_TS);
  write(path.join(dir, "manifest.ts"), MANIFEST_TS);
  // Every kind gets a workflow.ts: `defineAgent`'s `workflow` accessor is
  // required regardless, so a single-turn agent needs one too — just a stub,
  // since core has no orchestration to call the way round has `runHandleTask`.
  write(
    path.join(dir, "workflow.ts"),
    isRound ? ROUND_WORKFLOW_TS : SINGLE_WORKFLOW_TS
  );
  if (isRound) {
    write(path.join(dir, "subagent.ts"), SUBAGENT_TS);
  }
  console.log(`  ✓ src/agents/${tenant}/`);

  edit(files.index, "exports + agents array", (s) => {
    const importLine = `import { ${camel} } from "./agents/${tenant}/definition";\n`;
    let out = s.replace(
      /(import \{ \w+ \} from "\.\/agents\/[^"]+\/definition";\n)(?![\s\S]*import \{ \w+ \} from "\.\/agents\/[^"]+\/definition";)/,
      `$1${importLine}`
    );
    const exports = [
      `export { ${pascal}Agent } from "./agents/${tenant}/agent";`,
      ...(isRound
        ? [`export { ${pascal}Subagent } from "./agents/${tenant}/subagent";`]
        : []),
      `export { ${pascal}Workflow } from "./agents/${tenant}/workflow";`
    ].join("\n");
    out = out.replace(/(\n\/\*\*\n \* One Worker,)/, `\n${exports}\n$1`);
    return out.replace(/(agents: \[)([^\]]*)\]/, `$1$2, ${camel}]`);
  });

  edit(files.wrangler, "DO binding, sqlite migration, workflow", (s) =>
    s
      .replace(
        /(\{ "class_name": "\w+Agent", "name": "\w+Agent" \})(\s*\n\s*\]\s*\n\s*\},\s*\n\s*"migrations")/,
        `$1,\n      { "class_name": "${pascal}Agent", "name": "${pascal}Agent" }$2`
      )
      .replace(
        /("new_sqlite_classes": \[)([\s\S]*?)(\n\s*\])/,
        `$1$2,\n        "${pascal}Agent"$3`
      )
      .replace(
        /(\n\s*\{\n\s*"binding": "\w+",\n\s*"name": "[^"]+",\n\s*"class_name": "\w+"\n\s*\})(\n\s*\],)/,
        `$1,\n    {\n      "binding": "${screaming}_WORKFLOW",\n      "name": "${tenant}",\n      "class_name": "${pascal}Workflow"\n    }$2`
      )
  );

  edit(files.isolation, "per-agent graph check", (s) =>
    s.replace(
      /(\n\];)/,
      `,\n  {\n    name: "${tenant}",\n    entries: [\n      "src/agents/${tenant}/agent.ts",\n      "src/agents/${tenant}/workflow.ts"${
        isRound ? `,\n      "src/agents/${tenant}/subagent.ts"` : ""
      }\n    ],\n    // Every plugin another agent installs and this one must not.\n    forbidden: [${
        isRound ? "" : 'core("round")'
      }],\n    maxBytes: 4_000_000\n  }$1`
    )
  );

  console.log(`
Next:
  1. Add ${screaming}_CONFIG to src/config.ts
  2. Fill in src/agents/${tenant}/{soul,manifest,plugins}.ts
  3. Add this agent's forbidden plugins to scripts/verify-isolation.mjs
  4. npm run types && npm run check && npm test && npm run verify:isolation
  5. Register it with your gatekeeper: same endpoint, tenant id "${tenant}"`);
}

// --- remove ----------------------------------------------------------------

function removeAgent() {
  if (!existsSync(dir)) die(`src/agents/${tenant} does not exist`);

  rmSync(dir, { recursive: true, force: true });
  console.log(`  ✓ removed src/agents/${tenant}/`);

  edit(files.index, "exports + agents array", (s) =>
    s
      .split("\n")
      .filter(
        (line) =>
          !line.includes(`"./agents/${tenant}/`) &&
          !line.includes(`./agents/${tenant}/definition`)
      )
      .join("\n")
      // Scoped to the `agents: [...]` array itself, not a file-wide word-boundary
      // replace: a tenant that camel-cases to `fetch`, `manifest` or `agents`
      // would otherwise corrupt an unrelated identifier or property name
      // anywhere else in this file that happens to spell the same word.
      .replace(/agents: \[([^\]]*)\]/, (_m, inner) => {
        const items = inner
          .split(",")
          .map((s) => s.trim())
          .filter((s) => s && s !== camel);
        return `agents: [${items.join(", ")}]`;
      })
  );

  edit(files.wrangler, "DO binding, sqlite migration, workflow", (s) =>
    s
      .replace(
        new RegExp(
          `,?\\s*\\{ "class_name": "${pascal}Agent", "name": "${pascal}Agent" \\}`
        ),
        ""
      )
      .replace(new RegExp(`,?\\s*"${pascal}Agent"(?=[,\\s\\]])`), "")
      .replace(
        new RegExp(
          `,?\\s*\\{\\s*"binding": "${screaming}_WORKFLOW",[\\s\\S]*?\\}`
        ),
        ""
      )
  );

  edit(files.isolation, "per-agent graph check", (s) =>
    s.replace(
      new RegExp(
        `,?\\s*\\{\\s*name: "${tenant}",[\\s\\S]*?maxBytes: [\\d_]+\\s*\\}`
      ),
      ""
    )
  );

  console.log(`
Next:
  1. Drop ${screaming}_CONFIG from src/config.ts, and any secret only this agent needed
  2. npm run types && npm run check && npm test && npm run verify:isolation

The signing key and GATEKEEPER_ORIGINS stay — they belong to the deployment, not to
any one agent.`);
}

/**
 * Normalize whatever the edits above produced, with the repo's own formatter.
 *
 * These are regex edits over TypeScript and JSONC, so they land the right tokens
 * in the right places and leave the whitespace approximate — a doubled blank line
 * where an export was spliced out, say. `npm run check` runs `prettier --check`,
 * so approximate whitespace is a failing build. Running the formatter here means
 * the regexes only have to be *correct*, not *tidy*, and an add-then-remove round
 * trip returns the tree byte-for-byte to where it started.
 */
function format() {
  const targets = [
    path.relative(root, files.index),
    path.relative(root, files.wrangler),
    path.relative(root, files.isolation),
    ...(command === "new" ? [`src/agents/${tenant}`] : [])
  ];
  try {
    execFileSync(
      "npx",
      ["prettier", "--write", "--log-level", "warn", ...targets],
      {
        cwd: root,
        stdio: "inherit"
      }
    );
    console.log("  ✓ prettier");
  } catch {
    console.warn(
      "  ! prettier failed — run `npm run format` before committing"
    );
  }
}

console.log(
  `${command === "new" ? "Creating" : "Removing"} agent '${tenant}'…`
);
if (command === "new") createAgent();
else removeAgent();
format();
