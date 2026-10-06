export type Environment = Readonly<Record<string, string | undefined>>;

const providerVariables = [
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CODE_USE_FOUNDRY",
];

const nestedSessionVariables = [
  "CLAUDECODE",
  "CLAUDE_CODE_ENTRYPOINT",
  "CLAUDE_CODE_SESSION_ID",
  "CLAUDE_CODE_CHILD_SESSION",
  "CLAUDE_CODE_SESSION_ATTENDED",
  "CLAUDE_CODE_MESSAGING_SOCKET",
  "CLAUDE_CODE_MESSAGING_TOKEN",
  "CLAUDE_CODE_EXECPATH",
  "CLAUDE_PID",
  "CLAUDE_EFFORT",
  "AI_AGENT",
];

const removedVariables = new Set([...providerVariables, ...nestedSessionVariables]);

// Every ANTHROPIC_* variable carries an API credential, points at an endpoint or provider, or remaps a model
// alias, so a prefix match also catches provider variables that newer Claude Code versions add.
function isRemoved(name: string, value: string): boolean {
  if (name.startsWith("ANTHROPIC_")) return true;
  if (name === "CLAUDE_CONFIG_DIR") return value === "";
  return removedVariables.has(name);
}

export function cleanEnv(env: Environment): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env).filter(
      (entry): entry is [string, string] =>
        entry[1] !== undefined && !isRemoved(entry[0], entry[1]),
    ),
  );
}
