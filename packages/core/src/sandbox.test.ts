import { describe, expect, test } from "vitest";
import { deniedHosts, hostAllowed } from "./sandbox.js";

const violations = (...lines: string[]): string =>
  [
    "curl: (56) CONNECT tunnel failed, response 403",
    "<sandbox_violations>",
    ...lines,
    "</sandbox_violations>",
  ].join("\n");

describe("sandbox denials", () => {
  test.each([
    {
      name: "reads each denied host once, without its port",
      output: violations(
        "deny network-outbound GitHub.com:443 (host is not on the allow list)",
        "deny network-outbound pypi.org:443 (host is not on the allow list)",
        "deny network-outbound github.com:22",
      ),
      hosts: ["github.com", "pypi.org"],
    },
    {
      name: "ignores denials that are not network hosts",
      output: violations("deny file-write /etc/hosts", "deny network-outbound [::1]:8080"),
      hosts: [],
    },
    {
      name: "ignores a wildcard, which only the owner can add",
      output: violations("deny network-outbound *.evil.example:443"),
      hosts: [],
    },
    {
      name: "ignores denial text outside a violations block",
      output: "deny network-outbound github.com:443",
      hosts: [],
    },
  ])("$name", ({ output, hosts }) => {
    expect(deniedHosts(output)).toEqual(hosts);
  });

  test.each([
    { host: "github.com", allowed: ["GitHub.com"], expected: true },
    { host: "api.github.com", allowed: ["*.github.com"], expected: true },
    { host: "github.com", allowed: ["*.github.com"], expected: false },
    { host: "notgithub.com", allowed: ["*.github.com", "github.com"], expected: false },
  ])("$host against $allowed is allowed: $expected", ({ host, allowed, expected }) => {
    expect(hostAllowed(host, allowed)).toBe(expected);
  });
});
