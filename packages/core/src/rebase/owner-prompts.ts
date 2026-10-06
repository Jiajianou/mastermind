import { fenced } from "../contracts/index.js";

export interface BranchConflict {
  branch: string;
  mainBranch: string;
  upstream: string;
  commit: string;
  subject: string;
  files: readonly string[];
  output: string;
}

export function branchConflictPrompt(conflict: BranchConflict): string {
  const { branch, mainBranch } = conflict;
  return [
    `# Resolve a rebase conflict in ${branch}`,
    `Mastermind is rebasing a copy of the owner's branch \`${branch}\` onto \`upstream/${mainBranch}\` (${conflict.upstream.slice(0, 7)}). The rebase stopped while replaying the owner's commit ${conflict.commit.slice(0, 7)} "${conflict.subject}".`,
    "## Conflicted files",
    conflict.files.map((file) => `- ${file}`).join("\n"),
    "## git's output",
    fenced(conflict.output.trim() === "" ? "(no output)" : conflict.output.trimEnd(), "text"),
    "Resolve every conflict and `git add` the files. Don't commit and don't continue the rebase: mastermind does that, so your resolution becomes part of the owner's commit.",
  ].join("\n\n");
}
