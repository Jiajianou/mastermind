import { bashToolResultSchema } from "../contracts/index.js";
import { firstLine } from "./summary.js";

export interface CommitInfo {
  sha: string | null;
  branch: string | null;
  subject: string | null;
}

export interface VcsCommit {
  branch: string | null;
}

const gitCommitCommand = /\bgit(?:\s+-[cC]\s+\S+)*\s+commit\b/;
const commitHeader = /^\[(?<branch>\S+)(?: \([^)]*\))? (?<sha>[0-9a-f]{7,40})\] (?<subject>.+)$/m;
const messageFlag = /(?:-m|--message)(?:\s+|=)(?:"(?<double>[^"]*)"|'(?<single>[^']*)')/;

function messageFromCommand(command: string | null): string | null {
  const groups = command === null ? undefined : messageFlag.exec(command)?.groups;
  const message = groups?.double ?? groups?.single;
  return message === undefined ? null : firstLine(message) || null;
}

export function detectCommit(
  command: string | null,
  output: string,
  toolUseResult: unknown,
  vcsCommit: VcsCommit | null,
): CommitInfo | null {
  const parsed = bashToolResultSchema.safeParse(toolUseResult);
  const reported = parsed.success ? parsed.data.gitOperation?.commit : undefined;
  const ranCommit = vcsCommit !== null || (command !== null && gitCommitCommand.test(command));
  const header = ranCommit ? commitHeader.exec(output)?.groups : undefined;
  if (reported === undefined && header === undefined && vcsCommit === null) return null;

  return {
    sha: reported?.sha ?? header?.sha ?? null,
    branch: reported?.branch ?? header?.branch ?? vcsCommit?.branch ?? null,
    subject: header?.subject ?? messageFromCommand(command),
  };
}

export function commitSummary(commit: CommitInfo): string {
  if (commit.subject !== null) return `Commit "${commit.subject}"`;
  return commit.sha === null ? "Commit" : `Commit ${commit.sha}`;
}
