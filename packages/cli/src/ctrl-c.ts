export const armWindowMs = 2_000;

export type CtrlCState = { kind: "idle" } | { kind: "armed"; expiresAt: number };

export type CtrlCInput = { kind: "press"; at: number } | { kind: "expire"; at: number };

export type CtrlCEffect = "arm" | "fire" | "disarm" | "none";

export interface CtrlCStep {
  state: CtrlCState;
  effect: CtrlCEffect;
}

const idle: CtrlCState = { kind: "idle" };

export function stepCtrlC(state: CtrlCState, input: CtrlCInput, windowMs = armWindowMs): CtrlCStep {
  const live = state.kind === "armed" && input.at < state.expiresAt;
  if (input.kind === "press")
    return live
      ? { state: idle, effect: "fire" }
      : { state: { kind: "armed", expiresAt: input.at + windowMs }, effect: "arm" };
  if (state.kind === "armed" && !live) return { state: idle, effect: "disarm" };
  return { state, effect: "none" };
}

export interface CtrlCGuard {
  press(): void;
  isArmed(): boolean;
  subscribe(listener: () => void): () => void;
  dispose(): void;
}

export interface CtrlCGuardOptions {
  onFire: () => void;
  windowMs?: number;
  now?: () => number;
}

export function createCtrlCGuard({
  onFire,
  windowMs = armWindowMs,
  now = () => performance.now(),
}: CtrlCGuardOptions): CtrlCGuard {
  const listeners = new Set<() => void>();
  let state: CtrlCState = idle;
  let timer: ReturnType<typeof setTimeout> | null = null;

  function clearTimer(): void {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  }

  function apply(input: CtrlCInput): void {
    const step = stepCtrlC(state, input, windowMs);
    state = step.state;
    clearTimer();
    // Timers count from the event loop's cached time, so one can fire just before expiresAt; wait out the rest.
    if (state.kind === "armed")
      timer = setTimeout(
        () => {
          apply({ kind: "expire", at: now() });
        },
        Math.max(state.expiresAt - now(), 0),
      );
    if (step.effect === "fire") onFire();
    else if (step.effect !== "none") for (const listener of [...listeners]) listener();
  }

  return {
    press() {
      apply({ kind: "press", at: now() });
    },

    isArmed: () => state.kind === "armed",

    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    dispose() {
      clearTimer();
      listeners.clear();
    },
  };
}
