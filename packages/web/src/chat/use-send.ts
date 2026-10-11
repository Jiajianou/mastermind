import type { QuestionAnswer } from "@mastermind/core/contracts";
import { useCallback } from "react";
import { useApi, useDispatch } from "../store/hooks.js";

const schedulerCommands = { "/pause": "pause", "/resume": "resume" } as const;

function isSchedulerCommand(text: string): text is keyof typeof schedulerCommands {
  return Object.hasOwn(schedulerCommands, text);
}

export function useSend(): (text: string, answers?: QuestionAnswer[]) => Promise<void> {
  const api = useApi();
  const dispatch = useDispatch();
  return useCallback(
    async (text: string, answers?: QuestionAnswer[]) => {
      const command = text.trim().toLowerCase();
      if (isSchedulerCommand(command)) {
        dispatch({ type: "flags.changed", flags: await api.act(schedulerCommands[command]) });
        return;
      }
      const { message } = await api.act(
        "sendChat",
        answers === undefined ? { text } : { text, answers },
      );
      dispatch({ type: "chat.message", message });
    },
    [api, dispatch],
  );
}
