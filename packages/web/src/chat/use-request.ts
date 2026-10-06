import { useCallback, useState } from "react";

export interface Request {
  busy: boolean;
  failure: string | null;
  run: (work: () => Promise<void>) => Promise<boolean>;
}

export function useRequest(): Request {
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const run = useCallback(async (work: () => Promise<void>) => {
    setBusy(true);
    setFailure(null);
    try {
      await work();
      return true;
    } catch (error) {
      setFailure(error instanceof Error ? error.message : String(error));
      return false;
    } finally {
      setBusy(false);
    }
  }, []);
  return { busy, failure, run };
}
