# Implementation notes

Decisions and deviations recorded by each task of `./implement.sh`, so that later sessions can see why the code
looks the way it does. Each task adds a section under its own heading; `docs/PLAN.md` stays the source of truth for
the design, and these notes only explain where and why the implementation chose a detail the plan left open or
departed from it.

## m0-scaffold

- **pnpm 12 build approvals.** pnpm 12 no longer reads the `pnpm` field in package.json and warns about it, so
  `pnpm.onlyBuiltDependencies` would have no effect. The equivalent setting is `allowBuilds` in
  `pnpm-workspace.yaml`, which allows esbuild and node-pty. Add any later native or binary dependency there.
- **TypeScript 6.0, not 7.** typescript-eslint supports TypeScript `<6.1`, so the workspace pins `~6.0.3`.
  TypeScript 6 defaults `types` to `[]`, so the base config lists `node` explicitly and web uses `vite/client`.
- **`@types/node` 22** matches the lowest supported Node (22.13), so APIs only present in newer Node fail typecheck.
- **No package emits declarations.** Every tsconfig has `noEmit`; tsup bundles the CLI with `@mastermind/*`
  inlined and Vite builds web. Workspace packages export their TypeScript sources directly
  (`@mastermind/core/contracts` → `src/contracts/index.ts`). Core has no `.` export yet; add one when core gains
  Node-side modules.
- **Typecheck layout.** The root `tsconfig.json` covers tool configs (`*.config.ts`, including those inside
  packages) and everything under `test/`; each package's `tsconfig.json` covers its `src`. ESLint uses these
  projects through `parserOptions.project`. The root package depends on `@mastermind/core` (`workspace:*`) so that
  integration and e2e tests can import it; add other workspace packages there when tests need them.
- **Browser-safe contracts** are enforced twice: an ESLint `no-restricted-imports` rule bans Node built-ins in
  `packages/core/src/contracts/`, and web typechecks the contracts it imports without Node types.
- **The CLI reads its version** by importing its own package.json (inlined by tsup).
- **Vitest projects** live in the root `vitest.config.ts` with `passWithNoTests`. The web project extends
  `packages/web/vite.config.ts` for the React plugin. The `live` project only exists when `MASTERMIND_LIVE=1`,
  which `pnpm test:live` sets, so no other script can run live tests by accident. Live tests go in `test/live/`.
- **Playwright** runs with `--pass-with-no-tests`. `test:e2e` runs `playwright install chromium` first. On Linux
  CI, a separate workflow step installs the browser's system libraries, because that needs sudo and must not run
  from an everyday script.
- **Prettier** ignores Markdown, `tasks.yaml` and recorded CLI samples, so the plan, prompts and fixtures are never
  reflowed.
