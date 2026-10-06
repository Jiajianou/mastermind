import type { Choice, StartupPrompts } from "@mastermind/core/startup";

export type Answer = { kind: "enter" } | { kind: "choose"; value: string };

export interface ScriptedPrompts {
  prompts: StartupPrompts;
  transcript: string[];
}

export function scriptedPrompts(answers: readonly Answer[]): ScriptedPrompts {
  const remaining = [...answers];
  const transcript: string[] = [];
  const next = (prompt: string): Answer => {
    const answer = remaining.shift();
    if (answer === undefined) throw new Error(`unexpected prompt: ${prompt}`);
    return answer;
  };

  return {
    transcript,
    prompts: {
      say(line) {
        transcript.push(line);
      },

      pressEnter(message) {
        transcript.push(message);
        const answer = next(message);
        if (answer.kind !== "enter") throw new Error(`expected Enter, got a choice: ${message}`);
        return Promise.resolve(true);
      },

      choose<T extends string>(question: string, choices: readonly Choice<T>[]) {
        transcript.push(question, ...choices.map(({ label }) => `  ${label}`));
        const answer = next(question);
        const choice = choices.find(
          ({ value }) => answer.kind === "choose" && value === answer.value,
        );
        if (choice === undefined)
          throw new Error(`no choice matches ${JSON.stringify(answer)}: ${question}`);
        return Promise.resolve(choice.value);
      },
    },
  };
}
