import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { armWindowMs, createCtrlCGuard, stepCtrlC } from "./ctrl-c.js";
import type { CtrlCEffect, CtrlCInput, CtrlCState } from "./ctrl-c.js";

describe("the two-press Ctrl+C machine", () => {
  const armedUntil = (expiresAt: number): CtrlCState => ({ kind: "armed", expiresAt });
  const idle: CtrlCState = { kind: "idle" };

  it.each<[string, CtrlCState, CtrlCInput, CtrlCState, CtrlCEffect]>([
    ["a first press arms it", idle, { kind: "press", at: 0 }, armedUntil(2_000), "arm"],
    [
      "a press within the window fires",
      armedUntil(2_000),
      { kind: "press", at: 1_999 },
      idle,
      "fire",
    ],
    [
      "a press after the window arms it again",
      armedUntil(2_000),
      { kind: "press", at: 2_000 },
      armedUntil(4_000),
      "arm",
    ],
    ["the timeout disarms it", armedUntil(2_000), { kind: "expire", at: 2_000 }, idle, "disarm"],
    [
      "an early timeout is ignored",
      armedUntil(4_000),
      { kind: "expire", at: 2_000 },
      armedUntil(4_000),
      "none",
    ],
    ["a timeout while idle does nothing", idle, { kind: "expire", at: 5_000 }, idle, "none"],
  ])("%s", (_name, state, input, nextState, effect) => {
    expect(stepCtrlC(state, input)).toEqual({ state: nextState, effect });
  });

  describe("driven by timers", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    function guardWithLog(now = () => Date.now()) {
      const onFire = vi.fn();
      const guard = createCtrlCGuard({ onFire, now });
      const armedStates: boolean[] = [];
      guard.subscribe(() => armedStates.push(guard.isArmed()));
      return { guard, onFire, armedStates };
    }

    it("fires on a second press within 2 seconds, and only then", () => {
      const { guard, onFire, armedStates } = guardWithLog();

      guard.press();
      vi.advanceTimersByTime(armWindowMs - 1);
      expect(onFire).not.toHaveBeenCalled();
      guard.press();

      expect(onFire).toHaveBeenCalledOnce();
      expect(armedStates).toEqual([true]);
    });

    it("disarms itself after 2 seconds, so a later press only arms it again", () => {
      const { guard, onFire, armedStates } = guardWithLog();

      guard.press();
      vi.advanceTimersByTime(armWindowMs);
      expect(guard.isArmed()).toBe(false);
      guard.press();
      vi.advanceTimersByTime(armWindowMs + 500);

      expect(onFire).not.toHaveBeenCalled();
      expect(armedStates).toEqual([true, false, true, false]);
    });

    it("still disarms when its timer fires before the window has fully passed", () => {
      const lagMs = 30;
      let pressSeenLate = true;
      const { guard, armedStates } = guardWithLog(() => Date.now() + (pressSeenLate ? lagMs : 0));

      guard.press();
      pressSeenLate = false;
      vi.advanceTimersByTime(armWindowMs);
      expect(guard.isArmed()).toBe(true);
      vi.advanceTimersByTime(lagMs);

      expect(armedStates).toEqual([true, false]);
    });
  });
});
