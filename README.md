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

## Service bindings (Worker-to-Worker)

`native-workers` supports Cloudflare's [service bindings](https://developers.cloudflare.com/workers/runtime-apis/bindings/service-bindings/) so one Worker can call another via `env.<BINDING>.fetch(...)` without going over the network. Bindings are resolved from your Wrangler config and routed in-process by a single Miniflare instance — no `unsafeDevRegistryPath` / dev registry is required.

### Declare the binding in `wrangler.toml`

Add a `[[services]]` block to the **caller**'s Wrangler config pointing at the **callee**'s Worker name:

```toml
# caller/wrangler.toml
name = "api-gateway"
main = "src/index.ts"
compatibility_date = "2025-01-01"

[[services]]
binding = "AUTH"        # env.AUTH in the caller
service = "auth-worker" # must match the callee's `name`
```

```ts
// caller/src/index.ts
export default {
  async fetch(req: Request, env: { AUTH: Fetcher }) {
    return env.AUTH.fetch(req);
  },
};
```

### Case 1 — Wrangler surfaces the callee automatically

Some Wrangler configurations cause `unstable_getMiniflareWorkerOptions()` to return the callee in its `externalWorkers` array. When that happens, `native-workers` picks it up and registers it on the same Miniflare instance — **no `extraWorkers` needed, no extra code**, just `native-workers serve` / `build --miniflare`.

The most common shape that triggers this is a **Durable Object with `script_name`** declared in the *caller's* Wrangler config — Wrangler treats the referenced script as an auxiliary worker, and a `[[services]]` binding pointing at the same `name` resolves through it. For example:

```
caller/
├── wrangler.toml
├── src/index.ts        # primary: uses env.AUTH.fetch(...)
└── workers/
    └── auth.js         # auxiliary: handles auth requests + a DO class
```

```toml
# caller/wrangler.toml
name = "api-gateway"
main = "src/index.ts"
compatibility_date = "2025-01-01"

# Service binding the primary uses: env.AUTH.fetch(req)
[[services]]
binding = "AUTH"
service = "auth-worker"

# Durable Object whose implementation lives in another script.
# This is what makes Wrangler treat `auth-worker` as a known
# auxiliary worker and emit it in `externalWorkers`.
[[durable_objects.bindings]]
name = "AUTH_DO"
class_name = "AuthSession"
script_name = "auth-worker"

# The auxiliary worker definition Wrangler will surface.
[[workers]]
name = "auth-worker"
main = "workers/auth.js"
```

```ts
// caller/src/index.ts
export default {
  async fetch(req: Request, env: { AUTH: Fetcher; AUTH_DO: DurableObjectNamespace }) {
    return env.AUTH.fetch(req); // routed in-process to auth-worker
  },
};
```

```bash
bunx native-workers serve --project ./caller
# or, when shipping the embedded binary:
bunx native-workers build --project ./caller --miniflare
```

> **Heuristic:** if `wrangler dev` alone (no `--config` for the callee, no dev registry) can already route `env.AUTH.fetch(...)` to the callee, you're in Case 1 and `native-workers` will Just Work. If you have to run a second `wrangler dev` or use the dev registry to make it work, you're in **Case 2** — use `extraWorkers` below.

### Case 2 — callee is owned by your process but **not** in Wrangler config

When the callee's script is bundled by *your* process (for example, you want to register an ad-hoc Worker that isn't in the primary's `wrangler.toml`), pass it via `extraWorkers` on the programmatic API. Each entry must set `name` to match the `service` field declared in the caller's binding:

```ts
import { runMiniflareHost } from "native-workers/host";

await runMiniflareHost({
  extraWorkers: [
    {
      name: "auth-worker", // matches `[[services]] service = "auth-worker"`
      modules: true,
      scriptPath: "./dist/auth/index.js",
      // or: script: "export default { fetch() { return new Response('ok'); } }",
    },
  ],
});
```

`extraWorkers` are merged with Wrangler-discovered auxiliary workers and deduplicated by `name` (extras win on conflict). The primary Worker always stays at index 0 and is never replaced.

### Overriding bindings entirely

For total control, pass `miniflare: { workers: [...] }` to `runMiniflareHost` to bypass Wrangler-derived bindings and supply the full Miniflare worker array yourself.

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