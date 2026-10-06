const maxSummaryLength = 160;

export function firstLine(text: string): string {
  return (
    text
      .split("\n")
      .map((line) => line.trim())
      .find((line) => line !== "") ?? ""
  );
}

export function oneLine(text: string): string {
  const line = text.replace(/\s*\n\s*/g, " ").trim();
  return line.length > maxSummaryLength ? `${line.slice(0, maxSummaryLength - 1)}…` : line;
}

export function displayPath(path: string, cwd: string | null): string {
  return cwd !== null && path.startsWith(`${cwd}/`) ? path.slice(cwd.length + 1) : path;
}

export function failureText(output: string): string {
  const violation = /<sandbox_violations>\s*([^\n<]+)/.exec(output)?.[1];
  if (violation !== undefined) return `sandbox: ${violation.trim()}`;
  const lines = output
    .replace(/<\/?tool_use_error>/g, "")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
  const [first = "", second] = lines;
  return /^Exit code \d+$/.test(first) && second !== undefined ? `${first}: ${second}` : first;
}
