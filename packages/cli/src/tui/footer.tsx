import { signInExpiredPrompt } from "@mastermind/core/auth";
import { Box, Text } from "ink";
import { armedWarning, footerHint } from "../messages.js";
import type { LiveCounts } from "../messages.js";

export const armedColor = "#FFA500";

export interface FooterProps {
  armed: boolean;
  paused: boolean;
  signInNeeded: boolean;
  counts: LiveCounts;
}

export function Footer({ armed, paused, signInNeeded, counts }: FooterProps) {
  if (armed)
    return (
      <Text color={armedColor} bold>
        {armedWarning(counts)}
      </Text>
    );
  return (
    <Box flexDirection="column">
      {signInNeeded && (
        <Text color={armedColor} bold>
          {signInExpiredPrompt}
        </Text>
      )}
      <Text dimColor>{footerHint(paused)}</Text>
    </Box>
  );
}
