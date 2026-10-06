import { useEffect, useLayoutEffect, useRef } from "react";

// Edits can arrive faster than a read completes, so at most one load runs at a time and any triggers that arrive
// meanwhile collapse into one more load with the latest inputs. Loads therefore finish in order.
export function useCoalescedLoad(trigger: string | null, load: () => Promise<void>): void {
  const latestLoad = useRef(load);
  const running = useRef(false);
  const pending = useRef(false);

  useLayoutEffect(() => {
    latestLoad.current = load;
  });

  useEffect(
    () => () => {
      pending.current = false;
    },
    [],
  );

  useEffect(() => {
    if (trigger === null) return;
    if (running.current) {
      pending.current = true;
      return;
    }
    const run = (): void => {
      running.current = true;
      void latestLoad.current().finally(() => {
        running.current = false;
        if (!pending.current) return;
        pending.current = false;
        run();
      });
    };
    run();
  }, [trigger]);
}
