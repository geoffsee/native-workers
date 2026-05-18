import { resolve } from "node:path";
import { createWorkerdBundlerPlugin } from "./workerd-bundler-plugin.ts";
import { writeEmbedManifest } from "./embed-manifest.ts";
import { compileGatewayPath, embedManifestPath } from "./paths-generated.ts";
import { writeCompileGateway } from "./write-compile-gateway.ts";
import { resolveBunCompileTarget } from "./bun-compile-target.ts";
import {
	compileNativeExecutable,
	defaultBinOutPath,
	defaultMiniflareBinaryName,
	defaultStandaloneBinaryName,
} from "./native-compile.ts";
import { resolveBundledJsEntry } from "./resolve-bundle-entry.ts";
import { resolveWorkerdExecutable } from "./workerd-path.ts";
import { runWranglerDeployDryRun } from "./wrangler-dry-run.ts";

export type BuildNativePipelineOptions = {
	/** Directory containing `wrangler.toml` / `wrangler.jsonc` and `package.json`. */
	projectRoot: string;
	/**
	 * Output directory for `wrangler deploy --dry-run --outdir`, relative to `projectRoot`.
	 * @default "dist/worker"
	 */
	bundleOutdirRelative?: string;
	/**
	 * When true, embed `workerd` + bundle and compile the Miniflare host binary.
	 * When false, compile the worker bundle alone (Workers runtime APIs will not match production).
	 */
	miniflare?: boolean;
	/** Native binary output path. Defaults to `<projectRoot>/dist/bin/worker` or `worker-miniflare`. */
	outfile?: string;
};

export type BuildNativePipelineResult = {
	bundlePath: string;
	binaryPath: string;
	miniflare: boolean;
};

function log(phase: string, message: string, logger?: (m: string) => void) {
	const line = `[native-worker:${phase}] ${message}`;
	(logger ?? console.error)(line);
}

/**
 * Bundles with Wrangler and compiles a Bun native executable.
 */
export async function buildNativePipeline(
	options: BuildNativePipelineOptions,
	logger?: (message: string) => void,
): Promise<BuildNativePipelineResult> {
	const projectRoot = resolve(options.projectRoot);
	const bundleRel = options.bundleOutdirRelative ?? "dist/worker";
	const useMiniflare = options.miniflare ?? false;

	const target = await resolveBunCompileTarget();

	log("bundle", `Wrangler project: ${projectRoot}`, logger);
	log("bundle", `Output directory: ${bundleRel}`, logger);

	const wr = await runWranglerDeployDryRun(projectRoot, bundleRel);
	if (wr.exitCode !== 0) {
		log(
			"bundle",
			`Wrangler exited with code ${wr.exitCode}; aborting.`,
			logger,
		);
		if (wr.stderr.trim()) (logger ?? console.error)(wr.stderr.trimEnd());
		if (wr.stdout.trim()) (logger ?? console.error)(wr.stdout.trimEnd());
		throw new Error(`wrangler deploy --dry-run failed with exit ${wr.exitCode}`);
	}

	const bundlePath = await resolveBundledJsEntry(
		resolve(projectRoot, bundleRel),
	);
	const bundleAbs = resolve(bundlePath);

	if (useMiniflare) {
		const workerdAbs = resolveWorkerdExecutable(projectRoot);
		const manifestPath = embedManifestPath(projectRoot);
		const gatewayPath = compileGatewayPath(projectRoot);

		await writeEmbedManifest(workerdAbs, bundleAbs, manifestPath);
		log("manifest", `Wrote ${manifestPath}`, logger);

		await writeCompileGateway(gatewayPath, {
			manifestImportPath: "./embed-manifest",
		});
		log("gateway", `Wrote ${gatewayPath}`, logger);

		const outfile =
			options.outfile ??
			defaultBinOutPath(projectRoot, defaultMiniflareBinaryName());

		await compileNativeExecutable({
			entry: gatewayPath,
			target,
			outfile,
			plugins: [createWorkerdBundlerPlugin()],
		});
		log("compile", `Wrote ${outfile}`, logger);

		return { bundlePath: bundleAbs, binaryPath: outfile, miniflare: true };
	}

	const outfile =
		options.outfile ??
		defaultBinOutPath(projectRoot, defaultStandaloneBinaryName());

	await compileNativeExecutable({
		entry: bundleAbs,
		target,
		outfile,
	});
	log("compile", `Wrote ${outfile}`, logger);

	return { bundlePath: bundleAbs, binaryPath: outfile, miniflare: false };
}
