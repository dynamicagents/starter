import { WORKSPACE_WRITERS } from "@/workspace/container";

/**
 * What AnthropicCodingAgent is asked to be for one job of its task's pipeline — see
 * `./workflow.ts`. A job with no role is a whole task, as a one-step pipeline sends.
 */
export type Role = "plan" | "code";

/**
 * The tools a plan may use: enough to open the repository and read it, in the
 * agent's own view and through a reading session. Named rather than filtered
 * out, so a tool added later stays out of a plan until it is put here.
 */
export const PLAN_TOOLS: ReadonlySet<string> = new Set([
  "read",
  "list",
  "find",
  "grep",
  "repo_clone",
  "repo_fetch",
  "repo_status",
  "repo_diff",
  "repo_issue_view",
  "repo_pr_view",
  "repo_pr_threads",
  "repo_pr_review_status",
  "browser_extract",
  "browser_links",
  "browser_markdown",
  "browser_scrape",
  "claude_code_read",
  "ask_user",
  "search_history"
]);

/** The tools a turn may call, for the role of the job it is part of. */
export function activeToolsFor(
  role: string | undefined,
  names: readonly string[]
): string[] {
  const allowed = names.filter((name) => !WORKSPACE_WRITERS.has(name));
  return role === "plan"
    ? allowed.filter((name) => PLAN_TOOLS.has(name))
    : allowed;
}
