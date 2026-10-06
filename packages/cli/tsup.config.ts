import { cp } from "node:fs/promises";
import { defineConfig } from "tsup";

export default defineConfig({
  entry: { index: "src/index.ts" },
  format: "esm",
  platform: "node",
  target: "node22",
  noExternal: [/^@mastermind\//],
  // node:sqlite has no unprefixed name, so stripping the protocol (tsup's default) breaks the import.
  removeNodeProtocol: false,
  clean: true,
  async onSuccess() {
    await cp("../web/dist", "dist/web", { recursive: true });
    await cp("../../prompts", "dist/prompts", { recursive: true });
  },
});
