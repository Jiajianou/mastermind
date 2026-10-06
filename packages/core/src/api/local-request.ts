import { createHash, timingSafeEqual } from "node:crypto";
import type { IncomingHttpHeaders } from "node:http";
import { streamProtocol, streamTokenProtocolPrefix } from "../contracts/index.js";
import type { ApiError } from "../contracts/index.js";

export interface Rejection {
  status: 401 | 403;
  body: ApiError;
}

const localHost = /^(?:localhost|127\.0\.0\.1|\[::1\])(?::\d{1,5})?$/i;
const localOrigin = /^http:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::\d{1,5})?$/i;

const forbidden = (message: string): Rejection => ({
  status: 403,
  body: { code: "forbidden", message, issues: [] },
});

const unauthorized: Rejection = {
  status: 401,
  body: { code: "unauthorized", message: "missing or wrong token", issues: [] },
};

// A page on another site can reach 127.0.0.1 through DNS rebinding or a cross-site request, but it can't make the
// browser send a localhost Host or Origin.
export function siteRejection(headers: IncomingHttpHeaders): Rejection | null {
  const { host, origin } = headers;
  if (host === undefined || !localHost.test(host))
    return forbidden(`Host "${host ?? ""}" is not localhost`);
  if (origin !== undefined && !localOrigin.test(origin))
    return forbidden(`Origin "${origin}" is not localhost`);
  return null;
}

const digest = (text: string): Buffer => createHash("sha256").update(text).digest();

function matchesToken(candidate: string, token: string): boolean {
  return timingSafeEqual(digest(candidate), digest(token));
}

export function bearerRejection(
  authorization: string | undefined,
  token: string,
): Rejection | null {
  const match = /^Bearer\s+(\S+)$/i.exec(authorization ?? "");
  return match?.[1] !== undefined && matchesToken(match[1], token) ? null : unauthorized;
}

export function offeredProtocols(header: string | undefined): string[] {
  return (header ?? "")
    .split(",")
    .map((protocol) => protocol.trim())
    .filter((protocol) => protocol !== "");
}

export function streamRejection(
  protocolHeader: string | undefined,
  token: string,
): Rejection | null {
  const offered = offeredProtocols(protocolHeader);
  const tokens = offered
    .filter((protocol) => protocol.startsWith(streamTokenProtocolPrefix))
    .map((protocol) => protocol.slice(streamTokenProtocolPrefix.length));
  const authorized =
    offered.includes(streamProtocol) && tokens.some((candidate) => matchesToken(candidate, token));
  return authorized ? null : unauthorized;
}
