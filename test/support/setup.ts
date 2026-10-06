import { afterEach } from "vitest";
import { runCleanups } from "./cleanup.js";

afterEach(runCleanups);
