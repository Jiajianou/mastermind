import { plural } from "@mastermind/core/contracts";
import type { OwnerBranch } from "@mastermind/core/contracts";

export function branchFacts({ ahead, behind, mainBranch, upstream }: OwnerBranch): string[] {
  const facts = [
    ahead === 0
      ? `No commits that ${mainBranch} lacks`
      : `${plural(ahead, "commit")} not on ${mainBranch}`,
    behind === 0
      ? `Up to date with ${mainBranch}`
      : `${mainBranch} moved ${plural(behind, "commit")}`,
  ];
  if (upstream !== null && upstream.ahead > 0)
    facts.push(`${mainBranch} is ${plural(upstream.ahead, "commit")} ahead of ${upstream.name}`);
  return facts;
}

export function rebaseNote({ rebase, mainBranch }: OwnerBranch): string | null {
  if (rebase === null) return null;
  return rebase.status === "running"
    ? `Rebasing ${rebase.branch} onto ${mainBranch}…`
    : rebase.outcome;
}
