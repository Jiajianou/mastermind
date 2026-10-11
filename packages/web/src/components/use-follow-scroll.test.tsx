import { cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useFollowScroll } from "./use-follow-scroll.js";

// jsdom lays nothing out, so the pane's size and scroll position are played by hand, the way a browser would report
// them: scrollTop never goes past the bottom.
const pane = { scrollHeight: 0, clientHeight: 0, scrollTop: 0 };
const geometry = ["scrollHeight", "clientHeight", "scrollTop"] as const;
const originals = geometry.map(
  (name) => [name, Object.getOwnPropertyDescriptor(Element.prototype, name)] as const,
);

function Pane({ lines }: { lines: number }) {
  const { ref, onScroll } = useFollowScroll<HTMLDivElement>();
  return (
    <div ref={ref} onScroll={onScroll}>
      {Array.from({ length: lines }, (_, index) => (
        <p key={index}>line {index}</p>
      ))}
    </div>
  );
}

const bottom = () => pane.scrollHeight - pane.clientHeight;

beforeEach(() => {
  Object.assign(pane, { scrollHeight: 554, clientHeight: 554, scrollTop: 0 });
  Object.defineProperty(Element.prototype, "scrollHeight", {
    configurable: true,
    get: () => pane.scrollHeight,
  });
  Object.defineProperty(Element.prototype, "clientHeight", {
    configurable: true,
    get: () => pane.clientHeight,
  });
  Object.defineProperty(Element.prototype, "scrollTop", {
    configurable: true,
    get: () => pane.scrollTop,
    set: (value: number) => {
      pane.scrollTop = Math.max(0, Math.min(value, bottom()));
    },
  });
});

afterEach(() => {
  cleanup();
  for (const [name, descriptor] of originals)
    if (descriptor !== undefined) Object.defineProperty(Element.prototype, name, descriptor);
});

describe("following the bottom of a growing pane", () => {
  it("keeps following when the pane got shorter without a scroll, as when the composer below it grows", () => {
    const view = render(<Pane lines={0} />);

    pane.clientHeight = 502;
    pane.scrollHeight = 5646;
    view.rerender(<Pane lines={60} />);

    expect(pane.scrollTop).toBe(5144);
  });

  it("stays where the reader scrolled to, even before their scroll event arrives", () => {
    const view = render(<Pane lines={0} />);
    pane.scrollHeight = 2000;
    view.rerender(<Pane lines={20} />);
    expect(pane.scrollTop).toBe(bottom());

    pane.scrollTop -= 300;
    const parked = pane.scrollTop;
    pane.scrollHeight = 2400;
    view.rerender(<Pane lines={24} />);

    expect(pane.scrollTop).toBe(parked);
  });
});
