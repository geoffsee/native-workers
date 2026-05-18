import { chmod, mkdir, realpath } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import type { MiniflareOptions } from "miniflare";
import { Miniflare } from "miniflare";
import {
	buildMiniflareWorkersArray,
	loadWranglerMiniflareFragment,
} from "./load-wrangler-miniflare.ts";

export type MiniflareHostEmbed = {
	embeddedWorkerdPath?: string;
	embeddedWorkerBundlePath?: string;
};

export type RunMiniflareHostOptions = MiniflareHostEmbed & {
	/**
	 * Path to `wrangler.toml` / `wrangler.json(c)` (absolute or relative to {@link wranglerProjectRoot}).
	 * Default: unset → Wrangler discovers config from cwd after `chdir` to the app root.
	 */
	wranglerConfigPath?: string;
	/**
	 * Directory used as `createRequire(.../package.json)` resolution root for `wrangler`.
	 * Defaults to the canonical app root (same as post-`chdir` cwd).
	 */
	wranglerProjectRoot?: string;
	/** Wrangler named environment (e.g. `staging`). */
	wranglerEnv?: string;
	/**
	 * Partial options merged into sensible defaults (after bundle path resolution).
	 * Use to tweak flags, persistence, or override bindings from Wrangler.
	 */
	miniflare?: Partial<MiniflareOptions>;
};

function pathLooksLikeBunFsEmbed(p: string): boolean {
	return p.includes("bunfs");
}

export async function materializeEmbeddedWorkerd(
	sourcePath: string,
	appRootResolved: string,
): Promise<string> {
	const exe = process.platform === "win32" ? "workerd.exe" : "workerd";
	const destDir = resolve(
		join(appRootResolved, "dist", ".native-worker-embedded-runtime"),
	);
	await mkdir(destDir, { recursive: true });
	const dest = resolve(join(destDir, exe));

	if (pathLooksLikeBunFsEmbed(sourcePath)) {
		await Bun.write(dest, Bun.file(sourcePath));
		await chmod(dest, 0o755);
		return dest;
	}

	return resolve(sourcePath);
}

export async function materializeEmbeddedWorkerBundle(
	sourcePath: string,
	appRootResolved: string,
): Promise<string> {
	const dest = resolve(join(appRootResolved, "dist", "worker", "index.js"));
	await mkdir(dirname(dest), { recursive: true });
	await Bun.write(dest, Bun.file(sourcePath));
	return dest;
}

export async function canonicalAppRoot(
	appDirFromEnvOrCwd: string,
): Promise<string> {
	const base = resolve(appDirFromEnvOrCwd);
	await mkdir(base, { recursive: true });
	try {
		return await realpath(base);
	} catch {
		return base;
	}
}

export async function resolveBundledWorkerEntry(outDir: string): Promise<string> {
	const preferred = ["index.js", "worker.js", "bundle.js"] as const;
	for (const name of preferred) {
		const full = join(outDir, name);
		if (await Bun.file(full).exists()) {
			return full;
		}
	}

	const glob = new Bun.Glob("*.js");
	const matches: string[] = [];
	for await (const rel of glob.scan({ cwd: outDir, onlyFiles: true })) {
		if (rel.endsWith(".map")) continue;
		matches.push(join(outDir, rel));
	}

	if (matches.length === 0) {
		throw new Error(
			`No Wrangler bundle found in ${outDir}. Run wrangler deploy --dry-run --outdir, set WORKER_BUNDLE_PATH, or use embedded bundle paths from native-worker build.`,
		);
	}

	if (matches.length > 1) {
		const names = matches.map((p) => basename(p)).sort().join(", ");
		throw new Error(`Ambiguous bundle in ${outDir}: ${names}.`);
	}

	const chosen = matches[0];
	if (!chosen) {
		throw new Error(`Unexpected: empty matches in ${outDir}`);
	}

	return chosen;
}

function normalizeListenHost(hostname: string): string {
	return hostname === "localhost" ? "127.0.0.1" : hostname;
}

/**
 * Runs a local Miniflare server for a Wrangler-produced bundle.
 *
 * When running a Bun-compiled executable, pass Bun file-embed paths via `embed` so workerd and the
 * bundle are materialized onto disk before `workerd` is spawned.
 */
