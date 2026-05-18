import { mkdir } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

export type NativeCompileOptions = {
	entry: string;
	target: Bun.Build.CompileTarget;
	outfile: string;
	plugins?: Bun.BunPlugin[];
};

/**
 * Compiles a standalone native executable using `Bun.build` with `compile`.
 */
export async function compileNativeExecutable(
	options: NativeCompileOptions,
): Promise<void> {
	await mkdir(dirname(options.outfile), { recursive: true });

	let result: Awaited<ReturnType<typeof Bun.build>>;
	try {
		result = await Bun.build({
			entrypoints: [options.entry],
			plugins: options.plugins,
			compile: {
				target: options.target,
				outfile: options.outfile,
			},
		});
	} catch (error) {
		throw new Error(`Bun.build failed before producing a result`, { cause: error });
	}

	if (!result.success) {
		const logs = result.logs.map((l) => String(l)).join("\n");
		throw new Error(`Bun.compile reported failure:\n${logs}`);
	}
}

export function defaultStandaloneBinaryName(): string {
	return process.platform === "win32" ? "worker.exe" : "worker";
}

export function defaultMiniflareBinaryName(): string {
	return process.platform === "win32" ? "worker-miniflare.exe" : "worker-miniflare";
}

export function defaultBinOutPath(
	projectRoot: string,
	filename: string = defaultStandaloneBinaryName(),
): string {
	return join(projectRoot, "dist", "bin", basename(filename));
}
