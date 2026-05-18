# native-workers

[![npm version](https://img.shields.io/npm/v/native-workers.svg)](https://www.npmjs.com/package/native-workers)
[![npm downloads](https://img.shields.io/npm/dm/native-workers.svg)](https://www.npmjs.com/package/native-workers)
[![Release](https://github.com/geoffsee/native-workers/actions/workflows/release.yml/badge.svg)](https://github.com/geoffsee/native-workers/actions/workflows/release.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Bun](https://img.shields.io/badge/runtime-Bun-fbf0df?logo=bun&logoColor=black)](https://bun.sh)

Compiles Cloudflare Workers into native executables — ship a Worker as a single binary you can run anywhere, with or without an embedded `workerd` runtime.

> ⚠️ **Not recommended for production.** This project is experimental and intended for local development, demos, prototyping, and offline/edge-of-network scenarios. It is **not** a substitute for deploying Workers to Cloudflare's edge: it has not been hardened for production workloads, makes no guarantees about security, performance, stability, or parity with the Cloudflare Workers runtime, and may change in breaking ways. Use at your own risk.

## Requirements

- [Bun](https://bun.sh) (for `Bun.build` / `compile`)
- A Wrangler project (`wrangler.toml` / `wrangler.jsonc`) with `wrangler` and `workerd` available (e.g. `devDependencies`)

## Quick start (no install)

Run the CLI directly via `bunx` (recommended) or `npx` — no global or local install required. You only need the peer dependencies (`miniflare`, `workerd`, `wrangler`) available in your Worker project.

```bash
# From the root of your Cloudflare Worker project
bunx native-workers build --project .

# Or with npm
npx -y native-workers build --project .
```

> The package is published as `native-workers`; the CLI binary it exposes is `native-worker` (singular). `bunx`/`npx` will resolve and run it for you.

### Peer dependencies

Make sure your Worker project has these installed (they aren't bundled by `bunx`/`npx`):

```bash
bun add -d miniflare workerd wrangler
# or
npm i -D miniflare workerd wrangler
```

## CLI usage

All examples below use `bunx`; substitute `npx -y` if you prefer npm.

```bash
# Native binary that runs the bundled JS alone (often wrong for Workers-only APIs)
bunx native-workers build --project ./your-worker-app

# Miniflare host; embeds workerd + bundle — materializes under APP_DIR/dist/ at runtime
bunx native-workers build --project ./your-worker-app --miniflare

# Local Miniflare server (reads dist/worker from the project directory)
bunx native-workers serve --project ./your-worker-app
```

### Optional: install locally

If you'd rather pin a version into your project instead of resolving it on each run:

```bash
bun add -d native-workers
# then
bunx native-workers build --project .
```

> Use **`bunx native-workers`** (the npm package name). **`bunx native-worker`** only works once `native-workers` is in your `package.json`; otherwise Bun looks for a non-existent `native-worker` package on the registry.

Generated files (ignored from VCS typically): **`{project}/.native-worker/embed-manifest.ts`** and **`compile-gateway.ts`**.

## Programmatic API

```ts
import {
  buildNativePipeline,
  runMiniflareHost,
  writeEmbedManifest,
} from "native-workers";
```

See `src/index.ts` for supported exports.

## Tests

From this package directory:

```bash
bun test
bun run typecheck
```

## Limitations / notes

- **Bindings** for `runMiniflareHost` / `serve` are loaded from your Wrangler config using Wrangler’s **`unstable_readConfig`**, **`unstable_convertConfigBindingsToStartWorkerBindings`** (same normalized shape as for `startRemoteProxySession`), and **`unstable_getMiniflareWorkerOptions`** so Miniflare matches Wrangler’s local-dev binding layout (KV namespaces, vars, etc.). Override with `runMiniflareHost({ miniflare: { … } })` or `--config` / `--env` on the CLI.
- **`wrangler` must resolve** from the app’s `package.json` (via `createRequire`). If `APP_DIR` is a disposable directory, set **`WRANGLER_PROJECT_ROOT`** (or `runMiniflareHost({ wranglerProjectRoot })`) to your real Worker project so Node can find `node_modules/wrangler` while persistence still uses `APP_DIR`.
- Runtime layout expects materialized bundles under **`$APP_DIR/dist/worker`** and persistence under **`$APP_DIR/dist/miniflare-storage`** by default (`APP_DIR` env or current working directory after `chdir`).

## License

MIT 2026 Geoff Seemueller