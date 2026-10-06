import type { OwnerNotification } from "@mastermind/core/contracts";
import { decidePath } from "../decide/task-state.js";
import { tasksPath } from "../tasks/location.js";

export type BrowserPermission = NotificationPermission | "unsupported";

const askedKey = "mastermind.notifications.asked";

const supported = (): boolean => "Notification" in globalThis;

export const notificationPermission = (): BrowserPermission =>
  supported() ? Notification.permission : "unsupported";

export function notificationPath({ reason, taskId }: OwnerNotification): string {
  switch (reason) {
    case "blocked":
      return taskId === null ? "/tasks" : tasksPath({ task: taskId });
    case "review":
      return taskId === null ? "/review" : decidePath(taskId);
    case "sign_in":
      return "/";
    case "usage_limit":
      return "/overview";
  }
}

export async function requestNotificationPermission(): Promise<BrowserPermission> {
  if (notificationPermission() !== "default") return notificationPermission();
  localStorage.setItem(askedKey, "yes");
  return Notification.requestPermission();
}

// Browsers keep a dismissed prompt at "default", so a flag stops the page from asking on every visit.
export async function askNotificationPermissionOnce(): Promise<void> {
  if (localStorage.getItem(askedKey) !== null) return;
  await requestNotificationPermission();
}

export function showNotification(
  notification: OwnerNotification,
  open: (path: string) => void,
): void {
  if (notificationPermission() !== "granted") return;
  const shown = new Notification(notification.title, {
    body: notification.body,
    tag: `mastermind-${String(notification.id)}`,
  });
  shown.addEventListener("click", () => {
    window.focus();
    open(notificationPath(notification));
    shown.close();
  });
}
