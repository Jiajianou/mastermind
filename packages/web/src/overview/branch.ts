import type { OwnerBranch } from "@mastermind/core/contracts";

const commits = (count: number): string => `${String(count)} commit${count === 1 ? "" : "s"}`;

export function branchFacts({ ahead, behind, mainBranch, upstream }: OwnerBranch): string[] {
  const facts = [
    ahead === 0 ? `No commits that ${mainBranch} lacks` : `${commits(ahead)} not on ${mainBranch}`,
    behind === 0 ? `Up to date with ${mainBranch}` : `${mainBranch} moved ${commits(behind)}`,
  ];
  if (upstream !== null && upstream.ahead > 0)
    facts.push(`${mainBranch} is ${commits(upstream.ahead)} ahead of ${upstream.name}`);
  return facts;
}

export function rebaseNote({ rebase, mainBranch }: OwnerBranch): string | null {
  if (rebase === null) return null;
  return rebase.status === "running"
    ? `Rebasing ${rebase.branch} onto ${mainBranch}…`
    : rebase.outcome;
}
