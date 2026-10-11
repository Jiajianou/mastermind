// jsdom lays nothing out, so nothing ever resizes; components that watch sizes get an observer that stays quiet.
class QuietResizeObserver implements ResizeObserver {
  observe = (): undefined => undefined;
  unobserve = (): undefined => undefined;
  disconnect = (): undefined => undefined;
}

globalThis.ResizeObserver = QuietResizeObserver;
