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
			`native-worker could not resolve the "wrangler" package from ${args.appRoot}. Add wrangler as a dependency.`,
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

/** Primary worker first (served entrypoint), then any auxiliary workers required by bindings. */
export function buildMiniflareWorkersArray(
	fragment: WranglerMiniflareFragment,
	bundlePath: string,
): WorkerOptions[] {
	const { workerOptions, externalWorkers, config } = fragment;
	const primary: WorkerOptions = {
		modules: true,
		scriptPath: bundlePath,
		...(config.name !== undefined ? { name: config.name } : {}),
		...workerOptions,
	};
	return [primary, ...externalWorkers];
}
