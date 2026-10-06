import { useState } from "react";
import { notificationPermission, requestNotificationPermission } from "../notifications/browser.js";
import type { BrowserPermission } from "../notifications/browser.js";
import { CheckField } from "./fields.js";

const permissionHints: Record<BrowserPermission, string> = {
  granted: "This browser shows them while a mastermind tab is open; otherwise your desktop does.",
  default: "This browser will ask once whether mastermind may show them.",
  denied:
    "This browser blocks notifications from mastermind, so allow them in its site settings to see them here. With no tab open, your desktop shows them.",
  unsupported: "This browser can't show notifications, so your desktop shows them.",
};

export function NotificationsField({
  checked,
  onChange,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  const [permission, setPermission] = useState(notificationPermission);

  return (
    <CheckField
      label="Desktop notifications when something needs you"
      hint={`Blocked tasks, sign-in, protected tasks waiting for review and usage-limit pauses. ${permissionHints[permission]}`}
      checked={checked}
      onChange={(enabled) => {
        onChange(enabled);
        if (!enabled) return;
        requestNotificationPermission().then(setPermission, (error: unknown) => {
          console.error("could not ask for notification permission", error);
        });
      }}
    />
  );
}
