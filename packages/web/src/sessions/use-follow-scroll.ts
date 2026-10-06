import { useCallback, useLayoutEffect, useRef, useState } from "react";
import type { RefObject } from "react";

const bottomSlackPx = 24;

export interface FollowScroll<Element extends HTMLElement> {
  ref: RefObject<Element | null>;
  following: boolean;
  onScroll: () => void;
  follow: () => void;
}

export function useFollowScroll<Element extends HTMLElement>(
  content: unknown,
): FollowScroll<Element> {
  const ref = useRef<Element>(null);
  const [following, setFollowing] = useState(true);

  useLayoutEffect(() => {
    const element = ref.current;
    if (following && element !== null) element.scrollTop = element.scrollHeight;
  }, [content, following]);

  const onScroll = useCallback(() => {
    const element = ref.current;
    if (element === null) return;
    const distance = element.scrollHeight - element.scrollTop - element.clientHeight;
    setFollowing(distance <= bottomSlackPx);
  }, []);

  const follow = useCallback(() => {
    setFollowing(true);
  }, []);

  return { ref, following, onScroll, follow };
}
