import type { BusEvent } from "./contracts/index.js";

export type BusListener = (event: BusEvent) => void;

export interface EventBus {
  emit(event: BusEvent): void;
  subscribe(listener: BusListener): () => void;
}

export interface EventBusOptions {
  onListenerError?: (error: unknown, event: BusEvent) => void;
}

function reportListenerError(error: unknown, event: BusEvent): void {
  console.error(`mastermind: a listener failed on ${event.type}`, error);
}

export function createEventBus({
  onListenerError = reportListenerError,
}: EventBusOptions = {}): EventBus {
  const listeners = new Set<BusListener>();

  return {
    emit(event) {
      for (const listener of [...listeners]) {
        try {
          listener(event);
        } catch (error) {
          onListenerError(error, event);
        }
      }
    },

    subscribe(listener) {
      const subscription: BusListener = (event) => {
        listener(event);
      };
      listeners.add(subscription);
      return () => {
        listeners.delete(subscription);
      };
    },
  };
}
