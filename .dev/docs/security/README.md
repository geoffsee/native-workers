# Runtime Security Hotspots

This document calls out the runtime hotspots maintainers should review before changing `workers-native`. It is not a complete threat model; it is a map of code paths where inputs cross trust boundaries, files are materialized, child processes are launched, or Worker bindings are wired together.

## ⚠️ Production Disclaimer

As noted in the main `README.md`, **`workers-native` is not recommended for production use.** It is an experimental tool intended for local development, demos, prototyping, and offline/edge-of-network scenarios. It has not been hardened for production workloads and makes no guarantees about security, performance, stability, or parity with the Cloudflare Workers runtime.

## Runtime Trust Boundaries

`workers-native` sits between a user's local Worker project and several runtime/build systems:

- **Host process**: The generated executable inherits the host environment, current user permissions, and filesystem access.
- **Worker project**: `APP_DIR`, `WRANGLER_PROJECT_ROOT`, Wrangler config files, `worker-native.toml`, and bundled Worker code are user-controlled inputs.
- **Cloudflare tooling**: Wrangler's unstable config helpers produce the Miniflare worker options and binding layout used at runtime.
- **Local runtime**: Miniflare and `workerd` execute Worker code and persist local state under the app directory.

Treat all project-local configuration and bundle paths as trusted-by-the-local-user, not as safe input from an untrusted remote party.

## Hotspot: App Root, `chdir`, and Environment Inputs

The main runtime entry point is `runMiniflareHost()` in `src/host/miniflare-host.ts`.

- `APP_DIR` or the process `cwd` becomes the canonical app root, and the process calls `process.chdir(appRootResolved)`.
- `WRANGLER_PROJECT_ROOT` can change where `wrangler` is resolved from via `createRequire(<root>/package.json)`.
- `PORT`, `HOST`, `WORKER_BUNDLE_PATH`, `WRANGLER_CONFIG`, `WRANGLER_CONFIG_PATH`, `WRANGLER_ENV`, `CF_ENVIRONMENT`, `WORKER_NATIVE_CONFIG`, and `WRANGLER_COMPATIBILITY_DATE` affect runtime behavior.
- `PORT` is range-checked, and `localhost` is normalized to `127.0.0.1`; other path-like environment values are resolved but not sandboxed beyond the configured project roots.

Maintainer guidance: avoid adding new environment-controlled behavior unless the precedence is documented and paths are resolved relative to a clear root.

## Hotspot: Filesystem Materialization and Persistence

The Miniflare host writes runtime files under the canonical app root:

- Embedded `workerd` is copied to `dist/.worker-native-embedded-runtime/workerd` when Bun exposes it from `$bunfs`, then chmodded executable.
- Embedded Worker bundles are written to `dist/worker/index.js`.
- Miniflare persistence defaults to `dist/miniflare-storage`, with `kvPersist` enabled.
- Build-time generated files are written under `.worker-native/` and `dist/` by the native build pipeline.

Maintainer guidance: any new write path should stay inside the app root by default, be deterministic, and avoid following user-controlled paths into surprising locations. Be especially careful with changes that copy executable files or overwrite bundle entries.

## Hotspot: Bundle Discovery and Worker Code Loading

When no `WORKER_BUNDLE_PATH` or embedded bundle path is provided, the host resolves a bundle from `dist/worker`.

- Preferred filenames are `index.js`, `worker.js`, and `bundle.js`.
- Otherwise exactly one non-map `*.js` file must exist, or startup fails as missing/ambiguous.
- The selected file becomes the primary Worker `scriptPath` passed to Miniflare.

Maintainer guidance: keep ambiguity checks strict. Relaxing bundle discovery can cause the host to execute a different local file than the maintainer or user expected.

## Hotspot: Networking and Local Exposure

The Miniflare host starts an HTTP server from `runMiniflareHost()` and exposes the bundled Worker over the configured listen address.

- The default listener is `127.0.0.1:8787`, and `HOST=localhost` is normalized to `127.0.0.1` to avoid IPv6/IPv4 ambiguity.
- `HOST` and `PORT` come from the parent environment, and callers can also override Miniflare options programmatically through `options.miniflare`.
- Binding to `0.0.0.0`, a LAN interface, or a forwarded/container port can expose the local Worker, its routes, and any emulated bindings to other machines.
- Worker code still has runtime networking capabilities such as `fetch()`, and Wrangler-derived bindings may point at local or remote services depending on the user's config.
- The process does not add authentication, TLS termination, request filtering, egress controls, or network sandboxing around Miniflare or `workerd`.

