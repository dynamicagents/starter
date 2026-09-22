import type { PoolStore, Worktree } from "@/workspace/worktree-pool";

/** `PoolStore` over a `Map` — the same contract as the SQLite one, for a spec. */
export function memoryPoolStore(): PoolStore & { rows: () => Worktree[] } {
  const rows = new Map<string, Worktree>();
  const key = (repo: string, slot: number) => `${repo}\0${slot}`;
  const every = () =>
    [...rows.values()]
      .sort((a, b) => a.slot - b.slot)
      .map((row) => structuredClone(row));
  return {
    rows: every,
    all: (repo) => every().filter((row) => row.repo === repo),
    every,
    put: (worktree) =>
      rows.set(key(worktree.repo, worktree.slot), structuredClone(worktree)),
    delete: (repo, slot) => rows.delete(key(repo, slot))
  };
}
