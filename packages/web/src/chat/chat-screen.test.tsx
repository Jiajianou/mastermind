import { actionRoutes } from "@mastermind/core/contracts";
import type { ChatMessage, Proposal, QuestionOption, StepMeta } from "@mastermind/core/contracts";
import { act, cleanup, render, screen, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApiClient } from "../api/client.js";
import { ChatScreen } from "../screens/ChatScreen.js";
import { LiveProvider } from "../store/hooks.js";
import type { LiveState } from "../store/state.js";
import { createStore } from "../store/store.js";
import { at, config, conversation, message, stateWith, task } from "../testing/fixtures.js";

interface Request {
  method: string;
  path: string;
  body: unknown;
}

vi.mock("./highlight.js", () => ({
  colorize: (code: string, fence: string) =>
    Promise.resolve(`<span class="token-${fence}">${code.replaceAll("<", "&lt;")}</span>`),
}));

const requests: Request[] = [];

const holdProposal = (status: Proposal["status"]): Proposal => ({
  id: 5,
  ts: at(5),
  action: "hold",
  args: { taskId: "alpha" },
  status,
  decidedAt: status === "pending" ? null : at(6),
  result: null,
});

function serveActions(): void {
  vi.stubGlobal("fetch", (path: string, init: RequestInit) => {
    const body: unknown = typeof init.body === "string" ? JSON.parse(init.body) : null;
    requests.push({ method: init.method ?? "GET", path, body });
    if (path === "/api/pause")
      return Promise.resolve(
        Response.json({ paused: true, authRequired: false, backoffResumeAt: null }),
      );
    if (path === "/api/proposals/5/reject")
      return Promise.resolve(Response.json(holdProposal("rejected")));
    if (path === "/api/plans/3/start")
      return Promise.resolve(Response.json([task("lexer"), task("parser", { deps: ["lexer"] })]));
    if (path === "/api/conversations")
      return Promise.resolve(
        Response.json({
          model: "opus",
          replying: false,
          conversationId: 4,
          conversations: [conversation(4), ...conversations],
          messages: [],
        }),
      );
    if (path === "/api/conversations/3/open")
      return Promise.resolve(
        Response.json({
          model: "opus",
          replying: false,
          conversationId: 3,
          conversations,
          messages: [message(7, { conversationId: 3, content: "how should sync work?" })],
        }),
      );
    if (path === "/api/chat")
      return Promise.resolve(
        Response.json({
          turnId: "turn-2",
          message: message(20, { kind: "user", content: "sent", turnId: "turn-2" }),
        }),
      );
    return Promise.reject(new TypeError(`no stub for ${path}`));
  });
}

function renderChat(state: Partial<LiveState> = {}) {
  const store = createStore(stateWith({ config: config("opus"), ...state }));
  render(
    <LiveProvider store={store} api={createApiClient("8f3c2a91".repeat(8))}>
      <MemoryRouter>
        <ChatScreen />
      </MemoryRouter>
    </LiveProvider>,
  );
  return store;
}

const question = (
  id: number,
  text: string,
  options: QuestionOption[],
  { header = null, multiSelect = false }: { header?: string | null; multiSelect?: boolean } = {},
): ChatMessage =>
  message(id, {
    kind: "question",
    content: text,
    meta: { header, options, multiSelect },
    turnId: "t",
  });

const conversations = [
  conversation(1, { title: "Plan a password manager", lastActivityAt: at(20) }),
  conversation(3, { title: "Sync design", lastActivityAt: at(10) }),
];

const chatWith = (messages: ChatMessage[], replying = false): LiveState["chat"] => ({
  model: "opus",
  replying,
  conversationId: 1,
  conversations,
  messages,
  drafts: {},
  activity: null,
});

afterEach(() => {
  cleanup();
  requests.length = 0;
  vi.unstubAllGlobals();
});

