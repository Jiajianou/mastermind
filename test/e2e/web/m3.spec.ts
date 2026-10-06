import type { Locator, Page } from "@playwright/test";
import type { Step } from "../../support/fake-claude.js";
import { expect, test } from "./harness.js";

function createTask(id: string): Step {
  return {
    kind: "mcp",
    tool: "create_tasks",
    arguments: {
      tasks: [
        {
          id,
          title: `Create ${id}.txt`,
          goal: `Add ${id}.txt with a greeting.`,
          acceptance: `test -f ${id}.txt`,
          touches: [`${id}.txt`],
        },
      ],
    },
  };
}

// The Conductor is the first session and alpha's worker the second, so the fake Conductor can name alpha's
// session the way the real one would after reading list_sessions. The first test checks alpha's link before relying on it.
const alphaSessionId = 2;
const workerStartup = { timeout: 15_000 };

test.use({
  scenario: {
    turns: [
      {
        match: { role: "conductor", prompt: "add alpha" },
        steps: [createTask("alpha"), { kind: "text", text: "I added **alpha**." }],
      },
      {
        match: { role: "conductor", prompt: "add beta" },
        steps: [createTask("beta"), { kind: "text", text: "I added **beta**." }],
      },
      {
        match: {
          role: "conductor",
          prompt: {
            pattern:
              "Running: alpha \\(worker, attempt 1, \\d+m\\), beta \\(worker, attempt 1, \\d+m\\)[\\s\\S]*what's running\\?$",
          },
        },
        steps: [
          { kind: "mcp", tool: "list_sessions" },
          { kind: "text", text: "Workers are on alpha and beta." },
        ],
      },
      {
        match: { role: "conductor", prompt: "stop alpha" },
        steps: [
          { kind: "mcp", tool: "stop_session", arguments: { sessionId: alphaSessionId } },
          { kind: "text", text: "I stopped alpha. beta carries on." },
        ],
      },
      {
        match: { role: "worker" },
        steps: [
          { kind: "read", path: "README.md" },
          { kind: "bash", command: "echo working" },
          { kind: "hang" },
        ],
      },
    ],
  },
});

const screens = (page: Page) => page.getByRole("navigation", { name: "Screens" });
const statusPill = (page: Page, text: string) => page.getByRole("link", { name: text });

async function say(page: Page, message: string): Promise<void> {
  const input = page.getByRole("textbox", { name: "Message" });
  await expect(input).toBeEnabled();
  await input.fill(message);
  await input.press("Enter");
}

test("tasks are created, watched and one is stopped through the chat without a page reload", async ({
  page,
  mastermind,
}) => {
  await expect(
    page.getByRole("heading", { name: `What should we build in ${mastermind.project}?` }),
  ).toBeVisible();
  const marker = crypto.randomUUID();
  await page.evaluate((value) => Reflect.set(window, "m3Marker", value), marker);
  const log = page.getByRole("log");

  await say(page, "Please add alpha");
  await expect(log).toContainText("I added alpha.");
  await expect(statusPill(page, "1 working · 0 needs you · 0 of 1 done")).toBeVisible(
    workerStartup,
  );
  await say(page, "Now add beta");
  await expect(log).toContainText("I added beta.");
  await expect(statusPill(page, "2 working · 0 needs you · 0 of 2 done")).toBeVisible(
    workerStartup,
  );
  await expect(log.locator(".action-line")).toHaveText(["✓ Added 1 task", "✓ Added 1 task"]);

  await say(page, "what's running?");
  await expect(log).toContainText("Workers are on alpha and beta.");

  await statusPill(page, "2 working · 0 needs you · 0 of 2 done").click();
  const active = page.getByRole("region", { name: "Active sessions" });
  for (const id of ["alpha", "beta"]) {
    const card = active.getByRole("article", { name: id });
    await expect(card).toContainText("Worker");
    await expect(card.locator(".latest-action")).toContainText("echo working");
  }
  const alphaActivity = active
    .getByRole("article", { name: "alpha" })
    .getByRole("link", { name: "Activity" });
  await expect(alphaActivity).toHaveAttribute(
    "href",
    `/sessions?session=${String(alphaSessionId)}`,
  );
  await alphaActivity.click();
  await expect(page.locator(".session-header")).toContainText("alpha");
  await expect(page.getByRole("region", { name: "Timeline" })).toContainText("echo working");

  await screens(page).getByRole("link", { name: "Chat" }).click();
  await say(page, "Please stop alpha");

  await expect(log).toContainText("I stopped alpha. beta carries on.");
  await expect(log.locator(".action-line").last()).toHaveText(
    `✓ Stopped session ${String(alphaSessionId)}`,
  );
  await expect(statusPill(page, "1 working · 0 needs you · 0 of 2 done")).toBeVisible();

  await screens(page).getByRole("link", { name: "Overview" }).click();
  await expect(active.getByRole("article")).toHaveCount(1);
  await expect(active.getByRole("article", { name: "beta" })).toBeVisible();
  await expect(page.getByRole("region", { name: "Up next" })).toContainText("alpha Held");

  await screens(page).getByRole("link", { name: "Sessions" }).click();
  const sessionList = page.getByRole("navigation", { name: "Session list" });
  await sessionList.getByRole("link", { name: /alpha/ }).click();
  await expect(page.locator(".session-header")).toContainText("Stopped");
  await expect(sessionList.getByRole("link", { name: /beta/ })).toContainText("Running");

  expect(await page.evaluate((): unknown => Reflect.get(window, "m3Marker"))).toBe(marker);
});

