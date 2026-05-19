import { mkdir } from "node:fs/promises";
import { join } from "node:path";

export type WranglerDryRunResult = {
	exitCode: number;
	stdout: string;
	stderr: string;
};

export type WranglerDryRunOptions = {
	configPath?: string;
	envName?: string;
};

/**
 * Runs `npx wrangler deploy --dry-run --outdir <relativeOutdir>` from `projectRoot`.
 */
export async function runWranglerDeployDryRun(
	projectRoot: string,
	relativeOutdir: string,
	options: WranglerDryRunOptions = {},
): Promise<WranglerDryRunResult> {
	const outAbs = join(projectRoot, relativeOutdir);
	await mkdir(outAbs, { recursive: true });

	const args = ["npx", "wrangler", "deploy", "--dry-run", "--outdir", relativeOutdir];
	if (options.configPath) {
		args.push("--config", options.configPath);
	}
	if (options.envName) {
		args.push("--env", options.envName);
	}

	const proc = Bun.spawn(args, {
		cwd: projectRoot,
		env: { ...process.env },
		stdout: "pipe",
		stderr: "pipe",
	});

	const [stdout, stderr, exitCode] = await Promise.all([
		proc.stdout ? new Response(proc.stdout).text() : Promise.resolve(""),
		proc.stderr ? new Response(proc.stderr).text() : Promise.resolve(""),
		proc.exited,
	]);

	return {
		exitCode,
		stdout,
		stderr,
	};
}
