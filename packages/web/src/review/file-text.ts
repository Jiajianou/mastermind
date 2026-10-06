import type { FileContent } from "@mastermind/core/contracts";

export type SideText = { kind: "text"; text: string } | { kind: "unavailable"; reason: string };

const kib = 1024;

function sizeText(bytes: number): string {
  return bytes < kib ? `${String(bytes)} bytes` : `${(bytes / kib).toFixed(0)} KiB`;
}

export function sideText(content: FileContent | null): SideText {
  if (content === null) return { kind: "text", text: "" };
  switch (content.kind) {
    case "text":
      return { kind: "text", text: content.content };
    case "missing":
      return { kind: "text", text: "" };
    case "binary":
      return { kind: "unavailable", reason: `Binary file (${sizeText(content.size)})` };
    case "too_large":
      return { kind: "unavailable", reason: `Too large to show (${sizeText(content.size)})` };
  }
}
