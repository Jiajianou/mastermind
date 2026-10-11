import type { Conversation } from "@mastermind/core/contracts";

export interface ConversationGroup {
  label: string;
  conversations: Conversation[];
}

const dayMs = 24 * 60 * 60 * 1000;

function startOfDay(date: Date): number {
  const day = new Date(date);
  day.setHours(0, 0, 0, 0);
  return day.getTime();
}

function groupLabel(lastActivityAt: string, today: number): string {
  const time = Date.parse(lastActivityAt);
  if (time >= today) return "Today";
  if (time >= today - dayMs) return "Yesterday";
  if (time >= today - 7 * dayMs) return "Previous 7 days";
  return "Older";
}

// Like claude.ai: most recent first, under Today, Yesterday, Previous 7 days and Older. A conversation nobody has
// written in yet only shows while it is the one open.
export function groupConversations(
  conversations: readonly Conversation[],
  activeId: number | null,
  now: Date,
): ConversationGroup[] {
  const today = startOfDay(now);
  const groups: ConversationGroup[] = [];
  const shown = conversations
    .filter((conversation) => conversation.title !== null || conversation.id === activeId)
    .toSorted((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt) || b.id - a.id);
  for (const conversation of shown) {
    const label = groupLabel(conversation.lastActivityAt, today);
    const group = groups.at(-1);
    if (group?.label === label) group.conversations.push(conversation);
    else groups.push({ label, conversations: [conversation] });
  }
  return groups;
}
