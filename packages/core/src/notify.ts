import { eventLineMetaSchema, notificationReasonSchema } from "./contracts/index.js";
import type { ChatMessage, OwnerNotification } from "./contracts/index.js";
import { cleanEnv } from "./env.js";
import type { Environment } from "./env.js";
import type { EventBus } from "./events.js";
import { collectOutput, exitedCleanly } from "./procs.js";
import type { ProcessRegistry } from "./procs.js";

export interface DesktopNotification {
  title: string;
  body: string;
}

export interface NativeNotifier {
  notify(notification: DesktopNotification): Promise<void>;
}

export class NotificationError extends Error {
  override readonly name = "NotificationError";
}

export interface NativeNotifierOptions {
  registry: ProcessRegistry;
  env: Environment;
  platform: NodeJS.Platform;
}

interface NotifyCommand {
  command: string;
  args: string[];
}

// The text goes in as script arguments, so nothing in it is ever parsed as AppleScript.
const appleScript = [
  "on run argv",
  "display notification (item 2 of argv) with title (item 1 of argv)",
  "end run",
];

function notifyCommand(
  platform: NodeJS.Platform,
  { title, body }: DesktopNotification,
): NotifyCommand | null {
  switch (platform) {
    case "darwin":
      return {
        command: "osascript",
        args: [...appleScript.flatMap((line) => ["-e", line]), title, body],
      };
    case "linux":
      return { command: "notify-send", args: ["--app-name=mastermind", title, body] };
    default:
      return null;
  }
}

export function createNativeNotifier({
  registry,
  env,
  platform,
}: NativeNotifierOptions): NativeNotifier {
  const childEnv = cleanEnv(env);
  return {
    async notify(notification) {
      const spawn = notifyCommand(platform, notification);
      if (spawn === null)
        throw new NotificationError(`desktop notifications are not supported on ${platform}`);
      const { exit, stderr } = await collectOutput(registry, {
        kind: "utility",
        ...spawn,
        env: childEnv,
      });
      if (!exitedCleanly(exit))
        throw new NotificationError(
          `${spawn.command} could not show a notification${stderr === "" ? "" : `: ${stderr}`}`,
        );
    },
  };
}

function ownerNotification(message: ChatMessage, title: string): OwnerNotification | null {
  if (message.kind !== "system") return null;
  const meta = eventLineMetaSchema.safeParse(message.meta);
  if (!meta.success) return null;
  const reason = notificationReasonSchema.safeParse(meta.data.event);
  if (!reason.success) return null;
  return {
    id: message.id,
    title,
    body: message.content,
    reason: reason.data,
    taskId: "taskId" in meta.data ? meta.data.taskId : null,
  };
}

export interface OwnerNotifierOptions {
  bus: EventBus;
  project: string;
  enabled: () => boolean;
  webClientConnected: () => boolean;
  native: NativeNotifier;
  onError: (error: unknown) => void;
}

// The chat's event lines (6.4) already mark what needs the owner; decision 16 notifies for four of them. An open
// tab shows the notification itself, so it can open the right screen on click; with none, the OS shows it.
export function notifyOwner(options: OwnerNotifierOptions): () => void {
  const { bus, native, onError } = options;
  const title = `mastermind · ${options.project}`;
  return bus.subscribe((event) => {
    if (event.type !== "chat.message" || !options.enabled()) return;
    const notification = ownerNotification(event.message, title);
    if (notification === null) return;
    if (options.webClientConnected()) bus.emit({ type: "notification", notification });
    else native.notify({ title, body: notification.body }).catch(onError);
  });
}
