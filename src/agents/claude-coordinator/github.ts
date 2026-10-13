import { parseRepo } from "@dynamicagents/plugins/repo";

/**
 * What the coordinator asks GitHub itself, with the deployment's token, rather
 * than through a checkout: no container is started for any of it.
 */

const API = "https://api.github.com";

async function get(
  token: string,
  path: string,
  accept = "application/vnd.github+json"
): Promise<Response> {
  return fetch(`${API}${path}`, {
    headers: {
      authorization: `Bearer ${token}`,
      accept,
      "user-agent": "dynamicagents-starter"
    }
  });
}

/** `owner/repo` as a path, each half encoded. */
function repoPath(repo: string): string {
  const [owner = "", name = ""] = repo.split("/");
  return `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`;
}

/**
 * A checkout's `.gitmodules` on `branch`, or `undefined` when GitHub has none
 * to give: the repository is not on github.com, has no submodules, or could
 * not be read just now.
 */
export async function gitmodulesOf(
  token: string,
  url: string,
  branch: string
): Promise<string | undefined> {
  if (new URL(url).hostname !== "github.com") return undefined;
  const repo = parseRepo(url);
  if (!repo) return undefined;
  try {
    const answer = await get(
      token,
      `${repoPath(`${repo.owner}/${repo.repo}`)}/contents/.gitmodules?ref=${encodeURIComponent(branch)}`,
      "application/vnd.github.raw"
    );
    return answer.ok ? await answer.text() : undefined;
  } catch {
    return undefined;
  }
}

/** A pull request from a branch, as a revision is checked against it. */
export interface BranchPull {
  repo: string;
  number: number;
  url: string;
  state: "open" | "merged" | "closed";
  /** Its head commit. */
  head: string;
}

/**
 * The pull requests from `branch` in `repo`, newest first. Only from the
 * repository's own branch: `head` names the owner, so a fork's pull request
 * under the same branch name is not one of them — and a session could not push
 * to it anyway.
 *
 * Throws when GitHub does not answer, so a check is never passed on a guess.
 */
export async function pullsFrom(
  token: string,
  repo: string,
  branch: string
): Promise<BranchPull[]> {
  const [owner = ""] = repo.split("/");
  const answer = await get(
    token,
    `${repoPath(repo)}/pulls?state=all&head=${encodeURIComponent(`${owner}:${branch}`)}&per_page=10`
  );
  if (!answer.ok) {
    throw new Error(
      `GitHub answered ${answer.status} for the pull requests of ${repo}; try again shortly.`
    );
  }
  const pulls = (await answer.json()) as {
    number: number;
    state: string;
    merged_at?: string | null;
    html_url?: string;
    head?: { sha?: string };
  }[];
  return pulls.map((pull) => ({
    repo,
    number: pull.number,
    url: pull.html_url ?? "",
    state:
      pull.state === "open" ? "open" : pull.merged_at ? "merged" : "closed",
    head: pull.head?.sha ?? ""
  }));
}

/** A pull request's head commit now, or `undefined` when it cannot be read. */
export async function pullHead(
  token: string,
  repo: string,
  number: number
): Promise<string | undefined> {
  try {
    const answer = await get(token, `${repoPath(repo)}/pulls/${number}`);
    if (!answer.ok) return undefined;
    return ((await answer.json()) as { head?: { sha?: string } }).head?.sha;
  } catch {
    return undefined;
  }
}

/** How many commits `head` has that `base` has not, or `undefined` when unknown. */
export async function commitsSince(
  token: string,
  repo: string,
  base: string,
  head: string
): Promise<number | undefined> {
  try {
    const answer = await get(
      token,
      `${repoPath(repo)}/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}`
    );
    if (!answer.ok) return undefined;
    return ((await answer.json()) as { ahead_by?: number }).ahead_by;
  } catch {
    return undefined;
  }
}