export async function runMiniflareHost(
	options: RunMiniflareHostOptions = {},
): Promise<void> {
	const appRootResolved = await canonicalAppRoot(Bun.env.APP_DIR ?? process.cwd());
	process.chdir(appRootResolved);

	const wranglerModuleRoot = await canonicalAppRoot(
		options.wranglerProjectRoot ??
			Bun.env.WRANGLER_PROJECT_ROOT ??
			appRootResolved,
	);

	const port = Number(Bun.env.PORT ?? "8787");
	const hostname = normalizeListenHost(Bun.env.HOST ?? "127.0.0.1");

	if (!Number.isFinite(port) || port < 1 || port > 65535) {
		throw new Error(`Invalid PORT`);
	}

	const workerOutDir = resolve(join(appRootResolved, "dist", "worker"));
	const persistRoot = resolve(join(appRootResolved, "dist", "miniflare-storage"));
	await mkdir(persistRoot, { recursive: true });

	if (options.embeddedWorkerdPath) {
		const runnable = await materializeEmbeddedWorkerd(
			options.embeddedWorkerdPath,
			appRootResolved,
		);
		Bun.env.MINIFLARE_WORKERD_PATH = runnable;
	}

	let bundlePath: string | undefined = Bun.env.WORKER_BUNDLE_PATH;
	if (!bundlePath) {
		if (options.embeddedWorkerBundlePath) {
			bundlePath = await materializeEmbeddedWorkerBundle(
				options.embeddedWorkerBundlePath,
				appRootResolved,
			);
		} else {
			bundlePath = await resolveBundledWorkerEntry(workerOutDir);
		}
	}

	const wranglerConfigPath =
		options.wranglerConfigPath ??
		Bun.env.WRANGLER_CONFIG ??
		Bun.env.WRANGLER_CONFIG_PATH;
	const wranglerEnv =
		options.wranglerEnv ?? Bun.env.WRANGLER_ENV ?? Bun.env.CF_ENVIRONMENT;

	const wranglerFragment = loadWranglerMiniflareFragment({
		appRoot: wranglerModuleRoot,
		configPath: wranglerConfigPath
			? resolve(appRootResolved, wranglerConfigPath)
			: undefined,
		envName: wranglerEnv,
	});

	const workers = buildMiniflareWorkersArray(wranglerFragment, bundlePath!);
	const primary = workers[0];
	if (primary && Bun.env.WRANGLER_COMPATIBILITY_DATE) {
		primary.compatibilityDate = Bun.env.WRANGLER_COMPATIBILITY_DATE;
	}

	const sharedDefaults = {
		host: hostname,
		port,
		telemetry: { enabled: false } as const,
		liveReload: false,
		defaultPersistRoot: persistRoot,
		kvPersist: true,
	};

	const overrides = options.miniflare ?? {};
	const mf = new Miniflare({
		...sharedDefaults,
		...overrides,
		host: normalizeListenHost(
			(overrides.host as string | undefined) ?? sharedDefaults.host,
		),
		port: overrides.port ?? sharedDefaults.port,
		defaultPersistRoot:
			overrides.defaultPersistRoot ?? sharedDefaults.defaultPersistRoot,
		kvPersist: overrides.kvPersist ?? sharedDefaults.kvPersist,
		workers: overrides.workers ?? workers,
	});

	const url = await mf.ready;

	const bundleNote = options.embeddedWorkerBundlePath
		? "embedded (materialized when under $bunfs)"
		: bundlePath;
	const runtimeNote = options.embeddedWorkerdPath
		? `embedded (${Bun.env.MINIFLARE_WORKERD_PATH ?? "unset"})`
		: (Bun.env.MINIFLARE_WORKERD_PATH ?? "resolved by Miniflare / npm workerd");

	console.error(
		`[native-worker miniflare] Listening at ${url.origin}\n` +
			`[native-worker miniflare] Worker bundle: ${bundleNote}\n` +
			`[native-worker miniflare] workerd: ${runtimeNote}\n` +
			`[native-worker miniflare] Persist root: ${persistRoot}`,
	);

	const dispose = async () => {
		await mf.dispose();
		process.exit(0);
	};

	process.on("SIGINT", () => void dispose());
	process.on("SIGTERM", () => void dispose());

	await new Promise(() => {});
}

/** @deprecated Prefer {@link runMiniflareHost} */
export const runMiniflareHostMain = runMiniflareHost;

async function cliDevMain(): Promise<void> {
	await runMiniflareHost({});
}

if (import.meta.main) {
	cliDevMain().catch((error) => {
		console.error(error);
		process.exit(1);
	});
}
