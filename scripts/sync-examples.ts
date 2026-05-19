#!/usr/bin/env bun
/**
 * Sync curated cloudflare/workers-sdk fixtures into examples/upstream/.
 *
 * Reproducible:
 *   - Reads the upstream commit + curated subset from examples/upstream.lock.json.
 *   - Uses `git sparse-checkout` (cone + filter=blob:none) to materialize only
 *     the requested fixture directories at the pinned commit.
 *   - Re-running the script with the same lock file produces the same tree.
 *
 * Output:
 *   - Files placed under examples/upstream/<localName>/ (mirroring upstream layout).
 *   - examples/upstream/.sync-metadata.json captures resolved commit + per-fixture
 *     file counts; the metadata-guard test reads this so we notice silent drift.
 *
 * Usage:
 *   bun run scripts/sync-examples.ts          # sync into ./examples/upstream
 *   bun run scripts/sync-examples.ts --check  # exit non-zero if tree differs
 *
 * The script intentionally keeps the imported tree read-only: every fixture is
 * referenced from examples/README.md so binding behavior is documented separately
 * from upstream files.
 */
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";

type FixtureSpec = {
	path: string;
	localName: string;
	phase: 1 | 2;
	include?: string[];
};

type Lock = {
	repo: string;
	commit: string;
	destRoot: string;
	fixtures: FixtureSpec[];
};

/**
 * Concrete versions used to rewrite upstream's `workspace:*` / `workspace:^` /
 * `catalog:default` dep specifiers, which only resolve inside the
 * cloudflare/workers-sdk pnpm workspace.
 *
 * - `catalog:*` entries are sourced from
 *   https://github.com/cloudflare/workers-sdk/blob/<commit>/pnpm-workspace.yaml
 *   (the "catalog:" map).
 * - `workspace:*` / `workspace:^` entries are either provided by a local
 *   workspace package under `examples/vendor/*` (e.g. `@cloudflare/workers-tsconfig`)
 *   or pinned to the version already used by the root package.json.
 */
const CATALOG_VERSIONS: Record<string, string> = {
	vitest: "4.1.0",
	undici: "7.24.8",
	typescript: "~5.8.3",
	"@cloudflare/workers-types": "^4.20260518.1",
};

const WORKSPACE_VERSIONS: Record<string, string> = {
	// Provided locally by examples/vendor/workers-tsconfig (kept as a workspace
	// dep so bun resolves it via the root workspaces glob).
	"@cloudflare/workers-tsconfig": "*",
	// Pinned to the versions already declared by the host package.
	wrangler: "^4.92.0",
	miniflare: "^4.20260515.0",
};

const ROOT = resolve(import.meta.dir, "..");
const LOCK_PATH = join(ROOT, "examples", "upstream.lock.json");

function run(cmd: string, args: string[], cwd?: string): void {
	const r = spawnSync(cmd, args, { cwd, stdio: "inherit" });
	if (r.status !== 0) {
		throw new Error(`${cmd} ${args.join(" ")} failed (exit ${r.status})`);
	}
}

function loadLock(): Lock {
	const raw = readFileSync(LOCK_PATH, "utf8");
	const data = JSON.parse(raw) as Lock;
	if (!data.repo || !data.commit || !data.destRoot || !Array.isArray(data.fixtures)) {
		throw new Error(`Malformed lock file at ${LOCK_PATH}`);
	}
	if (!/^[a-f0-9]{40}$/.test(data.commit)) {
		throw new Error(`Lock commit must be a full 40-char SHA, got: ${data.commit}`);
	}
	return data;
}

function fetchUpstream(lock: Lock): string {
	const cache = process.env.WORKERS_NATIVE_SYNC_CACHE
		?? join(tmpdir(), `workers-native-sync-${lock.commit}`);
	if (existsSync(join(cache, ".git"))) {
		return cache;
	}
	mkdirSync(cache, { recursive: true });
	run("git", ["init", "-q"], cache);
	run("git", ["remote", "add", "origin", `https://github.com/${lock.repo}.git`], cache);
	run("git", ["config", "--local", "extensions.partialClone", "origin"], cache);
	run("git", ["sparse-checkout", "init", "--cone"], cache);
	const paths = lock.fixtures.map((f) => f.path);
	run("git", ["sparse-checkout", "set", ...paths], cache);
	run("git", ["fetch", "--depth", "1", "--filter=blob:none", "origin", lock.commit, "-q"], cache);
	run("git", ["checkout", "FETCH_HEAD", "-q"], cache);
	return cache;
}

function globMatch(pattern: string, rel: string): boolean {
	// Tiny matcher: supports leading "dir/**" and exact file names.
	if (pattern.endsWith("/**")) {
		const prefix = pattern.slice(0, -3);
		return rel === prefix || rel.startsWith(prefix + "/");
	}
	return rel === pattern;
}

