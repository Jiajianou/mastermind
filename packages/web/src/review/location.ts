export type ReviewMode = "diff" | "file";
export type ReviewView = "one" | "all";

export interface ReviewLocation {
  view: ReviewView;
  mode: ReviewMode;
  session: number | null;
  task: string | null;
  file: string | null;
  since: string | null;
}

// The since toggle offers the previous round only; anything else in the address falls back to all changes.
export function changesSince(param: string | null, round: number): string {
  const previous = `round:${String(round - 1)}`;
  return round > 1 && param === previous ? previous : "base";
}

function sessionParam(value: string | null): number | null {
  return value !== null && /^\d+$/.test(value) ? Number(value) : null;
}

export function readReviewLocation(params: URLSearchParams): ReviewLocation {
  return {
    view: params.get("view") === "all" ? "all" : "one",
    mode: params.get("mode") === "file" ? "file" : "diff",
    session: sessionParam(params.get("session")),
    task: params.get("task"),
    file: params.get("file"),
    since: params.get("since"),
  };
}

export function reviewPath(location: Partial<ReviewLocation>): string {
  const params = new URLSearchParams();
  if (location.view === "all") params.set("view", "all");
  if (location.session !== undefined && location.session !== null)
    params.set("session", String(location.session));
  if (location.task !== undefined && location.task !== null) params.set("task", location.task);
  if (location.mode === "file") params.set("mode", "file");
  if (location.since !== undefined && location.since !== null && location.since !== "base")
    params.set("since", location.since);
  if (location.file !== undefined && location.file !== null) params.set("file", location.file);
  const search = params.toString();
  return search === "" ? "/review" : `/review?${search}`;
}
