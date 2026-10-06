import type { Summary } from "@mastermind/core/contracts";
import { clockTime } from "@mastermind/core/status";
import type { RunningSession, StatusSnapshot } from "@mastermind/core/status";
import { Box, Text } from "ink";
import {
  accountText,
  elapsed,
  eventLineText,
  headerTitle,
  liveCounts,
  sessionRole,
} from "./format.js";
import { Footer } from "./footer.js";

const frostBlue = "#88C0D0";

export interface StatusViewProps {
  snapshot: StatusSnapshot;
  armed: boolean;
  now: Date;
}

function runningText({ activeWorkers, maxWorkers, paused, authRequired, resumeAt }: Summary) {
  return [
    `${String(activeWorkers)} of ${String(maxWorkers)} workers`,
    ...(paused ? ["paused"] : []),
    ...(authRequired ? ["sign-in needed"] : []),
    ...(resumeAt === null ? [] : [`usage limit until ${clockTime(new Date(resumeAt))}`]),
  ].join(" · ");
}

function queueText({ counts }: Summary): string {
  return `${String(counts.pending)} remaining · ${String(counts.review)} review · ${String(counts.blocked)} blocked`;
}

function LinkLine({ link }: { link: string }) {
  return (
    <Text>
      Web app → <Text color={frostBlue}>{link}</Text>
      <Text dimColor> (o open · c copy)</Text>
    </Text>
  );
}

function SessionRow({ session, now }: { session: RunningSession; now: Date }) {
  const columns = [
    session.label.padEnd(16),
    sessionRole(session.role, session.attempt).padEnd(9),
    (session.model ?? "").padEnd(7),
    elapsed(session.startedAt, now).padStart(5),
  ].join(" ");
  return (
    <Text wrap="truncate-end">
      <Text color={frostBlue}>▸</Text> {columns} {session.activity}
    </Text>
  );
}

export function StatusView({ snapshot, armed, now }: StatusViewProps) {
  const { header, running, summary, events } = snapshot;
  return (
    <Box flexDirection="column" paddingX={1}>
      <Box justifyContent="space-between">
        <Text bold>{headerTitle(header)}</Text>
        <Text>{accountText(header)}</Text>
      </Box>
      <LinkLine link={header.link} />
      <Box marginTop={1} justifyContent="space-between">
        <Text>
          <Text bold>RUNNING</Text> {runningText(summary)}
        </Text>
        <Text>
          <Text bold>QUEUE</Text> {queueText(summary)}
        </Text>
      </Box>
      {running.length === 0 ? (
        <Text dimColor>No sessions running</Text>
      ) : (
        running.map((session) => <SessionRow key={session.sessionId} session={session} now={now} />)
      )}
      <Box marginTop={1} flexDirection="column">
        {events.map((line) => (
          <Text key={line.id} wrap="truncate-end">
            {eventLineText(line)}
          </Text>
        ))}
      </Box>
      <Box marginTop={1}>
        <Footer armed={armed} paused={summary.paused} counts={liveCounts(snapshot)} />
      </Box>
    </Box>
  );
}
