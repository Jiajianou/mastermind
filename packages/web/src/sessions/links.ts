export const sessionPath = (sessionId: number): string => `/sessions?session=${String(sessionId)}`;

export const sessionDiffPath = (sessionId: number): string =>
  `/review?session=${String(sessionId)}`;
