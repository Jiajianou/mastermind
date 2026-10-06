export interface ClientOutput {
  json: boolean;
  write: (text: string) => void;
  writeJson: (value: unknown) => void;
  warn: (text: string) => void;
}

export function processOutput(json: boolean): ClientOutput {
  return {
    json,
    write(text) {
      process.stdout.write(text);
    },
    writeJson(value) {
      process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
    },
    warn(text) {
      process.stderr.write(`${text}\n`);
    },
  };
}
