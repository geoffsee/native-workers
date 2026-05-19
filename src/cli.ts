#!/usr/bin/env bun
import { resolve } from "node:path";
import { buildNativePipeline } from "./build/pipeline.ts";
import { runMiniflareHost } from "./host/miniflare-host.ts";

const VERSION = "0.1.0";

function printHelp(): void {
	console.log(`native-worker ${VERSION}

Usage:
  native-worker build [options]   Bundle with Wrangler, then Bun.compile
  native-worker serve [options]    Run Miniflare locally (development)

Options:
  --project <dir>   Wrangler project root (default: current working directory)
  --config <file>   wrangler.toml / wrangler.json(c) path (serve; default: discover in project)
  --native-config <file>
                    native-worker.toml path (serve; default: ./native-worker.toml if present)
  --env <name>      Wrangler environment name (serve)
  --wrangler-root <dir>
                    Directory whose package.json resolves wrangler (serve; default: project / APP_DIR)
  --bundle-outdir   Relative outdir for wrangler dry-run (default: dist/worker)
  --miniflare       Embed workerd + bundle; compile Miniflare host (build only)
  --outfile <path>  Native binary output path

Environment:
  APP_DIR                      Application root for persistence / chdir (serve + runtime)
  PORT, HOST                   Listen address (serve + runtime)
  WORKER_BUNDLE_PATH           Skip dist/worker discovery (serve + runtime)
  MINIFLARE_WORKERD_PATH       External workerd binary (serve + runtime)
  WRANGLER_CONFIG, WRANGLER_CONFIG_PATH
                               Wrangler config path (serve + runtime)
  NATIVE_WORKER_CONFIG         native-worker.toml path (serve + runtime; optional)
  WRANGLER_PROJECT_ROOT        Package root that resolves the wrangler dependency (serve + runtime; optional if same as APP_DIR)
  WRANGLER_ENV, CF_ENVIRONMENT Wrangler environment name (serve + runtime)
  WRANGLER_COMPATIBILITY_DATE  Overrides compatibility_date from Wrangler config
`);
}

function takeFlag(argv: string[], name: string): string | undefined {
	const i = argv.indexOf(name);
	if (i === -1) return undefined;
	return argv[i + 1];
}

function hasFlag(argv: string[], name: string): boolean {
	return argv.includes(name);
}

function shiftCommand(argv: string[]): string | undefined {
	return argv.shift();
}

async function cmdBuild(argv: string[]): Promise<void> {
	const projectFlag = takeFlag(argv, "--project");
	const rawOutfile = takeFlag(argv, "--outfile");
	const bundleOutdir = takeFlag(argv, "--bundle-outdir");
	const miniflare = hasFlag(argv, "--miniflare");

	const projectRoot = resolve(projectFlag ?? process.cwd());

	let outfile: string | undefined;
	if (rawOutfile) {
		outfile = resolve(rawOutfile);
	}

	const result = await buildNativePipeline(
		{
			projectRoot,
			bundleOutdirRelative: bundleOutdir,
			miniflare,
			outfile,
		},
		(m) => console.error(m),
	);

	console.error(
		`Done.\n  bundle: ${result.bundlePath}\n  binary: ${result.binaryPath}\n  mode: ${result.miniflare ? "miniflare (embed workerd + bundle)" : "standalone bundle"}`,
	);
}

async function cmdServe(argv: string[]): Promise<void> {
	const projectFlag = takeFlag(argv, "--project");
	const configFlag = takeFlag(argv, "--config");
	const nativeConfigFlag = takeFlag(argv, "--native-config");
	const envFlag = takeFlag(argv, "--env");
	const wranglerRootFlag = takeFlag(argv, "--wrangler-root");
	if (projectFlag) {
		process.chdir(resolve(projectFlag));
	}
	await runMiniflareHost({
		wranglerConfigPath: configFlag,
		nativeWorkerConfigPath: nativeConfigFlag,
		wranglerEnv: envFlag,
		wranglerProjectRoot: wranglerRootFlag
			? resolve(wranglerRootFlag)
			: undefined,
	});
}

async function main(): Promise<void> {
	const argv = Bun.argv.slice(2);
	if (argv.length === 0 || argv[0] === "-h" || argv[0] === "--help") {
		printHelp();
		process.exit(argv.length === 0 ? 1 : 0);
	}

	const cmd = shiftCommand(argv);
	if (cmd === "build") {
		await cmdBuild(argv);
		return;
	}
	if (cmd === "serve") {
		await cmdServe(argv);
		return;
	}

	console.error(`Unknown command: ${cmd ?? ""}`);
	printHelp();
	process.exit(1);
}

await main().catch((error) => {
	console.error("[native-worker]", error);
	process.exit(1);
});
