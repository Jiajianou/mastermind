export interface Choice<T extends string> {
  value: T;
  label: string;
}

export interface StartupPrompts {
  say(line: string): void;
  pressEnter(message: string): Promise<boolean>;
  choose<T extends string>(question: string, choices: readonly Choice<T>[], cancel: T): Promise<T>;
}
