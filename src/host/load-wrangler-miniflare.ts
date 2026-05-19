import { createRequire } from "node:module";
import { join } from "node:path";
import type { WorkerOptions } from "miniflare";

type WranglerModule = {
	unstable_readConfig: (args: { config?: string; env?: string }, options?: { hideWarnings?: boolean }) => import("wrangler").Unstable_Config;
	unstable_convertConfigBindingsToStartWorkerBindings: (
		configBindings: import("wrangler").Unstable_Config,
	) => Record<string, unknown>;
	unstable_getMiniflareWorkerOptions: (
		configOrPath: import("wrangler").Unstable_Config | string,
		env?: string,
		options?: {
			remoteProxyConnectionString?: unknown;
			overrides?: { assets?: unknown; enableContainers?: boolean };
			containerBuildId?: string;
		},
	) => import("wrangler").Unstable_MiniflareWorkerOptions;
};

export type LoadWranglerMiniflareArgs = {
	/** Absolute project root (directory with `package.json` and Wrangler config). */
	appRoot: string;
	/** Path to `wrangler.toml` / `wrangler.json(c)`. When omitted, Wrangler discovers from cwd / app root. */
	configPath?: string;
	/** Named Wrangler environment (e.g. `production`). */
	envName?: string;
};

export type WranglerMiniflareFragment = {
	config: import("wrangler").Unstable_Config;
	/**
	 * Binding map in the shape expected by `startRemoteProxySession` / dev worker tooling.
	 * Miniflare itself consumes {@link workerOptions}; this is exposed for symmetry with Wrangler docs.
	 */
	startWorkerBindings: Record<string, unknown>;
	workerOptions: import("wrangler").Unstable_MiniflareWorkerOptions["workerOptions"];
	externalWorkers: import("wrangler").Unstable_MiniflareWorkerOptions["externalWorkers"];
};

/**
 * Loads normalized Wrangler config from disk and derives Miniflare worker options using the same
 * unstable helpers Wrangler exposes for `getPlatformProxy` / dev (`unstable_getMiniflareWorkerOptions`).
 * Also computes {@link startWorkerBindings} via `unstable_convertConfigBindingsToStartWorkerBindings`
 * (format intended for `startRemoteProxySession`).
 */
export function loadWranglerMiniflareFragment(
	args: LoadWranglerMiniflareArgs,
): WranglerMiniflareFragment {
	const req = createRequire(join(args.appRoot, "package.json"));
	let wrangler: WranglerModule;
	try {
		wrangler = req("wrangler") as WranglerModule;
	} catch (e) {
		throw new Error(
			`worker-native could not resolve the "wrangler" package from ${args.appRoot}. Add wrangler as a dependency.`,
			{ cause: e },
		);
	}

	const config = wrangler.unstable_readConfig(
		{ config: args.configPath, env: args.envName },
		{ hideWarnings: true },
	);

	const startWorkerBindings =
		wrangler.unstable_convertConfigBindingsToStartWorkerBindings(config);

	const { workerOptions, externalWorkers } =
		wrangler.unstable_getMiniflareWorkerOptions(config, args.envName);

	return {
		config,
		startWorkerBindings,
		workerOptions: workerOptions as WranglerMiniflareFragment["workerOptions"],
		externalWorkers,
	};
}

/**
 * Primary worker first (served entrypoint), then any auxiliary workers required by bindings.
 *
 * Implements the "single Miniflare, multiple workers" topology: every Worker that the primary's
 * service / Durable Object bindings reference is included in the resulting array so Miniflare
 * routes between them in-process — no `unsafeDevRegistryPath` needed.
 *
 * The array is composed of:
 *   1. The primary worker built from {@link fragment.workerOptions} and {@link bundlePath}.
 *   2. Auxiliary workers Wrangler discovered (`externalWorkers`) for bindings whose target is
 *      defined inside the same Wrangler config.
 *   3. Caller-supplied {@link extraWorkers} — used to register additional locally-known Workers
 *      that Wrangler did not surface (e.g. bundles owned by this same process but not present in
 *      the primary's `wrangler.toml`).
 *
 * Entries are deduplicated by `name`; later entries override earlier ones, so {@link extraWorkers}
 * can replace an auto-derived auxiliary worker (last-wins). The primary keeps index 0 regardless.
 */
export function buildMiniflareWorkersArray(
	fragment: WranglerMiniflareFragment,
	bundlePath: string,
	extraWorkers: WorkerOptions[] = [],
): WorkerOptions[] {
	const { workerOptions, externalWorkers, config } = fragment;
	const primary: WorkerOptions = {
		modules: true,
		scriptPath: bundlePath,
		...(config.name !== undefined ? { name: config.name } : {}),
		...workerOptions,
	};

	const byName = new Map<string | undefined, WorkerOptions>();
	// Primary always wins index 0; track its name so auxiliaries can't displace it.
	const primaryName = primary.name;
	for (const w of externalWorkers) {
		if (w.name !== undefined && w.name === primaryName) continue;
		byName.set(w.name, w);
	}
	for (const w of extraWorkers) {
		if (w.name !== undefined && w.name === primaryName) continue;
		byName.set(w.name, w);
	}

	return [primary, ...byName.values()];
}
