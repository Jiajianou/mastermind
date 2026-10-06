import { join } from "node:path";
import { z } from "zod";
import type { ResolvedConfig } from "../config/index.js";
import { errorMessage, findingSeveritySchema, plural } from "../contracts/index.js";
import type { Check, Finding, Task } from "../contracts/index.js";
import type { Git } from "../git/index.js";
import type { OneShotRunner } from "../sessions/one-shot.js";
import { attributionOff } from "../sessions/settings.js";
import { reviewPrompt } from "./prompts.js";
import { startCheck } from "./runner.js";
import type { CheckContext } from "./runner.js";

export const reviewOutputSchema = z.strictObject({
  findings: z.array(
    z.strictObject({
      file: z.string().min(1),
      line: z.int().min(1).nullable(),
      text: z.string().min(1),
      severity: findingSeveritySchema,
    }),
  ),
});

export interface ReviewRequest {
  task: Task;
  worktree: string;
  upstream: string;
  mainBranch: string;
}

export type ReviewResult =
  | { kind: "reviewed"; check: Check; findings: Finding[] }
  | { kind: "unanswered"; check: Check; reason: string };

export interface Reviewer {
  review(request: ReviewRequest): Promise<ReviewResult>;
}

export interface ReviewerOptions extends CheckContext {
  git: Git;
  oneShot: OneShotRunner;
  promptsDir: string;
  config: () => ResolvedConfig;
}

const maxDiffCharacters = 100_000;
const reviewerTools = ["Read", "Grep", "Glob"];

const findingLine = ({ severity, file, line, text }: Finding): string =>
  `${severity} ${file}${line === null ? "" : `:${String(line)}`} ${text}`;

function findingsSummary(findings: readonly Finding[]): string {
  if (findings.length === 0) return "No findings";
  const serious = findings.filter((finding) => finding.severity === "serious").length;
  const total = plural(findings.length, "finding");
  return `${total}: ${String(serious)} serious, ${String(findings.length - serious)} minor`;
}

export function createReviewer(options: ReviewerOptions): Reviewer {
  const { db, git } = options;
  let reviewing: Promise<unknown> = Promise.resolve();

  async function review({
    task,
    worktree,
    upstream,
    mainBranch,
  }: ReviewRequest): Promise<ReviewResult> {
    const run = await startCheck(options, {
      taskId: task.id,
      round: task.round,
      kind: "reviewer",
      cwd: worktree,
    });
    try {
      const files = (await git.run(worktree, ["diff", "--name-status", upstream, "HEAD"])).trim();
      const diff = await git.run(worktree, ["diff", upstream, "HEAD"]);
      const config = options.config();
      const result = await options.oneShot.run({
        role: "reviewer",
        taskId: task.id,
        round: task.round,
        cwd: worktree,
        prompt: reviewPrompt(task, {
          mainBranch,
          upstream,
          files,
          diff: diff.slice(0, maxDiffCharacters),
          diffTruncated: diff.length > maxDiffCharacters,
        }),
        schema: reviewOutputSchema,
        print: {
          model: config.models.reviewer,
          tools: reviewerTools,
          allowedTools: reviewerTools,
          noPermissionPrompts: true,
          appendSystemPromptFile: join(options.promptsDir, "reviewer.md"),
          settings: { attribution: attributionOff },
        },
      });
      run.note(`Reviewer session ${String(result.session.id)} (${config.models.reviewer})`);
      if (result.kind === "failed") {
        run.note(`No answer: ${result.reason}`);
        const check = await run.finish(false, `The reviewer gave no answer: ${result.reason}`);
        return { kind: "unanswered", check, reason: result.reason };
      }
      const findings = db.transaction(() =>
        result.value.findings.map((finding) =>
          db.findings.create({ ...finding, taskId: task.id, round: task.round }),
        ),
      );
      for (const finding of findings) run.note(findingLine(finding));
      const serious = findings.some((finding) => finding.severity === "serious");
      const check = await run.finish(!serious, findingsSummary(findings));
      return { kind: "reviewed", check, findings };
    } catch (error) {
      await run.finish(false, errorMessage(error));
      throw error;
    }
  }

  return {
    review(request) {
      const next = reviewing.then(() => review(request));
      reviewing = next.catch(() => undefined);
      return next;
    },
  };
}
