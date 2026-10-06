import { z } from "zod";
import type { Page } from "@playwright/test";
import { expect, test } from "./harness.js";

const usageLimitLine = /^Usage limit reached; work resumes at \d\d:\d\d$/;

const shownSchema = z.array(z.object({ title: z.string(), body: z.string() }));

async function recordBrowserNotifications(page: Page): Promise<() => Promise<unknown>> {
  await page.addInitScript(() => {
    const shown: { title: string; body: string | undefined }[] = [];
    class RecordingNotification extends EventTarget {
      static readonly permission = "granted";
      static requestPermission = () => Promise.resolve("granted");
      constructor(title: string, options?: NotificationOptions) {
        super();
        shown.push({ title, body: options?.body });
      }
      close = () => undefined;
    }
    Object.defineProperty(window, "Notification", { value: RecordingNotification });
    Object.defineProperty(window, "shownNotifications", { value: shown });
  });
  await page.reload();
  return () => page.evaluate((): unknown => Reflect.get(window, "shownNotifications"));
}

test.use({
  scenario: {
    turns: [{ match: { role: "conductor", prompt: "hello" }, steps: [{ kind: "usageLimit" }] }],
  },
});

test("with a tab open, a usage-limit pause is a browser notification, not an OS one", async ({
  page,
  mastermind,
}) => {
  const shown = await recordBrowserNotifications(page);
  const input = page.getByRole("textbox", { name: "Message", exact: true });
  await expect(input).toBeEnabled();

  await input.fill("hello");
  await input.press("Enter");

  await expect(page.getByRole("log")).toContainText("Usage limit reached; work resumes at");
  await expect
    .poll(async () => shownSchema.parse(await shown()))
    .toEqual([
      { title: `mastermind · ${mastermind.project}`, body: expect.stringMatching(usageLimitLine) },
    ]);
  expect(await mastermind.nativeNotifications()).toEqual([]);
});

test("with no tab open, the OS shows the notification", async ({ page, mastermind }) => {
  await expect(page.getByRole("link", { name: "Running · Max" })).toBeVisible();
  await page.close();

  const response = await fetch(`${mastermind.origin}/api/chat`, {
    method: "POST",
    headers: { authorization: `Bearer ${mastermind.token}`, "content-type": "application/json" },
    body: JSON.stringify({ text: "hello" }),
  });
  expect(response.status).toBe(200);

  await expect.poll(() => mastermind.nativeNotifications(), { timeout: 15_000 }).toHaveLength(1);
  const [call] = await mastermind.nativeNotifications();
  expect(call?.args.slice(-2)).toEqual([
    `mastermind · ${mastermind.project}`,
    expect.stringMatching(usageLimitLine),
  ]);
});
