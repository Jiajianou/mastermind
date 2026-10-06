import { describe, expect, it } from "vitest";
import { at } from "../testing/fixtures.js";
import type { Connection, SchedulerState } from "./state.js";
import { banners, runStatus } from "./status.js";
import type { Banner, RunStatus } from "./status.js";

const calm: SchedulerState = { paused: false, authRequired: false, resumeAt: null };

interface Case {
  connection: Connection;
  scheduler: SchedulerState;
  status: RunStatus;
  banners: Banner[];
}

const cases: Case[] = [
  {
    connection: "live",
    scheduler: calm,
    status: { word: "Running", tone: "ok" },
    banners: [],
  },
  {
    connection: "live",
    scheduler: { ...calm, paused: true },
    status: { word: "Paused", tone: "quiet" },
    banners: [],
  },
  {
    connection: "live",
    scheduler: { ...calm, paused: true, resumeAt: at(30) },
    status: { word: "Usage limit", tone: "attention" },
    banners: [{ kind: "usage-limit", resumeAt: at(30) }],
  },
  {
    connection: "live",
    scheduler: { paused: true, authRequired: true, resumeAt: at(30) },
    status: { word: "Sign-in needed", tone: "attention" },
    banners: [{ kind: "sign-in" }, { kind: "usage-limit", resumeAt: at(30) }],
  },
  {
    connection: "connecting",
    scheduler: calm,
    status: { word: "Connecting", tone: "quiet" },
    banners: [],
  },
  {
    connection: "reconnecting",
    scheduler: { ...calm, authRequired: true },
    status: { word: "Reconnecting", tone: "attention" },
    banners: [],
  },
  {
    connection: "stopped",
    scheduler: { ...calm, authRequired: true },
    status: { word: "Stopped", tone: "attention" },
    banners: [{ kind: "stopped" }],
  },
  {
    connection: "unauthorized",
    scheduler: calm,
    status: { word: "No access", tone: "attention" },
    banners: [{ kind: "unauthorized" }],
  },
];

describe("top bar status and banners", () => {
  it.each(cases)(
    "shows $status.word for a $connection connection with $scheduler",
    ({ connection, scheduler, status, banners: expected }) => {
      expect(runStatus(connection, scheduler)).toEqual(status);
      expect(banners(connection, scheduler)).toEqual(expected);
    },
  );
});
