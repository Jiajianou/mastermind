import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { chromium } from "@playwright/test";
import type { CDPSession, Locator, Page } from "@playwright/test";
import type { Frame } from "./gif.js";
import { demoGoal, demoProject } from "./scenario.js";
import { buildTimeline } from "./timeline.js";
import type { CapturedFrame, Cut } from "./timeline.js";

const viewport = { width: 1280, height: 800 };
const slowStep = { timeout: 90_000 };

function installCursor(): void {
  const show = (): void => {
    const cursor = document.createElement("div");
    cursor.style.cssText =
      "position:fixed;left:-40px;top:-40px;z-index:2147483647;pointer-events:none;transition:transform 80ms ease-out;transform-origin:2px 2px";
    cursor.innerHTML =
      '<svg width="22" height="26" viewBox="0 0 22 26"><path d="M2 2 L2 21 L7 16.5 L10.5 24 L14 22.5 L10.5 15 L17.5 15 Z" fill="#fff" stroke="#111" stroke-width="1.6" stroke-linejoin="round"/></svg>';
    document.body.append(cursor);
    const follow = (event: MouseEvent): void => {
      cursor.style.left = `${String(event.clientX)}px`;
      cursor.style.top = `${String(event.clientY)}px`;
    };
    document.addEventListener("mousemove", follow, true);
    document.addEventListener("mousedown", () => (cursor.style.transform = "scale(0.82)"), true);
    document.addEventListener("mouseup", () => (cursor.style.transform = ""), true);
  };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", show);
  else show();
}

class Director {
  readonly cuts: Cut[] = [];

  constructor(readonly page: Page) {}

  async dwell(ms: number): Promise<void> {
    await this.page.waitForTimeout(ms);
  }

  async click(target: Locator): Promise<void> {
    await target.waitFor({ state: "visible", ...slowStep });
    await target.scrollIntoViewIfNeeded();
    const box = await target.boundingBox();
    if (box === null) throw new Error(`Cannot find where to click: ${target.toString()}`);
    await this.page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 24 });
    await this.dwell(250);
    await target.click();
  }

  async type(target: Locator, text: string): Promise<void> {
    await this.click(target);
    await target.pressSequentially(text, { delay: 32 });
  }

  async skipUntil(target: Locator): Promise<void> {
    const from = Date.now();
    await target.waitFor({ state: "visible", ...slowStep });
    const to = Date.now() - 300;
    if (to > from) this.cuts.push({ from, to });
  }

  screen(name: string): Locator {
    return this.page.getByRole("navigation", { name: "Screens" }).getByRole("link", { name });
  }
}

async function tour(director: Director): Promise<void> {
  const { page } = director;
  const log = page.getByRole("log");

  await director.dwell(1200);
  const setup = page.getByRole("region", { name: "Build and test commands" });
  await director.click(setup.getByRole("button", { name: "Use these" }));
  await director.dwell(900);

  await director.type(page.getByRole("textbox", { name: "Message", exact: true }), demoGoal);
  await director.dwell(400);
  await page.keyboard.press("Enter");
  await log.getByText("Press Start when it looks right.").waitFor(slowStep);
  await director.dwell(2600);
  await director.click(
    page.getByRole("region", { name: "Plan" }).getByRole("button", { name: "Start" }),
  );

  await director.skipUntil(page.getByRole("link", { name: /^2 working/ }));
  await director.dwell(1200);
  await director.click(director.screen("Overview"));
  await director.dwell(3000);

  await director.click(director.screen("Tasks"));
  await director.dwell(800);
  await director.click(page.getByRole("tab", { name: "Graph" }));
  await director.dwell(2500);

  await director.click(director.screen("Review"));
  const ready = page.getByRole("navigation", { name: "Ready for review" });
  await director.skipUntil(ready.getByRole("link", { name: "health" }));
  await director.dwell(600);
  await director.click(ready.getByRole("link", { name: "health" }));
  await page
    .getByRole("heading", { level: 1, name: "Ready for review · round 1" })
    .waitFor(slowStep);
  await director.dwell(3500);
  await director.click(page.getByRole("button", { name: "Approve and rebase" }));
  await director.skipUntil(page.getByRole("heading", { level: 1, name: "Rebased onto main" }));
  await director.dwell(1500);

  await director.click(director.screen("Chat"));
  await director.skipUntil(page.getByRole("link", { name: /3 of 3 done/ }));
  await director.dwell(1000);
  await director.click(director.screen("Tasks"));
  await director.dwell(1200);
}

class FrameCapture {
  readonly frames: CapturedFrame[] = [];
  private readonly pending: Promise<void>[] = [];
  private readonly failures: unknown[] = [];

  constructor(
    private readonly cdp: CDPSession,
    private readonly frameDir: string,
  ) {
    cdp.on("Page.screencastFrame", ({ data, sessionId }) => {
      const file = join(frameDir, `frame-${String(this.frames.length).padStart(5, "0")}.png`);
      this.frames.push({ file, at: Date.now() });
      this.track(writeFile(file, data, "base64"));
      this.track(cdp.send("Page.screencastFrameAck", { sessionId }));
    });
  }

  private track(work: Promise<unknown>): void {
    this.pending.push(
      work.then(
        () => undefined,
        (error: unknown) => {
          this.failures.push(error);
        },
      ),
    );
  }

  async start(): Promise<void> {
    await this.cdp.send("Page.startScreencast", {
      format: "png",
      maxWidth: viewport.width,
      maxHeight: viewport.height,
    });
  }

  async stop(): Promise<CapturedFrame[]> {
    await this.cdp.send("Page.stopScreencast");
    await Promise.all(this.pending);
    if (this.failures.length > 0)
      throw new AggregateError(this.failures, `Could not save frames to ${this.frameDir}`);
    return this.frames;
  }
}

export async function recordTour(link: string, frameDir: string): Promise<Frame[]> {
  const browser = await chromium.launch();
  try {
    const context = await browser.newContext({ viewport, deviceScaleFactor: 1 });
    await context.addInitScript(installCursor);
    const page = await context.newPage();
    await page.goto(link);
    await page.getByRole("heading", { name: `What should we build in ${demoProject}?` }).waitFor();
    await page.getByRole("link", { name: "Running · Max" }).waitFor();
    await page.mouse.move(viewport.width * 0.6, viewport.height * 0.45);

    const capture = new FrameCapture(await context.newCDPSession(page), frameDir);
    const start = Date.now();
    await capture.start();
    const director = new Director(page);
    await tour(director);
    return buildTimeline(await capture.stop(), director.cuts, start);
  } finally {
    await browser.close();
  }
}