describe("chat screen", () => {
  it("assembles a streamed reply, then shows the stored reply once with its action line", () => {
    const question = message(1, { content: "add two tasks", turnId: "turn-1" });
    const store = renderChat({ chat: chatWith([question]) });

    act(() => {
      store.dispatch({ type: "chat.turn", turnId: "turn-1", replying: true });
      store.dispatch({ type: "chat.delta", turnId: "turn-1", text: "Adding **two" });
    });
    expect(screen.getByRole("button", { name: "Stop" })).toBeDefined();
    act(() => {
      store.dispatch({ type: "chat.delta", turnId: "turn-1", text: " tasks** now." });
    });
    expect(screen.getByRole("log").textContent).toContain("Adding two tasks now.");
    expect(screen.getByText("two tasks").tagName).toBe("STRONG");

    act(() => {
      store.dispatch({
        type: "chat.message",
        message: message(2, {
          kind: "conductor",
          content: "Adding **two tasks** now.",
          turnId: "turn-1",
        }),
      });
      store.dispatch({
        type: "chat.message",
        message: message(3, { kind: "action", content: "✓ Added 2 tasks", turnId: "turn-1" }),
      });
      store.dispatch({ type: "chat.turn", turnId: "turn-1", replying: false });
    });

    expect(screen.getAllByText("two tasks")).toHaveLength(1);
    expect(screen.getByText("✓ Added 2 tasks").className).toBe("action-line");
    expect(screen.getByRole("button", { name: "Send" })).toBeDefined();
  });

  it("shows what a running reply is doing until its text streams in, and clears it when the turn ends", () => {
    const store = renderChat({ chat: chatWith([message(1, { turnId: "turn-1" })]) });
    const progress = () => screen.queryByRole("status")?.textContent ?? null;

    act(() => {
      store.dispatch({ type: "chat.turn", turnId: "turn-1", replying: true });
    });
    expect(progress()).toMatch(/^✻Thinking…\(\d+s\)$/);

    act(() => {
      store.dispatch({ type: "chat.activity", turnId: "turn-1", text: "Reading src/app.ts" });
    });
    expect(progress()).toMatch(/^✻Reading src\/app\.ts…/);

    act(() => {
      store.dispatch({ type: "chat.delta", turnId: "turn-1", text: "Found it." });
    });
    expect(progress()).toMatch(/^✻Writing…/);

    act(() => {
      store.dispatch({ type: "chat.turn", turnId: "turn-1", replying: false });
    });
    expect(progress()).toBeNull();
  });

  it("shows each step mastermind took with its outcome, and the detail behind it on demand", () => {
    const step = (id: number, content: string, meta: StepMeta) =>
      message(id, { kind: "step", content, meta, turnId: "t" });
    renderChat({
      chat: chatWith([
        message(1, { content: "what's in a.ts?", turnId: "t" }),
        step(2, "Thought for 4s", { step: "thinking", status: "done", detail: null }),
        step(3, "Read src/a.ts", { step: "tool", status: "done", detail: "1\tconst a = 1;" }),
        step(4, "Hold lexer", { step: "tool", status: "failed", detail: "no such task" }),
        step(5, "Checking the project", { step: "tool", status: "running", detail: null }),
      ]),
    });

    const log = screen.getByRole("log");
    expect(within(log).getByText("Thought for 4s")).toBeDefined();
    expect(within(log).getByText("Read src/a.ts").closest("details")?.textContent).toContain(
      "const a = 1;",
    );
    expect(within(log).getByText("Hold lexer").closest("details")?.textContent).toContain(
      "(failed)",
    );
    expect(within(log).getByText("Checking the project").parentElement?.textContent).toContain(
      "(in progress)",
    );
  });

  it("answers a question with one click, then shows the answer instead of the choices", async () => {
    serveActions();
    const store = renderChat({
      chat: chatWith([
        message(1, { turnId: "t" }),
        question(2, "What should we build first?", [
          { label: "Browser extension (recommended)", description: "Fill passwords in place." },
          { label: "Desktop app" },
        ]),
      ]),
    });
    const card = screen.getByRole("region", { name: "Question" });
    expect(within(card).getByText("Recommended")).toBeDefined();

    await userEvent.setup().click(within(card).getByRole("button", { name: /Browser extension/ }));

    const answers = [{ questionId: 2, answer: "Browser extension" }];
    expect(requests).toEqual([
      { method: "POST", path: "/api/chat", body: { text: "Browser extension", answers } },
    ]);
    act(() => {
      store.dispatch({
        type: "chat.message",
        message: message(3, { content: "Browser extension", meta: { answers }, turnId: "t2" }),
      });
    });
    expect(within(card).getByText("You answered: Browser extension")).toBeDefined();
    expect(
      within(card)
        .getAllByRole("button")
        .every((button) => button.matches(":disabled")),
    ).toBe(true);
  });

  it("answers several questions asked together in one message, whatever else is said meanwhile", async () => {
    serveActions();
    renderChat({
      chat: chatWith([
        message(1, { turnId: "t" }),
        question(2, "What should it be written in?", [{ label: "TypeScript" }, { label: "Rust" }], {
          header: "Tech stack",
        }),
        question(
          3,
          "Which browsers?",
          [{ label: "Chrome" }, { label: "Firefox" }, { label: "Safari" }],
          {
            header: "Browsers",
            multiSelect: true,
          },
        ),
        message(4, { content: "what does sync cost?", turnId: "t2" }),
      ]),
    });
    const user = userEvent.setup();
    const card = screen.getByRole("region", { name: "Questions" });
    const submit = within(card).getByRole("button", { name: "Submit answers" });

    await user.click(within(card).getByRole("button", { name: /TypeScript/ }));
    expect(requests).toEqual([]);
    expect(submit.matches(":disabled")).toBe(true);
    expect(card.textContent).toContain("1 of 2 answered");

    await user.click(within(card).getByRole("checkbox", { name: /Chrome/ }));
    await user.click(within(card).getByRole("checkbox", { name: /Safari/ }));
    await user.click(submit);

    expect(requests).toEqual([
      {
        method: "POST",
        path: "/api/chat",
        body: {
          text: "Tech stack: TypeScript\nBrowsers: Chrome, Safari",
          answers: [
            { questionId: 2, answer: "TypeScript" },
            { questionId: 3, answer: "Chrome, Safari" },
          ],
        },
      },
    ]);
  });

  it("sends the owner's own words instead of an option", async () => {
    serveActions();
    renderChat({
      chat: chatWith([
        message(1, { turnId: "t" }),
        question(2, "Which store?", [{ label: "SQLite" }, { label: "Postgres" }]),
      ]),
    });
    const user = userEvent.setup();
    const card = screen.getByRole("region", { name: "Question" });

    await user.type(
      within(card).getByRole("textbox", { name: "Your own answer" }),
      "Neither, use S3",
    );
    await user.click(within(card).getByRole("button", { name: "Send" }));

    expect(requests.at(-1)?.body).toEqual({
      text: "Neither, use S3",
      answers: [{ questionId: 2, answer: "Neither, use S3" }],
    });
  });

  it("shows fenced code as a labelled, highlighted block with a copy button", async () => {
    renderChat({
      chat: chatWith([
        message(1, { content: "show me", turnId: "t" }),
        message(2, {
          kind: "conductor",
          content: "Here:\n\n```ts\nconst a: number = 1;\n```\n\nand `inline` code.",
          turnId: "t",
        }),
      ]),
    });

    const block = screen.getByRole("figure");
    expect(within(block).getByText("ts")).toBeDefined();
    expect(within(block).getByRole("button", { name: "Copy" })).toBeDefined();
    expect(
      await within(block).findByText("const a: number = 1;", { selector: ".token-ts" }),
    ).toBeDefined();
    expect(screen.getByText("inline").tagName).toBe("CODE");
  });

  it("lists the conversations in the sidebar, opens an earlier one and starts a new one", async () => {
    serveActions();
    renderChat({ chat: chatWith([message(1, { content: "plan a password manager" })]) });
    const user = userEvent.setup();
    const sidebar = screen.getByRole("navigation", { name: "Conversations" });
    expect(
      within(sidebar)
        .getAllByRole("button")
        .map((button) => [button.textContent, button.getAttribute("aria-current")]),
    ).toEqual([
      ["＋ New conversation", null],
      ["Plan a password manager", "true"],
      ["Sync design", null],
    ]);

    await user.click(within(sidebar).getByRole("button", { name: "Sync design" }));

    expect(requests.at(-1)).toMatchObject({ path: "/api/conversations/3/open" });
    expect(screen.getByRole("log").textContent).toContain("how should sync work?");
    expect(screen.getByRole("log").textContent).not.toContain("plan a password manager");
    expect(
      within(sidebar).getByRole("button", { name: "Sync design" }).getAttribute("aria-current"),
    ).toBe("true");

    await user.click(within(sidebar).getByRole("button", { name: /New conversation/ }));

    expect(requests.at(-1)).toMatchObject({ method: "POST", path: "/api/conversations" });
    expect(screen.getByRole("log").textContent).toBe("");
    expect(screen.getByRole("heading", { name: /What should we build in/ })).toBeDefined();
    expect(screen.queryByRole("region", { name: "Build and test commands" })).toBeNull();
  });

  it("adds a newline on Shift+Enter and sends the whole message on Enter", async () => {
    serveActions();
    renderChat({ chat: chatWith([message(1, { content: "hello" })]) });
    const user = userEvent.setup();
    const input = screen.getByRole("textbox", { name: "Message" });

    await user.type(input, "first line{Shift>}{Enter}{/Shift}second line");

    expect(input).toHaveProperty("value", "first line\nsecond line");
    expect(requests).toEqual([]);

    await user.keyboard("{Enter}");

    expect(requests).toEqual([
      { method: "POST", path: "/api/chat", body: { text: "first line\nsecond line" } },
    ]);
    expect(input).toHaveProperty("value", "");
    expect(screen.getByText("sent").className).toBe("bubble");
  });

  it("completes @task ids and runs /pause without sending it to the chat", async () => {
    serveActions();
    const store = renderChat({
      tasks: { alpha: task("alpha"), "alpha-two": task("alpha-two"), beta: task("beta") },
      chat: chatWith([message(1, { content: "hello" })]),
    });
    const user = userEvent.setup();
    const input = screen.getByRole("textbox", { name: "Message" });

    await user.type(input, "hold @al");
    expect(
      within(screen.getByRole("listbox", { name: "Tasks" }))
        .getAllByRole("option")
        .map((option) => option.textContent),
    ).toEqual(["alpha", "alpha-two"]);
    await user.keyboard("{ArrowDown}{Enter}");

    expect(input).toHaveProperty("value", "hold @alpha-two ");
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(requests).toEqual([]);

    await user.clear(input);
    await user.type(input, "/pause{Enter}");

    expect(requests).toEqual([{ method: "POST", path: "/api/pause", body: {} }]);
    expect(store.getState().scheduler.paused).toBe(true);
  });

  it("renders replies as markdown but never raw HTML or remote images", () => {
    renderChat({
      chat: chatWith([
        message(1, { content: "show me" }),
        message(2, {
          kind: "conductor",
          content:
            'Done: <b id="raw">bold</b> ![chart](https://example.com/x.png) [docs](javascript:alert(1))',
        }),
      ]),
    });

    const reply = screen.getByRole("log");
    expect(reply.querySelector("#raw")).toBeNull();
    expect(reply.querySelector("img")).toBeNull();
    expect(screen.getByRole("link", { name: "chart" }).getAttribute("href")).toBe(
      "https://example.com/x.png",
    );
    expect(reply.textContent).toContain("docs");
    expect(reply.querySelector('[href^="javascript"]')).toBeNull();
  });

  it("links a stored decision to its task's changes, and Not now declines it", async () => {
    serveActions();
    renderChat({
      chat: chatWith([
        message(1, { content: "hold alpha", turnId: "t" }),
        message(2, {
          kind: "proposal",
          content: "Hold alpha?",
          meta: { proposalId: 5, taskId: "alpha" },
          turnId: "t",
        }),
      ]),
    });
    const decision = screen.getByRole("region", { name: "Decision" });

    expect(within(decision).getByRole("link", { name: "See changes" }).getAttribute("href")).toBe(
      "/review?task=alpha",
    );
    await userEvent.setup().click(within(decision).getByRole("button", { name: "Not now" }));

    expect(requests).toEqual([{ method: "POST", path: "/api/proposals/5/reject", body: {} }]);
    expect(decision.textContent).toContain("Declined");
    expect(within(decision).queryByRole("button")).toBeNull();
  });

  it("starts the latest plan with Start, and marks an earlier plan as replaced", async () => {
    serveActions();
    const planned = (ids: string[]) =>
      ids.map((id) => ({ id, title: `Build ${id}`, goal: "G.", acceptance: "true", touches: [] }));
    const store = renderChat({
      chat: chatWith([
        message(1, { content: "plan the parser", turnId: "t" }),
        message(2, { kind: "plan", content: "1. lexer", meta: { tasks: planned(["lexer"]) } }),
        message(3, {
          kind: "plan",
          content: "1. lexer\n2. parser",
          meta: { tasks: planned(["lexer", "parser"]), notes: { parser: "after lexer" } },
        }),
      ]),
    });
    const [replaced, latest] = screen.getAllByRole("region", { name: "Plan" });
    if (replaced === undefined || latest === undefined) throw new Error("expected two plans");

    expect(replaced.textContent).toContain("Replaced by a newer plan");
    expect(within(replaced).queryByRole("button")).toBeNull();
    expect(latest.textContent).toContain("parser after lexer");
    await userEvent.setup().click(within(latest).getByRole("button", { name: "Start" }));
    act(() => {
      store.dispatch({
        type: "chat.message",
        message: message(4, {
          kind: "system",
          content: "Plan started: added 2 tasks (lexer, parser).",
          meta: { plan: "started", planId: 3 },
        }),
      });
    });

    expect(requests).toEqual([{ method: "POST", path: "/api/plans/3/start", body: {} }]);
    expect(within(latest).getByRole("button", { name: "Started" })).toHaveProperty(
      "disabled",
      true,
    );
    expect(Object.keys(store.getState().tasks)).toEqual(["lexer", "parser"]);
    expect(screen.getByRole("log").textContent).not.toContain("Plan started");
  });

  it("never shows internal names, whatever the chat holds", () => {
    const proposal: Proposal = {
      id: 4,
      ts: at(5),
      action: "setConfig",
      args: { models: { worker: "sonnet" } },
      status: "pending",
      decidedAt: null,
      result: null,
    };
    renderChat({
      tasks: { alpha: task("alpha", { status: "review" }) },
      proposals: { 4: proposal },
      chat: chatWith(
        [
          message(1, {
            kind: "system",
            content: "alpha is ready for review",
            meta: { event: "review", taskId: "alpha" },
          }),
          message(2, { content: "plan the parser", turnId: "t" }),
          message(3, {
            kind: "plan",
            content: "1. lexer: first",
            meta: {
              tasks: [
                { id: "lexer", title: "Lexer", goal: "Tokens.", acceptance: "true", touches: [] },
              ],
              notes: { lexer: "first" },
            },
            turnId: "t",
          }),
          message(4, {
            kind: "proposal",
            content: "Change models.worker to sonnet in settings?",
            meta: { proposalId: 4 },
            turnId: "t",
          }),
          message(5, { kind: "conductor", content: "Here is a plan.", turnId: "t" }),
          message(6, { kind: "action", content: "✓ Held alpha", turnId: "t" }),
          message(7, {
            kind: "system",
            content: "Hold alpha: declined by the owner.",
            meta: { proposalId: 9, status: "rejected" },
          }),
        ],
        true,
      ),
    });

    const internalNames = [
      "conductor",
      "mcp",
      ...Object.keys(actionRoutes).filter((name) => /[A-Z]/.test(name)),
      ...[
        "create_tasks",
        "set_config",
        "propose_plan",
        "start_plan",
        "approve_rebase",
        "discard_task",
        "get_summary",
      ],
    ];
    const attributes = [...document.body.querySelectorAll("*")].flatMap((element) =>
      ["aria-label", "title", "placeholder", "alt"].map((name) => element.getAttribute(name) ?? ""),
    );
    const shown = [document.body.textContent, ...attributes].join("\n").toLowerCase();
    expect(screen.getByRole("button", { name: "Change" })).toBeDefined();
    expect(screen.getByRole("button", { name: "Start" })).toBeDefined();
    expect(
      screen.getByRole("link", { name: "0 working · 2 needs you · 0 of 1 done" }),
    ).toBeDefined();
    for (const name of internalNames) expect(shown).not.toContain(name.toLowerCase());
  });
});
