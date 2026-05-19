# workers-native

[![npm version](https://img.shields.io/npm/v/workers-native.svg)](https://www.npmjs.com/package/workers-native)
[![npm downloads](https://img.shields.io/npm/dm/workers-native.svg)](https://www.npmjs.com/package/workers-native)
[![Release](https://github.com/geoffsee/workers-native/actions/workflows/release.yml/badge.svg)](https://github.com/geoffsee/workers-native/actions/workflows/release.yml)
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
bunx workers-native build --project .

# Or with npm
npx -y workers-native build --project .
```

> The package is published as `workers-native`; the CLI binary it exposes is `worker-native` (singular). `bunx`/`npx` will resolve and run it for you.

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
bunx workers-native build --project ./your-worker-app

# Miniflare host; embeds workerd + bundle — materializes under APP_DIR/dist/ at runtime
bunx workers-native build --project ./your-worker-app --miniflare

# Local Miniflare server (reads dist/worker from the project directory)
bunx workers-native serve --project ./your-worker-app
```

### Optional: install locally

If you'd rather pin a version into your project instead of resolving it on each run:

```bash
bun add -d workers-native
# then
bunx workers-native build --project .
```

> Use **`bunx workers-native`** (the npm package name). **`bunx worker-native`** only works once `workers-native` is in your `package.json`; otherwise Bun looks for a non-existent `worker-native` package on the registry.

Generated files (ignored from VCS typically): **`{project}/.worker-native/embed-manifest.ts`** and **`compile-gateway.ts`**.

## Programmatic API

```ts
import {
  buildNativePipeline,
  runMiniflareHost,
  writeEmbedManifest,
} from "workers-native";
```

See `src/index.ts` for supported exports.

## Service bindings (Worker-to-Worker)

`workers-native` supports Cloudflare's [service bindings](https://developers.cloudflare.com/workers/runtime-apis/bindings/service-bindings/) so one Worker can call another via `env.<BINDING>.fetch(...)` without going over the network. Bindings are resolved from your Wrangler config and routed in-process by a single Miniflare instance — no `unsafeDevRegistryPath` / dev registry is required.

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

Some Wrangler configurations cause `unstable_getMiniflareWorkerOptions()` to return the callee in its `externalWorkers` array. When that happens, `workers-native` picks it up and registers it on the same Miniflare instance — **no `extraWorkers` needed, no extra code**, just `workers-native serve` / `build --miniflare`.

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
bunx workers-native serve --project ./caller
# or, when shipping the embedded binary:
bunx workers-native build --project ./caller --miniflare
```

> **Heuristic:** if `wrangler dev` alone (no `--config` for the callee, no dev registry) can already route `env.AUTH.fetch(...)` to the callee, you're in Case 1 and `workers-native` will Just Work. If you have to run a second `wrangler dev` or use the dev registry to make it work, you're in **Case 2** — use `extraWorkers` below.

### Case 2 — callee is owned by your process but **not** in Wrangler config

When the callee's script is bundled by *your* process (for example, you want to register an ad-hoc Worker that isn't in the primary's `wrangler.toml`), you can now declare it in an opt-in `worker-native.toml` file at your app root:

```toml
[[extra_workers]]
name = "auth-worker" # must match [[services]].service in the caller
script_path = "./dist/auth/index.js"
modules = true

# Optional: auto-bundle this extra worker with wrangler deploy --dry-run
[[extra_workers]]
name = "billing-worker"
wrangler_project_root = "../billing-worker"
wrangler_config_path = "wrangler.toml" # optional
wrangler_env = "staging"               # optional
bundle_outdir = "dist/worker"          # optional (default: dist/worker)
```

`worker-native.toml` is optional. If present, `extra_workers` are loaded automatically by `worker-native serve` / `runMiniflareHost`.

You can still pass `extraWorkers` on the programmatic API. Runtime precedence is:

1. Wrangler-discovered `externalWorkers`
2. `worker-native.toml` `extra_workers`
3. `runMiniflareHost({ extraWorkers })` (highest precedence)

All auxiliary workers are deduplicated by `name` (last-wins), and the primary worker always stays at index 0.

Programmatic `extraWorkers` remains available when you prefer code-driven wiring:

```ts
import { runMiniflareHost } from "workers-native/host";

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

### Binding verification examples

Runnable binding scenarios live under `./examples/upstream`. They are **imported** (not hand-written) from a pinned commit of [`cloudflare/workers-sdk`](https://github.com/cloudflare/workers-sdk) so the bindings we exercise track real-world fixtures instead of drifting on their own.

- The pinned upstream commit and curated fixture subset are tracked in [`examples/upstream.lock.json`](./examples/upstream.lock.json).
- Resync (or refresh after bumping the commit) with:

  ```bash
  bun run scripts/sync-examples.ts
  ```

- The verification matrix — fixture → working / expected-failure → exact `workers-native serve` command (including any `--config` / `--env` / `--native-config` flag) — lives in [`examples/README.md`](./examples/README.md).

The matrix is intentionally focused on **binding behavior** (which shapes work, which fail at request time, why) and links back here for implementation details.

### Overriding bindings entirely

For total control, pass `miniflare: { workers: [...] }` to `runMiniflareHost` to bypass Wrangler-derived bindings and supply the full Miniflare worker array yourself.

## `worker-native.toml` reference

`worker-native.toml` is an **optional** opt-in config file, auto-discovered at your app root. It lets you register auxiliary Workers that aren't surfaced by Wrangler (see [Case 2](#case-2--callee-is-owned-by-your-process-but-not-in-wrangler-config) above) without writing code. It is loaded by `worker-native serve` and `runMiniflareHost`.

### Discovery

Resolution order (highest precedence first):

1. CLI flag: `--native-config <path>`
2. Environment variable: `WORKER_NATIVE_CONFIG=<path>`
3. Default: `<app root>/worker-native.toml` (silently ignored if absent)

Relative paths inside the file (e.g. `script_path`, `wrangler_project_root`) are resolved **relative to the directory containing `worker-native.toml`**.

### Top-level schema

```toml
# Zero or more auxiliary Workers, each as its own [[extra_workers]] table.
[[extra_workers]]
name = "auth-worker"
# ... fields below ...
```

Only `[[extra_workers]]` is currently recognized at the top level. Unknown keys are ignored.

### `[[extra_workers]]` fields

Each entry **must** provide a `name` and **exactly one** script source:

- a literal `script`, **or**
- a `script_path`, **or**
- one or more `wrangler_*` fields (triggers an automatic `wrangler deploy --dry-run` bundle).

| Key | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `name` | string | ✅ | — | Worker name. Must match the `[[services]].service` value in the caller's `wrangler.toml`. Duplicate names are deduplicated (last wins); the primary Worker always stays at index 0. |
| `modules` | boolean | | `true` | Whether the script is an ES module Worker (`export default { fetch }`). Set to `false` for service-worker style scripts. |
| `script` | string | one-of | — | Inline Worker source code. Mutually exclusive with `script_path`. |
| `script_path` | string | one-of | — | Path to a pre-bundled Worker entry file, resolved relative to the config directory. Mutually exclusive with `script`. Aliases: `scriptPath`. |
| `compatibility_date` | string | | inherited from Miniflare | Per-worker compatibility date (e.g. `"2025-01-01"`). Alias: `compatibilityDate`. |
| `compatibility_flags` | string[] | | `[]` | Per-worker compatibility flags. Alias: `compatibilityFlags`. |
| `wrangler_project_root` | string | one-of | — | Path to a Wrangler project to bundle on the fly via `wrangler deploy --dry-run`. Triggers wrangler-bundle mode. Alias: `wranglerProjectRoot`. |
| `wrangler_config_path` | string | | auto | Optional path (relative to `wrangler_project_root`) to a specific `wrangler.toml` / `wrangler.jsonc`. Alias: `wranglerConfigPath`. |
| `wrangler_env` | string | | — | Wrangler environment to use for the dry-run bundle (e.g. `"staging"`). Alias: `wranglerEnv`. |
| `bundle_outdir` | string | | `"dist/worker"` | Output directory (relative to `wrangler_project_root`) where the dry-run bundle is materialized and from which it is loaded. Aliases: `bundleOutdir`, `bundle_outdir_relative`, `bundleOutdirRelative`. |

Both `snake_case` (TOML-idiomatic) and `camelCase` spellings are accepted for every multi-word key.

### Examples

Pre-bundled script:

```toml
[[extra_workers]]
name = "auth-worker"
script_path = "./dist/auth/index.js"
modules = true
compatibility_date = "2025-01-01"
compatibility_flags = ["nodejs_compat"]
```

Inline script (handy for tiny stubs):

```toml
[[extra_workers]]
name = "echo-worker"
script = """
export default {
  fetch(req) { return new Response('ok'); }
};
"""
```

Auto-bundle from another Wrangler project:

```toml
[[extra_workers]]
name = "billing-worker"
wrangler_project_root = "../billing-worker"
wrangler_config_path = "wrangler.toml" # optional
wrangler_env = "staging"               # optional
bundle_outdir = "dist/worker"          # optional (default)
```

### Precedence with other sources

When the same Worker `name` is supplied from multiple places, the runtime merges and deduplicates them in this order (lowest → highest precedence):

1. Wrangler-discovered `externalWorkers` (from `unstable_getMiniflareWorkerOptions`).
2. `worker-native.toml` `[[extra_workers]]`.
3. Programmatic `runMiniflareHost({ extraWorkers })`.

The primary Worker always remains at index 0 and is never replaced.

### Validation errors

Common errors raised while loading the file (all prefixed with `worker-native.toml`):

- Root must be a TOML table/object.
- `extra_workers` must be an array of tables.
- Each entry must be a table and must include a non-empty `name`.
- An entry cannot set both `script` and `script_path`.
- An entry must set one of `script`, `script_path`, or any `wrangler_*` bundle field.

## Tests

From this package directory:

```bash
bun run test
bun run typecheck
```

> Note: use `bun run test` (which scopes to `./test`). A bare `bun test` would also walk into `examples/upstream/**`, which contains imported `vitest-pool-workers` tests that are not meant to run here.

## Releasing (maintainers)

Releases use [release-it](https://github.com/release-it/release-it) locally to bump `package.json`, commit, tag (`v*` — must match CI), and push. **`npm publish` and GitHub Releases are handled by [.github/workflows/release.yml](.github/workflows/release.yml)** when the tag lands on the remote (trusted publishing via OIDC).

With a clean working tree on `main`:

```bash
bun run release
```

Use patch/minor/major interactively, or e.g. `bun run release -- minor`.

## Limitations / notes

- **Bindings** for `runMiniflareHost` / `serve` are loaded from your Wrangler config using Wrangler’s **`unstable_readConfig`**, **`unstable_convertConfigBindingsToStartWorkerBindings`** (same normalized shape as for `startRemoteProxySession`), and **`unstable_getMiniflareWorkerOptions`** so Miniflare matches Wrangler’s local-dev binding layout (KV namespaces, vars, etc.). Override with `runMiniflareHost({ miniflare: { … } })` or `--config` / `--env` on the CLI.
- **Opt-in extra worker config:** `worker-native.toml` is auto-discovered from app root. Override path with `--native-config` or `WORKER_NATIVE_CONFIG`. Each `[[extra_workers]]` entry can point at `script_path` or trigger a Wrangler dry-run bundle via `wrangler_project_root` (+ optional `wrangler_config_path`, `wrangler_env`, `bundle_outdir`).
- **`wrangler` must resolve** from the app’s `package.json` (via `createRequire`). If `APP_DIR` is a disposable directory, set **`WRANGLER_PROJECT_ROOT`** (or `runMiniflareHost({ wranglerProjectRoot })`) to your real Worker project so Node can find `node_modules/wrangler` while persistence still uses `APP_DIR`.
- Runtime layout expects materialized bundles under **`$APP_DIR/dist/worker`** and persistence under **`$APP_DIR/dist/miniflare-storage`** by default (`APP_DIR` env or current working directory after `chdir`).

## License

MIT 2026 Geoff Seemueller
