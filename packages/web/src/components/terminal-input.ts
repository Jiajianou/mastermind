export interface InputQueue {
  push(data: string): void;
}

const chunkLimit = 16_384;

function nextChunk(pending: string): string {
  if (pending.length <= chunkLimit) return pending;
  const code = pending.charCodeAt(chunkLimit - 1);
  const splitsPair = code >= 0xd800 && code <= 0xdbff;
  return pending.slice(0, splitsPair ? chunkLimit - 1 : chunkLimit);
}

// Keystrokes go out one request at a time, so they reach the shell in the order they were typed; whatever is typed
// while a request is in flight goes in the next one.
export function createInputQueue(
  send: (data: string) => Promise<unknown>,
  onError: (error: unknown) => void,
): InputQueue {
  let pending = "";
  let sending = false;

  const drain = async (): Promise<void> => {
    sending = true;
    while (pending !== "") {
      const chunk = nextChunk(pending);
      pending = pending.slice(chunk.length);
      try {
        await send(chunk);
      } catch (error) {
        pending = "";
        onError(error);
      }
    }
    sending = false;
  };

  return {
    push(data) {
      pending += data;
      if (!sending) void drain();
    },
  };
}