async function tabTo(page: Page, target: Locator): Promise<void> {
  for (let presses = 0; presses < 60; presses += 1) {
    await page.keyboard.press("Tab");
    if (await target.evaluate((element) => element === document.activeElement)) return;
  }
  throw new Error(`Tab never reached ${target.toString()}`);
}

async function expectFocusRing(target: Locator): Promise<void> {
  const ringed = await target.evaluate((element) => {
    for (let node: Element | null = element; node !== null; node = node.parentElement) {
      if (getComputedStyle(node).outlineStyle !== "none") return true;
    }
    return false;
  });
  expect(ringed).toBe(true);
}

async function activateByKeyboard(page: Page, target: Locator, key: "Enter" | " "): Promise<void> {
  await tabTo(page, target);
  await expectFocusRing(target);
  await page.keyboard.press(key);
}

const unnamedControl = /^\s*- (button|link|textbox|combobox|checkbox|radio|switch|option)(?! ")/;

async function expectAccessibleScreen(page: Page): Promise<void> {
  const buttons = await page
    .getByRole("button")
    .evaluateAll((elements) => elements.map((element) => element.tagName));
  expect(buttons.filter((tag) => tag !== "BUTTON")).toEqual([]);

  const links = await page
    .getByRole("link")
    .evaluateAll((elements) =>
      elements
        .filter((element) => !(element instanceof HTMLAnchorElement && element.href !== ""))
        .map((element) => element.outerHTML),
    );
  expect(links).toEqual([]);

  const snapshot = await page.locator("body").ariaSnapshot();
  expect(snapshot.split("\n").filter((line) => unnamedControl.test(line))).toEqual([]);

  const { painted, colourWithoutWord } = await page.evaluate(() => {
    const statusColours = ["rgb(136, 192, 208)", "rgb(232, 163, 124)"];
    const hasText = (element: Element | null) => (element?.textContent ?? "").trim() !== "";
    const paintedElements = [...document.querySelectorAll("body *")]
      .filter((element) => element.checkVisibility())
      .filter((element) => {
        const style = getComputedStyle(element);
        const borders = ["top", "right", "bottom", "left"]
          .filter((side) => parseFloat(style.getPropertyValue(`border-${side}-width`)) > 0)
          .map((side) => style.getPropertyValue(`border-${side}-color`));
        return [style.backgroundColor, style.boxShadow, ...borders].some((paint) =>
          statusColours.some((colour) => paint.includes(colour)),
        );
      });
    return {
      painted: paintedElements.length,
      colourWithoutWord: paintedElements
        .filter((element) => !hasText(element) && !hasText(element.parentElement))
        .map((element) => element.outerHTML),
    };
  });
  expect(painted).toBeGreaterThan(0);
  expect(colourWithoutWord).toEqual([]);
}

test("Chat, Overview and Sessions use real labelled controls, work from the keyboard and pair colours with words", async ({
  page,
  mastermind,
}) => {
  await expect(page.getByRole("link", { name: "Running · Max" })).toBeVisible();
  await expect(page.getByRole("banner")).toContainText(mastermind.project);
  await expectAccessibleScreen(page);

  const message = page.getByRole("textbox", { name: "Message" });
  await tabTo(page, message);
  await expectFocusRing(message);
  await page.keyboard.type("Please add alpha");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("log")).toContainText("I added alpha.");
  await expect(statusPill(page, "1 working · 0 needs you · 0 of 1 done")).toBeVisible(
    workerStartup,
  );
  await expectAccessibleScreen(page);

  await activateByKeyboard(page, screens(page).getByRole("link", { name: "Overview" }), "Enter");
  const card = page.getByRole("article", { name: "alpha" });
  await expect(card.locator(".latest-action")).toContainText("echo working");
  const tiles = page.getByRole("list", { name: "Task counts" }).getByRole("listitem");
  await expect(tiles).toHaveText(["0Remaining", "1Running", "0Done", "0Blocked"]);
  await expectAccessibleScreen(page);

  await activateByKeyboard(page, card.getByRole("link", { name: "Activity" }), "Enter");
  await expect(page.getByRole("region", { name: "Timeline" })).toContainText("echo working");
  const sessionList = page.getByRole("navigation", { name: "Session list" });
  await expect(sessionList.getByRole("link", { name: /alpha/ })).toContainText("Running");
  await expectAccessibleScreen(page);

  await activateByKeyboard(page, page.getByRole("button", { name: "Stop session" }), " ");
  await expect(page.locator(".session-header")).toContainText("Stopped");
  await expect(sessionList.getByRole("link", { name: /alpha/ })).toContainText("Stopped");
  await expectAccessibleScreen(page);

  await activateByKeyboard(page, screens(page).getByRole("link", { name: "Overview" }), "Enter");
  await expect(page.getByRole("region", { name: "Up next" })).toContainText("alpha Held");
  await expectAccessibleScreen(page);
});
