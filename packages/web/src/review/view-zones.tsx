import { useEffect, useMemo } from "react";
import type { ReactNode, RefObject } from "react";
import { createPortal } from "react-dom";
import type { monaco } from "./monaco.js";

export interface EditorZone {
  key: string;
  afterLine: number;
  content: ReactNode;
}

type CodeEditor = monaco.editor.ICodeEditor;

interface ZonePlace {
  key: string;
  afterLine: number;
}

const placementOf = (zones: readonly EditorZone[]): string =>
  zones.map((zone) => `${zone.key} ${String(zone.afterLine)}`).join("\n");

function placesIn(placement: string): ZonePlace[] {
  return placement
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => {
      const space = line.lastIndexOf(" ");
      return { key: line.slice(0, space), afterLine: Number(line.slice(space + 1)) };
    });
}

// Monaco hides a zone of height 0, and a hidden zone's content can't be measured, so zones start small and then
// take their content's height.
const initialHeight = 48;

// Keys typed into a zone's form belong to the form, not to the editor's own shortcuts.
const keepKeysInZone = (event: KeyboardEvent): void => {
  event.stopPropagation();
};

function zoneNodes(keys: string): Map<string, HTMLDivElement> {
  return new Map(
    keys
      .split("\n")
      .filter((key) => key !== "")
      .map((key) => {
        const node = document.createElement("div");
        node.className = "view-zone";
        node.addEventListener("keydown", keepKeysInZone);
        return [key, node];
      }),
  );
}

// Each zone's React content is portalled into a node Monaco places under its line; the zone's height follows the
// content's own height. `layout` changes whenever the text or the lines move, so every zone is placed again.
export function useViewZones(
  editor: RefObject<CodeEditor | null>,
  zones: readonly EditorZone[],
  layout: string,
): ReactNode {
  const keys = zones.map((zone) => zone.key).join("\n");
  const nodes = useMemo(() => zoneNodes(keys), [keys]);
  const placement = placementOf(zones);
  const places = useMemo(() => placesIn(placement), [placement]);

  useEffect(() => {
    const target = editor.current;
    if (target === null) return;
    const placed = places.flatMap(({ key, afterLine }) => {
      const domNode = nodes.get(key);
      return domNode === undefined
        ? []
        : [{ id: "", zone: { afterLineNumber: afterLine, heightInPx: initialHeight, domNode } }];
    });
    target.changeViewZones((accessor) => {
      for (const entry of placed) entry.id = accessor.addZone(entry.zone);
    });
    // Monaco hides its view-zone layer from assistive technology, but these zones hold real notes and controls.
    for (const entry of placed) entry.zone.domNode.parentElement?.removeAttribute("aria-hidden");
    const observer = new ResizeObserver(() => {
      target.changeViewZones((accessor) => {
        for (const entry of placed) {
          const height = entry.zone.domNode.firstElementChild?.getBoundingClientRect().height ?? 0;
          if (Math.ceil(height) === entry.zone.heightInPx) continue;
          entry.zone.heightInPx = Math.ceil(height);
          accessor.layoutZone(entry.id);
        }
      });
    });
    for (const entry of placed) {
      const content = entry.zone.domNode.firstElementChild;
      if (content !== null) observer.observe(content);
    }
    return () => {
      observer.disconnect();
      target.changeViewZones((accessor) => {
        for (const entry of placed) accessor.removeZone(entry.id);
      });
    };
  }, [editor, nodes, places, layout]);

  return zones.map((zone) => {
    const node = nodes.get(zone.key);
    return node === undefined
      ? null
      : createPortal(<div className="view-zone-content">{zone.content}</div>, node, zone.key);
  });
}
