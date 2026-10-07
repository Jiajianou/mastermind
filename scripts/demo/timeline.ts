import type { Frame } from "./gif.js";

export interface CapturedFrame {
  file: string;
  at: number;
}

export interface Cut {
  from: number;
  to: number;
}

export function buildTimeline(
  captured: readonly CapturedFrame[],
  cuts: readonly Cut[],
  start: number,
): Frame[] {
  const shift = (at: number): number =>
    cuts.reduce((removed, cut) => removed + Math.max(0, Math.min(at, cut.to) - cut.from), 0);
  const frames = captured
    .filter(({ at }) => at >= start)
    .map(({ file, at }) => ({ file, seconds: (at - start - shift(at)) / 1000 }));
  return frames.filter((frame, index) => frames[index + 1]?.seconds !== frame.seconds);
}
