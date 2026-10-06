import type { OutputFormat } from "./args.js";

export interface Output {
  line(line: object): void;
  result(line: object, text: string): void;
}

export function createOutput(format: OutputFormat): Output {
  const write = (text: string): void => {
    process.stdout.write(text);
  };
  return {
    line(line) {
      if (format === "stream-json") write(`${JSON.stringify(line)}\n`);
    },
    result(line, text) {
      if (format === "text") write(`${text}\n`);
      else write(`${JSON.stringify(line)}\n`);
    },
  };
}

export function flushAndExit(code: number): Promise<never> {
  return new Promise(() => {
    process.stdout.write("", () => {
      process.stderr.write("", () => process.exit(code));
    });
  });
}
