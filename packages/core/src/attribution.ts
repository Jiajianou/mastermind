export interface AttributionMatch {
  line: number;
  text: string;
}

// Each pattern matches one line. Together they cover the trailers and footers of PLAN section 11 and their
// variants: any "...-by:" trailer naming Claude or Anthropic, "Generated with [Claude Code](…)" with or without the
// robot and link, "Claude-Session:"-style trailers, Claude Code session links and Anthropic's noreply address.
// The session trailer needs "session" in its key, so a subject such as "claude-cli: parse flags" is kept.
const attributionPatterns: readonly RegExp[] = [
  /^\s*[\w-]*-by\s*:.*\b(?:claude|anthropic)/i,
  /generated\s+(?:with|by|using)\s+\[?\s*claude\b/i,
  /^\s*claude-[\w-]*session[\w-]*\s*:/i,
  /\bclaude\.ai\/code\b/i,
  /noreply@anthropic\.com/i,
];

const isAttribution = (line: string): boolean =>
  attributionPatterns.some((pattern) => pattern.test(line));

export function findAttribution(text: string): AttributionMatch[] {
  return text
    .split("\n")
    .flatMap((line, index) => (isAttribution(line) ? [{ line: index + 1, text: line }] : []));
}

export function stripAttribution(text: string): string {
  const kept = text.split("\n").filter((line) => !isAttribution(line));
  return kept
    .join("\n")
    .replace(/\n[ \t]*(?:\n[ \t]*)+\n/g, "\n\n")
    .trim();
}
