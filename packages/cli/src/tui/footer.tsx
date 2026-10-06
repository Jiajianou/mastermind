import { Text } from "ink";
import { armedWarning, footerHint } from "../messages.js";
import type { LiveCounts } from "../messages.js";

export const armedColor = "#FFA500";

export interface FooterProps {
  armed: boolean;
  paused: boolean;
  counts: LiveCounts;
}

export function Footer({ armed, paused, counts }: FooterProps) {
  return armed ? (
    <Text color={armedColor} bold>
      {armedWarning(counts)}
    </Text>
  ) : (
    <Text dimColor>{footerHint(paused)}</Text>
  );
}
