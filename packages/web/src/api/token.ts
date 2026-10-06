import { accessTokenSchema } from "@mastermind/core/contracts";

export const tokenStorageKey = "mastermind.token";

export interface TokenSources {
  location: Pick<Location, "hash" | "pathname" | "search">;
  history: Pick<History, "state" | "replaceState">;
  sessionStorage: Pick<Storage, "getItem" | "setItem">;
}

// The link carries the token in the fragment so it never reaches a server log; it moves to sessionStorage and
// leaves the address bar before anything else runs.
export function takeAccessToken({
  location,
  history,
  sessionStorage,
}: TokenSources): string | null {
  const offered = new URLSearchParams(location.hash.slice(1)).get("t");
  if (offered !== null) {
    history.replaceState(history.state, "", `${location.pathname}${location.search}`);
    const token = accessTokenSchema.safeParse(offered);
    if (token.success) {
      sessionStorage.setItem(tokenStorageKey, token.data);
      return token.data;
    }
  }
  const stored = accessTokenSchema.safeParse(sessionStorage.getItem(tokenStorageKey));
  return stored.success ? stored.data : null;
}
