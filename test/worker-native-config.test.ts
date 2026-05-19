#!/usr/bin/env bun
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadNativeWorkerConfigExtraWorkers } from "../src/host/worker-native-config.ts";

describe("loadNativeWorkerConfigExtraWorkers", () => {
	const tmpRoots: string[] = [];

	afterAll(async () => {
		await Promise.all(
			tmpRoots.map((dir) => rm(dir, { recursive: true, force: true })),
		);
	});

	test("returns empty array when default worker-native.toml is missing", async () => {
		const root = await mkdtemp(join(tmpdir(), "wn-native-config-missing-"));
		tmpRoots.push(root);

		const out = await loadNativeWorkerConfigExtraWorkers({ appRoot: root });
		expect(out).toEqual([]);
	});

	test("throws when explicit config path does not exist", async () => {
		const root = await mkdtemp(join(tmpdir(), "wn-native-config-explicit-"));
		tmpRoots.push(root);

		await expect(
			loadNativeWorkerConfigExtraWorkers({
				appRoot: root,
				configPath: "./worker-native.toml",
			}),
		).rejects.toThrow(/config file not found/i);
	});

	test("parses script_path relative to config directory", async () => {
		const root = await mkdtemp(join(tmpdir(), "wn-native-config-path-"));
		tmpRoots.push(root);

		const config = `
[[extra_workers]]
name = "auth-worker"
modules = true
script_path = "./dist/auth/index.js"
compatibility_date = "2024-09-23"
compatibility_flags = ["nodejs_compat"]
`;
		await writeFile(join(root, "worker-native.toml"), config, "utf8");

		const out = await loadNativeWorkerConfigExtraWorkers({ appRoot: root });
		expect(out).toHaveLength(1);
		expect(out[0]).toMatchObject({
			name: "auth-worker",
			modules: true,
			scriptPath: join(root, "dist", "auth", "index.js"),
			compatibilityDate: "2024-09-23",
			compatibilityFlags: ["nodejs_compat"],
		});
	});

	test("parses inline script workers", async () => {
		const root = await mkdtemp(join(tmpdir(), "wn-native-config-script-"));
		tmpRoots.push(root);

		const config = `
[[extra_workers]]
name = "aux-inline"
script = "export default { async fetch(){ return new Response('ok'); } };"
`;
		await writeFile(join(root, "worker-native.toml"), config, "utf8");

		const out = await loadNativeWorkerConfigExtraWorkers({ appRoot: root });
		expect(out).toHaveLength(1);
		expect(out[0]).toMatchObject({
			name: "aux-inline",
			modules: true,
		});
		expect((out[0] as any).script).toContain("export default");
	});

	test("supports camelCase aliases", async () => {
		const root = await mkdtemp(join(tmpdir(), "wn-native-config-camel-"));
		tmpRoots.push(root);

		const config = `
[[extra_workers]]
name = "camel-worker"
scriptPath = "./dist/camel/index.js"
compatibilityDate = "2025-01-01"
compatibilityFlags = ["nodejs_compat"]
bundleOutdirRelative = "dist/custom"
`;
		await writeFile(join(root, "worker-native.toml"), config, "utf8");

		const out = await loadNativeWorkerConfigExtraWorkers({ appRoot: root });
		expect(out).toHaveLength(1);
		expect(out[0]).toMatchObject({
			name: "camel-worker",
			scriptPath: join(root, "dist", "camel", "index.js"),
			compatibilityDate: "2025-01-01",
			compatibilityFlags: ["nodejs_compat"],
		});
	});

	test("throws when name is missing", async () => {
		const root = await mkdtemp(join(tmpdir(), "wn-native-config-noname-"));
		tmpRoots.push(root);

		const config = `
[[extra_workers]]
script_path = "./dist/auth/index.js"
`;
		await writeFile(join(root, "worker-native.toml"), config, "utf8");

		await expect(
			loadNativeWorkerConfigExtraWorkers({ appRoot: root }),
		).rejects.toThrow(/name is required/i);
	});

	test("throws when no script/script_path/wrangler bundle fields are set", async () => {
		const root = await mkdtemp(join(tmpdir(), "wn-native-config-empty-worker-"));
		tmpRoots.push(root);

		const config = `
[[extra_workers]]
name = "empty-worker"
`;
		await writeFile(join(root, "worker-native.toml"), config, "utf8");

		await expect(
			loadNativeWorkerConfigExtraWorkers({ appRoot: root }),
		).rejects.toThrow(/must set one of/i);
	});
});
