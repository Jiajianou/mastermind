import { beforeEach, describe, expect, it } from "vitest";
import { takeAccessToken, tokenStorageKey } from "./token.js";

const token = "8f3c2a91".repeat(8);
const olderToken = "0123abcd".repeat(8);

interface Case {
  name: string;
  url: string;
  stored: string | null;
  expected: { token: string | null; stored: string | null; url: string };
}

const cases: Case[] = [
  {
    name: "moves a token in the fragment to sessionStorage and strips it from the address",
    url: "/sessions?task=alpha#t=" + token,
    stored: olderToken,
    expected: { token, stored: token, url: "/sessions?task=alpha" },
  },
  {
    name: "uses the stored token after a reload",
    url: "/overview",
    stored: token,
    expected: { token, stored: token, url: "/overview" },
  },
  {
    name: "strips a malformed fragment token and keeps the stored one",
    url: "/#t=not-a-token",
    stored: token,
    expected: { token, stored: token, url: "/" },
  },
  {
    name: "has no token when neither the link nor the session has one",
    url: "/",
    stored: null,
    expected: { token: null, stored: null, url: "/" },
  },
];

describe("takeAccessToken", () => {
  beforeEach(() => {
    sessionStorage.clear();
  });

  it.each(cases)("$name", ({ url, stored, expected }) => {
    window.history.replaceState(null, "", url);
    if (stored !== null) sessionStorage.setItem(tokenStorageKey, stored);

    expect(takeAccessToken(window)).toBe(expected.token);
    expect(sessionStorage.getItem(tokenStorageKey)).toBe(expected.stored);
    expect(window.location.href).toBe(new URL(expected.url, window.location.origin).href);
  });
});
