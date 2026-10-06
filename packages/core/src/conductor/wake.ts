import { eventLineMetaSchema } from "../contracts/index.js";
import type { EventLineKind } from "../contracts/index.js";
import type { EventBus } from "../events.js";

export interface WakeOptions {
  bus: EventBus;
  wakeOnEvents: () => readonly EventLineKind[];
  wake: () => void;
}

// conductor.wakeOnEvents (PLAN 6.4): the event lines named there give the Conductor a turn of its own.
export function wakeOnEventLines({ bus, wakeOnEvents, wake }: WakeOptions): () => void {
  return bus.subscribe((event) => {
    if (event.type !== "chat.message" || event.message.kind !== "system") return;
    const meta = eventLineMetaSchema.safeParse(event.message.meta);
    if (meta.success && wakeOnEvents().includes(meta.data.event)) wake();
  });
}
