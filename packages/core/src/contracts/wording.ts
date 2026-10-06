export const plural = (count: number, noun: string): string =>
  `${String(count)} ${noun}${count === 1 ? "" : "s"}`;

export const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

export const capitalized = (text: string): string =>
  `${text.charAt(0).toUpperCase()}${text.slice(1)}`;
