import { useEffect, useRef } from "react";
import { useNavigate } from "react-router";
import { useLive } from "../store/hooks.js";
import { askNotificationPermissionOnce, showNotification } from "./browser.js";

// Browsers only show the permission prompt after a click or key press, so the one request waits for the first.
function useAskOnFirstInteraction(enabled: boolean): void {
  useEffect(() => {
    if (!enabled) return;
    const ask = () => {
      stop();
      askNotificationPermissionOnce().catch((error: unknown) => {
        console.error("could not ask for notification permission", error);
      });
    };
    const stop = () => {
      window.removeEventListener("pointerdown", ask);
      window.removeEventListener("keydown", ask);
    };
    window.addEventListener("pointerdown", ask);
    window.addEventListener("keydown", ask);
    return stop;
  }, [enabled]);
}

export function DesktopNotifications() {
  const enabled = useLive((state) => state.config?.notifications.desktop ?? false);
  const notification = useLive((state) => state.notification);
  const navigate = useNavigate();
  const shownId = useRef<number | null>(null);
  useAskOnFirstInteraction(enabled);

  useEffect(() => {
    if (notification === null || shownId.current === notification.id) return;
    shownId.current = notification.id;
    showNotification(notification, (path) => void navigate(path));
  }, [notification, navigate]);

  return null;
}
