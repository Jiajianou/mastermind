import type { Toolchain } from "../contracts/config.js";

export type HostPlatform = "darwin" | "linux";

export function hostPlatform(platform: NodeJS.Platform): HostPlatform | null {
  return platform === "darwin" || platform === "linux" ? platform : null;
}

export interface SandboxPreset {
  allowedDomains: string[];
  allowWrite: string[];
}

const npmRegistry = ["registry.npmjs.org"];
const pythonIndex = ["pypi.org", "files.pythonhosted.org"];

const registryDomains: Record<Toolchain, readonly string[]> = {
  npm: npmRegistry,
  pnpm: npmRegistry,
  yarn: [...npmRegistry, "registry.yarnpkg.com", "repo.yarnpkg.com"],
  cargo: ["crates.io", "index.crates.io", "static.crates.io"],
  go: ["proxy.golang.org", "sum.golang.org"],
  pip: pythonIndex,
  uv: pythonIndex,
  poetry: pythonIndex,
};

const cacheFolders: Record<HostPlatform, Record<Toolchain, readonly string[]>> = {
  darwin: {
    npm: ["~/.npm"],
    pnpm: ["~/Library/pnpm", "~/Library/Caches/pnpm"],
    yarn: ["~/.yarn", "~/Library/Caches/Yarn"],
    cargo: ["~/.cargo/registry", "~/.cargo/git"],
    go: ["~/go/pkg/mod", "~/Library/Caches/go-build"],
    pip: ["~/Library/Caches/pip"],
    uv: ["~/.cache/uv"],
    poetry: ["~/Library/Caches/pypoetry"],
  },
  linux: {
    npm: ["~/.npm"],
    pnpm: ["~/.local/share/pnpm", "~/.cache/pnpm"],
    yarn: ["~/.yarn", "~/.cache/yarn"],
    cargo: ["~/.cargo/registry", "~/.cargo/git"],
    go: ["~/go/pkg/mod", "~/.cache/go-build"],
    pip: ["~/.cache/pip"],
    uv: ["~/.cache/uv"],
    poetry: ["~/.cache/pypoetry"],
  },
};

export function sandboxPreset(
  toolchains: readonly Toolchain[],
  platform: HostPlatform,
): SandboxPreset {
  return {
    allowedDomains: [...new Set(toolchains.flatMap((toolchain) => registryDomains[toolchain]))],
    allowWrite: [...new Set(toolchains.flatMap((toolchain) => cacheFolders[platform][toolchain]))],
  };
}
