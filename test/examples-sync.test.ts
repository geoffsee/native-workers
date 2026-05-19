#!/usr/bin/env bun
/**
 * Guard tests for the curated examples/upstream import.
 *
 * Two things must stay true across changes to the lock file or the synced tree:
 *   1. The lock file lists *exactly* the curated fixture set (with the exact
 *      sparse subset for `dev-registry`), and the on-disk sync metadata matches
 *      the lock file. This catches accidental additions/removals.
 *   2. Every row documented as "Expected failure" in examples/README.md stays
 *      explicitly marked, so silently flipping a negative-path scenario to
 *      "Working" without re-verification is not possible.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
const LOCK_PATH = join(ROOT, "examples", "upstream.lock.json");
const META_PATH = join(ROOT, "examples", "upstream", ".sync-metadata.json");
const EXAMPLES_README = join(ROOT, "examples", "README.md");

const EXPECTED_FIXTURES = [
	{
		path: "fixtures/workers-with-assets-and-service-bindings",
		localName: "workers-with-assets-and-service-bindings",
		phase: 1,
	},
	{
		path: "fixtures/dev-registry",
		localName: "dev-registry",
		phase: 1,
		include: [
			"workers/**",
			"wrangler.internal-durable-object.jsonc",
			"wrangler.external-durable-object.jsonc",
			"wrangler.nonexistent-durable-object.jsonc",
			"wrangler.nonexistent-entrypoint.jsonc",
		],
	},
	{ path: "fixtures/durable-objects-app", localName: "durable-objects-app", phase: 1 },
	{ path: "fixtures/unbound-durable-object", localName: "unbound-durable-object", phase: 1 },
	{ path: "fixtures/worker-with-resources", localName: "worker-with-resources", phase: 2 },
] as const;

/** Localnames of fixtures that the matrix documents as having at least one expected-failure row. */
const EXPECTED_FAILURE_FIXTURES = [
	"dev-registry",
	"workers-with-assets-and-service-bindings",
	"worker-with-resources",
] as const;

describe("examples/upstream.lock.json", () => {
	const lock = JSON.parse(readFileSync(LOCK_PATH, "utf8"));

	test("pins cloudflare/workers-sdk with a full 40-char commit SHA", () => {
		expect(lock.repo).toBe("cloudflare/workers-sdk");
		expect(lock.commit).toMatch(/^[a-f0-9]{40}$/);
		expect(lock.destRoot).toBe("examples/upstream");
	});

	test("lists exactly the curated fixture set (phase 1 + phase 2)", () => {
		const got = (lock.fixtures as Array<{ path: string; localName: string; phase: number }>)
			.map((f) => ({ path: f.path, localName: f.localName, phase: f.phase }));
		const want = EXPECTED_FIXTURES.map((f) => ({
			path: f.path,
			localName: f.localName,
			phase: f.phase,
		}));
		expect(got).toEqual(want);
	});

	test("dev-registry sparse include list matches the curated subset", () => {
		const devReg = (lock.fixtures as Array<{ localName: string; include?: string[] }>)
			.find((f) => f.localName === "dev-registry");
		expect(devReg).toBeDefined();
		const expected = EXPECTED_FIXTURES.find((f) => f.localName === "dev-registry")!.include!;
		// Order-insensitive but exact set match.
		expect(new Set(devReg!.include)).toEqual(new Set(expected));
		expect(devReg!.include).toHaveLength(expected.length);
	});

	test("at least one fixture is phase 2 (worker-with-resources)", () => {
		const phase2 = (lock.fixtures as Array<{ localName: string; phase: number }>)
			.filter((f) => f.phase === 2)
			.map((f) => f.localName);
		expect(phase2).toContain("worker-with-resources");
	});
});

describe("examples/upstream/.sync-metadata.json", () => {
	test("sync metadata exists and matches the lock file", () => {
		expect(existsSync(META_PATH)).toBe(true);
		const meta = JSON.parse(readFileSync(META_PATH, "utf8"));
		const lock = JSON.parse(readFileSync(LOCK_PATH, "utf8"));
		expect(meta.repo).toBe(lock.repo);
		expect(meta.commit).toBe(lock.commit);
		const metaNames = (meta.fixtures as Array<{ localName: string }>).map((f) => f.localName);
		const lockNames = (lock.fixtures as Array<{ localName: string }>).map((f) => f.localName);
		expect(metaNames).toEqual(lockNames);
		for (const f of meta.fixtures as Array<{ fileCount: number; localName: string }>) {
			expect(f.fileCount).toBeGreaterThan(0);
		}
	});
});

describe("examples/README.md verification matrix", () => {
	const readme = readFileSync(EXAMPLES_README, "utf8");

	test("references every curated fixture by localName", () => {
		for (const f of EXPECTED_FIXTURES) {
			expect(readme).toContain(f.localName);
		}
	});

	test("each documented expected-failure fixture stays explicitly marked", () => {
		for (const localName of EXPECTED_FAILURE_FIXTURES) {
			// Find every matrix row mentioning this fixture and require that at
			// least one of those rows still carries the "Expected failure" marker.
			const rows = readme
				.split("\n")
				.filter((line) => line.startsWith("|") && line.includes(localName));
			expect(rows.length).toBeGreaterThan(0);
			const hasExpectedFailure = rows.some((line) => /Expected failure/i.test(line));
			expect(hasExpectedFailure).toBe(true);
		}
	});

	test("each row exposes a concrete `workers-native serve` command", () => {
		const rows = readme.split("\n").filter((line) => line.startsWith("| ") && line.includes(" | "));
		// Skip the header + alignment rows; keep only data rows that name a fixture.
		const dataRows = rows.filter((line) =>
			EXPECTED_FIXTURES.some((f) => line.includes(f.localName)),
		);
		expect(dataRows.length).toBeGreaterThanOrEqual(EXPECTED_FIXTURES.length);
		for (const row of dataRows) {
			expect(row).toContain("workers-native serve");
			expect(row).toContain("--project ./examples/upstream/");
		}
	});
});
