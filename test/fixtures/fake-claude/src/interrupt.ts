export class Interrupted extends Error {
  override readonly name = "Interrupted";

  constructor() {
    super("the turn was interrupted");
  }
}

export function waitUnlessInterrupted(ms: number | undefined, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(new Interrupted());
  return new Promise((resolve, reject) => {
    const timer = ms === undefined ? undefined : setTimeout(finish, ms);
    const keepAlive = ms === undefined ? setInterval(() => undefined, 1 << 30) : undefined;
    function finish(): void {
      clearTimeout(timer);
      clearInterval(keepAlive);
      signal.removeEventListener("abort", onAbort);
      resolve();
    }
    function onAbort(): void {
      clearTimeout(timer);
      clearInterval(keepAlive);
      reject(new Interrupted());
    }
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
