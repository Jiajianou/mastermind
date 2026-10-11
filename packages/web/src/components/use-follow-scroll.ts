import { useCallback, useLayoutEffect, useRef, useState } from "react";
import type { RefObject } from "react";

const bottomSlackPx = 24;

export interface FollowScroll<Element extends HTMLElement> {
  ref: RefObject<Element | null>;
  following: boolean;
  onScroll: () => void;
  follow: () => void;
}

const isAtBottom = (element: HTMLElement, height: number): boolean =>
  height - element.scrollTop - element.clientHeight <= bottomSlackPx;

// The element follows new content only if the reader was at its bottom before the content arrived: the live scroll
// position is compared with the height measured before this render, because a scroll the reader just made may not
// have fired its scroll event yet, and snapping back over it is what made a growing view jump.
export function useFollowScroll<Element extends HTMLElement>(): FollowScroll<Element> {
  const ref = useRef<Element>(null);
  const measuredHeight = useRef(0);
  const [following, setFollowing] = useState(true);

  useLayoutEffect(() => {
    const element = ref.current;
    if (element === null) return;
    if (isAtBottom(element, measuredHeight.current)) element.scrollTop = element.scrollHeight;
    measuredHeight.current = element.scrollHeight;
  });

  const onScroll = useCallback(() => {
    const element = ref.current;
    if (element === null) return;
    measuredHeight.current = element.scrollHeight;
    setFollowing(isAtBottom(element, element.scrollHeight));
  }, []);

  const follow = useCallback(() => {
    const element = ref.current;
    if (element !== null) {
      element.scrollTop = element.scrollHeight;
      measuredHeight.current = element.scrollHeight;
    }
    setFollowing(true);
  }, []);

  return { ref, following, onScroll, follow };
}
