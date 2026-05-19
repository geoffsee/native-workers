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
		console.log(`synced ${spec.localName} (${n} files)`);
	}
	writeMetadata(lock, counts);
	writeReadme(lock);
}

await main();
