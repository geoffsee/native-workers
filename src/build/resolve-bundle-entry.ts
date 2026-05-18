import { basename, join } from "node:path";

const PREFERRED_ENTRIES = ["index.js", "worker.js", "bundle.js"] as const;

/**
 * Picks the single JS entry emitted by Wrangler `deploy --dry-run --outdir` when the canonical name is unknown.
 */
export async function resolveBundledJsEntry(outDir: string): Promise<string> {
	for (const name of PREFERRED_ENTRIES) {
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
			`No bundled JavaScript entry found in ${outDir} after Wrangler dry-run.`,
		);
	}

	if (matches.length > 1) {
		const names = matches.map((p) => basename(p)).sort().join(", ");
		throw new Error(
			`Ambiguous bundle output in ${outDir}: ${names}. Expected a single top-level .js file.`,
		);
	}

	const chosen = matches[0];
	if (!chosen) {
		throw new Error(`Unexpected: empty matches in ${outDir}`);
	}

	return chosen;
}
