import { readFile, writeFile } from "node:fs/promises";

const startMarker = "<!-- demo:start -->";
const endMarker = "<!-- demo:end -->";

export async function embedDemo(readmePath: string, gifPath: string): Promise<void> {
  const readme = await readFile(readmePath, "utf8");
  const start = readme.indexOf(startMarker);
  const end = readme.indexOf(endMarker);
  if (start === -1 || end < start)
    throw new Error(
      `${readmePath} needs ${startMarker} and ${endMarker} where the demo should go.`,
    );
  const image = `<p align="center"><img src="${gifPath}" alt="Mastermind planning, running and landing three tasks from one chat message"></p>`;
  const updated = `${readme.slice(0, start + startMarker.length)}\n${image}\n${readme.slice(end)}`;
  await writeFile(readmePath, updated);
}
