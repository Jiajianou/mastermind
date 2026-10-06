import { useCallback, useState } from "react";
import { errorMessage } from "@mastermind/core/contracts";

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
      setFailure(errorMessage(error));
      return false;
    } finally {
      setBusy(false);
    }
  }, []);
  return { busy, failure, run };
}