function copyFixture(srcRoot: string, dstRoot: string, spec: FixtureSpec): number {
	const src = join(srcRoot, spec.path);
	const dst = join(dstRoot, spec.localName);
	rmSync(dst, { recursive: true, force: true });
	mkdirSync(dst, { recursive: true });
	if (!spec.include) {
		cpSync(src, dst, { recursive: true });
		return countFiles(dst);
	}
	// Sparse copy: only the explicitly listed files / directories.
	let count = 0;
	const visit = (currentRel: string): void => {
		const abs = currentRel === "" ? src : join(src, currentRel);
		const st = statSync(abs);
		if (st.isDirectory()) {
			for (const name of readdirSync(abs)) {
				const childRel = currentRel === "" ? name : `${currentRel}/${name}`;
				if (!spec.include!.some((p) => globMatch(p, childRel) || p.startsWith(childRel + "/"))) {
					continue;
				}
				visit(childRel);
			}
			return;
		}
		if (!spec.include!.some((p) => globMatch(p, currentRel))) return;
		const target = join(dst, currentRel);
		mkdirSync(dirname(target), { recursive: true });
		cpSync(abs, target);
		count++;
	};
	visit("");
	return count;
}

/**
 * Rewrite a single dep specifier from upstream-only form to a concrete,
 * publicly-resolvable form. Returns the rewritten value, or null when the
 * specifier is already concrete (anything that does not start with
 * `workspace:` / `catalog:`).
 */
function rewriteDepSpec(name: string, spec: string): string | null {
	if (spec.startsWith("workspace:")) {
		const v = WORKSPACE_VERSIONS[name];
		if (!v) {
			throw new Error(
				`Unmapped workspace dep "${name}@${spec}". Add it to WORKSPACE_VERSIONS in scripts/sync-examples.ts (or vendor it under examples/vendor/).`,
			);
		}
		return v;
	}
	if (spec.startsWith("catalog:")) {
		const v = CATALOG_VERSIONS[name];
		if (!v) {
			throw new Error(
				`Unmapped catalog dep "${name}@${spec}". Add it to CATALOG_VERSIONS in scripts/sync-examples.ts (sourced from upstream pnpm-workspace.yaml).`,
			);
		}
		return v;
	}
	return null;
}

/**
 * Rewrite every dep specifier in a `package.json` body. Mutates `pkg` in place
 * and returns the count of rewrites performed (purely informational).
 */
function patchPackageJsonDeps(pkg: Record<string, unknown>): number {
	let n = 0;
	for (const field of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]) {
		const deps = pkg[field] as Record<string, string> | undefined;
		if (!deps) continue;
		for (const [name, spec] of Object.entries(deps)) {
			const next = rewriteDepSpec(name, spec);
			if (next !== null) {
				deps[name] = next;
				n++;
			}
		}
	}
	return n;
}

/**
 * Patch the broken upstream references inside a freshly-copied fixture so it
 * is self-contained outside the cloudflare/workers-sdk monorepo:
 *
 *   - `package.json`: rewrite `workspace:*` / `catalog:default` specifiers.
 *   - `vitest.config.*`: the upstream config imports `../../vitest.shared`,
 *     which is provided by writeSharedVitestConfig() below.
 *
 * Returns the number of files modified (purely informational).
 */
function patchFixture(fixtureDir: string): number {
	let modified = 0;
	const pkgPath = join(fixtureDir, "package.json");
	if (existsSync(pkgPath)) {
		const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as Record<string, unknown>;
		const n = patchPackageJsonDeps(pkg);
		if (n > 0) {
			writeFileSync(pkgPath, JSON.stringify(pkg, null, "\t") + "\n", "utf8");
			modified++;
		}
	}
	return modified;
}

/**
 * Write the `vitest.shared.ts` file that the fixtures' `vitest.config.mts`
 * files import via `../../vitest.shared`. The fixtures live at
 * `<destRoot>/<fixture>/`, so this file must be placed one directory above
 * `destRoot` (i.e. at `examples/vitest.shared.ts`).
 *
 * Content mirrors cloudflare/workers-sdk's top-level `vitest.shared.ts` and is
 * intentionally minimal so vitest can pick up the per-fixture overrides.
 */
