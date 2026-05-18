import { mkdir } from "node:fs/promises";
import { join } from "node:path";

export type WranglerDryRunResult = {
	exitCode: number;
	stdout: string;
	stderr: string;
};

/**
 * Runs `npx wrangler deploy --dry-run --outdir <relativeOutdir>` from `projectRoot`.
 */
export async function runWranglerDeployDryRun(
	projectRoot: string,
	relativeOutdir: string,
): Promise<WranglerDryRunResult> {
	const outAbs = join(projectRoot, relativeOutdir);
	await mkdir(outAbs, { recursive: true });

	const result =
		await Bun.$`npx wrangler deploy --dry-run --outdir ${relativeOutdir}`
			.cwd(projectRoot)
			.env({ ...process.env })
			.nothrow();

	return {
		exitCode: result.exitCode,
		stdout: result.stdout.toString(),
		stderr: result.stderr.toString(),
	};
}