Maintainer guidance: treat changes to listener defaults, host normalization, proxy behavior, forwarded ports, service bindings, and outbound network access as security-sensitive. Keep loopback binding as the safe default, document any intentional public bind, and avoid logging request data, headers, URLs with credentials, or remote service responses.

## Hotspot: Wrangler Config and Binding Translation

`src/host/load-wrangler-miniflare.ts` loads `wrangler` from the configured project root and calls Wrangler's unstable helpers:

- `unstable_readConfig()` reads Wrangler configuration.
- `unstable_convertConfigBindingsToStartWorkerBindings()` normalizes binding data.
- `unstable_getMiniflareWorkerOptions()` produces Miniflare `workerOptions` and `externalWorkers`.

These APIs define the binding surface that Miniflare will emulate locally. They also mean runtime behavior can shift when users change their installed `wrangler` version.

Maintainer guidance: review binding-related changes against real Wrangler fixtures and keep `wrangler` as a peer dependency so users can choose their tooling version and receive upstream security fixes.

## Hotspot: Multi-Worker Routing and `worker-native.toml`

Service bindings are routed in-process by constructing a single Miniflare `workers` array:

1. Primary Worker from the bundled Worker entry and Wrangler-derived options.
2. Wrangler-discovered `externalWorkers`.
3. Extra workers from `worker-native.toml`.
4. Programmatic `extraWorkers`.

Auxiliary workers are deduplicated by `name`, later entries win, and the primary Worker is protected from replacement. `worker-native.toml` can provide inline `script`, local `script_path`, or `wrangler_*` fields that trigger an extra Wrangler dry-run bundle.

Maintainer guidance: preserve primary-worker protection and be cautious with any change that alters precedence. `worker-native.toml` is local code/config execution input; do not treat it as safe to consume from untrusted sources.

## Hotspot: Child Process Execution

Wrangler bundling is performed by `runWranglerDeployDryRun()` in `src/build/wrangler-dry-run.ts`.

- It creates the configured output directory.
- It launches `npx wrangler deploy --dry-run --outdir <relativeOutdir>` with `Bun.spawn()` and an argument array.
- Optional `--config` and `--env` values are appended as arguments, not interpolated through a shell.
- The child process inherits `process.env`.

Maintainer guidance: continue using argument arrays instead of shell strings. Consider the inherited environment sensitive, because package-manager and Wrangler credentials may be available to the child process.

## Hotspot: Native Compilation and Embedded Runtime

The build pipeline in `src/build/pipeline.ts` can compile either:

- a standalone Bun executable for the bundled Worker, or
- a Miniflare host executable that embeds both the Worker bundle and a `workerd` binary.

For Miniflare builds, `writeEmbedManifest()` embeds absolute paths with Bun `with { type: "file" }`, and `writeCompileGateway()` sets `MINIFLARE_WORKERD_PATH` before importing the host. At runtime, embedded files may be exposed through Bun's virtual filesystem and materialized to disk before `workerd` starts.

Maintainer guidance: changes to compile gateway generation, workerd resolution, or embed manifest paths should be reviewed as executable-loading changes.

## Hotspot: Secrets and Local State

`workers-native` does not provide a secret store.

- Native executables inherit the parent process environment.
- Wrangler and Miniflare may read local Worker conventions such as `.dev.vars` depending on project configuration.
- Miniflare state is persisted locally under `dist/miniflare-storage` unless callers override options.

Maintainer guidance: avoid logging environment variables, binding values, or persisted data. Runtime diagnostics should report paths and worker names, not secret contents.

## Supply Chain Context

The runtime depends on Bun, Wrangler, Miniflare, and `workerd` behavior.

- `bun.lock` pins development dependency resolution.
- CI installs with `bun install --frozen-lockfile`, typechecks, and tests on Linux and macOS.
- Releases use npm trusted publishing through GitHub Actions OIDC.
- `miniflare`, `workerd`, and `wrangler` are peer dependencies so consuming projects can control versions and security updates.

Maintainer guidance: security-sensitive runtime changes should be validated against the supported peer dependency ranges, not only the versions installed in this repository.

## Reporting a Vulnerability

If you discover a security vulnerability in `workers-native`, please report it by opening a GitHub Issue. For sensitive disclosures, contact the maintainers directly if a security policy with an email is provided in the future. Currently, public issues are the primary communication channel.