function writeSharedVitestConfig(destRoot: string): void {
	const parent = dirname(destRoot);
	const target = join(parent, "vitest.shared.ts");
	const body = [
		"// Auto-generated by scripts/sync-examples.ts. Do not edit.",
		"// Mirrors cloudflare/workers-sdk's top-level vitest.shared.ts so that the",
		"// fixtures under examples/upstream/<name>/vitest.config.mts (which import",
		"// `../../vitest.shared`) can be loaded outside of the upstream pnpm workspace.",
		"import { defineConfig } from \"vitest/config\";",
		"",
		"export default defineConfig({",
		"\ttest: {",
		"\t\treporters: [\"default\"],",
		"\t\ttestTimeout: 50_000,",
		"\t\thookTimeout: 50_000,",
		"\t\tteardownTimeout: 50_000,",
		"\t\trestoreMocks: true,",
		"\t\tretry: 1,",
		"\t},",
		"});",
		"",
	].join("\n");
	mkdirSync(parent, { recursive: true });
	writeFileSync(target, body, "utf8");
}

function countFiles(dir: string): number {
	let n = 0;
	for (const name of readdirSync(dir)) {
		const p = join(dir, name);
		const st = statSync(p);
		if (st.isDirectory()) n += countFiles(p);
		else n++;
	}
	return n;
}

function writeMetadata(lock: Lock, counts: Record<string, number>): void {
	const meta = {
		generatedBy: "scripts/sync-examples.ts",
		repo: lock.repo,
		commit: lock.commit,
		fixtures: lock.fixtures.map((f) => ({
			localName: f.localName,
			path: f.path,
			phase: f.phase,
			fileCount: counts[f.localName] ?? 0,
		})),
	};
	const dst = join(ROOT, lock.destRoot, ".sync-metadata.json");
	mkdirSync(dirname(dst), { recursive: true });
	writeFileSync(dst, JSON.stringify(meta, null, "\t") + "\n", "utf8");
}

function writeReadme(lock: Lock): void {
	const lines = [
		"# examples/upstream",
		"",
		"This directory is generated by `scripts/sync-examples.ts` from",
		`\`${lock.repo}\` at commit \`${lock.commit}\`.`,
		"",
		"Do not edit files in this directory; edit `examples/upstream.lock.json` and",
		"re-run the sync script instead. See `examples/README.md` for the verification",
		"matrix that maps each fixture to expected outcome and the exact",
		"`workers-native serve` command needed to exercise it.",
		"",
	];
	writeFileSync(join(ROOT, lock.destRoot, "README.md"), lines.join("\n"), "utf8");
}

function listFiles(dir: string): string[] {
	const out: string[] = [];
	const walk = (d: string): void => {
		for (const name of readdirSync(d)) {
			const p = join(d, name);
			const st = statSync(p);
			if (st.isDirectory()) walk(p);
			else out.push(relative(dir, p));
		}
	};
	if (existsSync(dir)) walk(dir);
	return out.sort();
}

async function main(): Promise<void> {
	const check = process.argv.includes("--check");
	const lock = loadLock();
	const upstream = fetchUpstream(lock);
	const destAbs = join(ROOT, lock.destRoot);

	if (check) {
		// Build expected tree in a temp dir and diff against on-disk tree.
		const expectedRoot = join(tmpdir(), `workers-native-expected-${lock.commit}`);
		rmSync(expectedRoot, { recursive: true, force: true });
		mkdirSync(expectedRoot, { recursive: true });
		const counts: Record<string, number> = {};
		for (const spec of lock.fixtures) {
			counts[spec.localName] = copyFixture(upstream, expectedRoot, spec);
		}
		const expected = listFiles(expectedRoot).filter((f) => !f.startsWith(".sync-metadata"));
		const actual = listFiles(destAbs).filter((f) => f !== ".sync-metadata.json" && f !== "README.md");
		if (expected.join("\n") !== actual.join("\n")) {
			console.error("examples/upstream is out of date with examples/upstream.lock.json");
			console.error(`Run: bun run scripts/sync-examples.ts`);
			process.exit(1);
		}
		console.log("examples/upstream is in sync.");
		return;
	}

	rmSync(destAbs, { recursive: true, force: true });
	mkdirSync(destAbs, { recursive: true });
	const counts: Record<string, number> = {};
	for (const spec of lock.fixtures) {
		const n = copyFixture(upstream, destAbs, spec);
		counts[spec.localName] = n;
		// Patch upstream-only refs (workspace:* / catalog:*) so the fixture is
		// resolvable outside of cloudflare/workers-sdk's pnpm workspace.
		const patched = patchFixture(join(destAbs, spec.localName));
		console.log(`synced ${spec.localName} (${n} files${patched > 0 ? `, ${patched} patched` : ""})`);
	}
	// vitest.shared.ts lives one level above destRoot so the fixtures'
	// `import configShared from "../../vitest.shared"` resolves.
	writeSharedVitestConfig(destAbs);
	writeMetadata(lock, counts);
	writeReadme(lock);
}

await main();
