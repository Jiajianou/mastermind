import { emitKeypressEvents } from "node:readline";
import type { Key } from "node:readline";
import type { Choice, StartupPrompts } from "@mastermind/core/startup";

type Input = NodeJS.ReadStream;
type Output = NodeJS.WriteStream;

const quitKeys = new Set(["escape", "q"]);

function isQuit(key: Key): boolean {
  return quitKeys.has(key.name ?? "") || (key.ctrl === true && key.name === "c");
}

function isEnter(key: Key): boolean {
  return key.name === "return" || key.name === "enter";
}

// Raw mode is held only while a key is awaited, and stdin is paused again afterwards, so that the
// `claude auth login` hand-off gets the terminal to itself.
function readKey(input: Input): Promise<Key> {
  return new Promise((resolve) => {
    input.setRawMode(true);
    input.resume();
    input.once("keypress", (_text: string | undefined, key: Key | undefined) => {
      input.setRawMode(false);
      input.pause();
      resolve(key ?? {});
    });
  });
}

function keyPrompts(input: Input, output: Output): StartupPrompts {
  emitKeypressEvents(input);
  const say = (line: string): void => {
    output.write(`${line}\n`);
  };

  return {
    say,

    async pressEnter(message) {
      say(message);
      for (;;) {
        const key = await readKey(input);
        if (isEnter(key)) return true;
        if (isQuit(key)) return false;
      }
    },

    async choose(question, choices, cancel) {
      say(question);
      let selected = 0;
      const render = (redraw: boolean): void => {
        if (redraw) output.write(`\x1b[${String(choices.length)}A`);
        choices.forEach((choice, index) => {
          output.write(`\x1b[2K${index === selected ? "▸" : " "} ${choice.label}\n`);
        });
      };
      render(false);
      for (;;) {
        const key = await readKey(input);
        if (isEnter(key)) return choices[selected]?.value ?? cancel;
        if (isQuit(key)) return cancel;
        if (key.name === "up" || key.name === "k")
          selected = (selected + choices.length - 1) % choices.length;
        else if (key.name === "down" || key.name === "j")
          selected = (selected + 1) % choices.length;
        render(true);
      }
    },
  };
}

function lineReader(input: Input): () => Promise<string | null> {
  let buffered = "";
  input.setEncoding("utf8");

  const readMore = (): Promise<void> =>
    new Promise((resolve, reject) => {
      const settle = (): void => {
        input.off("data", onData);
        input.off("end", onEnd);
        input.off("error", onError);
        input.pause();
      };
      const onData = (chunk: string): void => {
        buffered += chunk;
        settle();
        resolve();
      };
      const onEnd = (): void => {
        settle();
        resolve();
      };
      const onError = (error: Error): void => {
        settle();
        reject(error);
      };
      input.on("data", onData);
      input.once("end", onEnd);
      input.once("error", onError);
      input.resume();
    });

  return async () => {
    for (;;) {
      const newline = buffered.indexOf("\n");
      if (newline >= 0) {
        const line = buffered.slice(0, newline).replace(/\r$/, "");
        buffered = buffered.slice(newline + 1);
        return line;
      }
      if (input.readableEnded) {
        const rest = buffered;
        buffered = "";
        return rest === "" ? null : rest;
      }
      await readMore();
    }
  };
}

const quitAnswers = new Set(["q", "quit", "esc"]);

function linePrompts(input: Input, output: Output): StartupPrompts {
  const nextLine = lineReader(input);
  const say = (line: string): void => {
    output.write(`${line}\n`);
  };

  return {
    say,

    async pressEnter(message) {
      say(message);
      const answer = await nextLine();
      return answer !== null && !quitAnswers.has(answer.trim().toLowerCase());
    },

    async choose<T extends string>(question: string, choices: readonly Choice<T>[], cancel: T) {
      say(question);
      choices.forEach((choice, index) => {
        say(`  ${String(index + 1)}. ${choice.label}`);
      });
      for (;;) {
        output.write(`Type a number from 1 to ${String(choices.length)}: `);
        const answer = await nextLine();
        say(answer ?? "");
        if (answer === null) return cancel;
        const choice = choices[Number(answer.trim()) - 1];
        if (choice !== undefined) return choice.value;
      }
    },
  };
}

export function createTerminalPrompts(input: Input, output: Output): StartupPrompts {
  return input.isTTY ? keyPrompts(input, output) : linePrompts(input, output);
}
