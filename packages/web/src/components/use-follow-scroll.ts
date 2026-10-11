import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { RefObject } from "react";

const bottomSlackPx = 24;

export interface FollowScroll<Element extends HTMLElement> {
  ref: RefObject<Element | null>;
  following: boolean;
  onScroll: () => void;
  follow: () => void;
}

interface Geometry {
  scrollHeight: number;
  clientHeight: number;
}

const geometryOf = (element: HTMLElement): Geometry => ({
  scrollHeight: element.scrollHeight,
  clientHeight: element.clientHeight,
});

// The element follows new content only if the reader was at its bottom before the content arrived. That is judged
// from the size measured before the change with the live scroll position, because a scroll the reader just made may
// not have fired its scroll event yet, and snapping back over it is what made a growing view jump. The element's
// own height counts as measured too: it changes without a scroll when the composer below it grows.
export function useFollowScroll<Element extends HTMLElement>(): FollowScroll<Element> {
  const ref = useRef<Element>(null);
  const measured = useRef<Geometry>({ scrollHeight: 0, clientHeight: 0 });
  const [following, setFollowing] = useState(true);

  const keepUp = useCallback(() => {
    const element = ref.current;
    if (element === null) return;
    const { scrollHeight, clientHeight } = measured.current;
    if (scrollHeight - element.scrollTop - clientHeight <= bottomSlackPx)
      element.scrollTop = element.scrollHeight;
    measured.current = geometryOf(element);
  }, []);

  useLayoutEffect(keepUp);

  useEffect(() => {
    const element = ref.current;
    if (element === null) return;
    const observer = new ResizeObserver(keepUp);
    observer.observe(element);
    for (const child of element.children) observer.observe(child);
    return () => {
      observer.disconnect();
    };
  }, [keepUp]);

  const onScroll = useCallback(() => {
    const element = ref.current;
    if (element === null) return;
    measured.current = geometryOf(element);
    setFollowing(element.scrollHeight - element.scrollTop - element.clientHeight <= bottomSlackPx);
  }, []);

  const follow = useCallback(() => {
    const element = ref.current;
    if (element !== null) {
      element.scrollTop = element.scrollHeight;
      measured.current = geometryOf(element);
    }
    setFollowing(true);
  }, []);

  return { ref, following, onScroll, follow };
}
