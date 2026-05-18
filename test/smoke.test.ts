#!/usr/bin/env bun
/**
 * Smoke tests — no Wrangler/network required.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Miniflare } from "miniflare";
import { embedManifestPath, compileGatewayPath } from "../src/build/paths-generated.ts";
import {
	resolveBundledJsEntry,
} from "../src/build/resolve-bundle-entry.ts";
import { writeCompileGateway } from "../src/build/write-compile-gateway.ts";
import { writeEmbedManifest } from "../src/build/embed-manifest.ts";
import { resolveBunCompileTarget } from "../src/build/bun-compile-target.ts";
import { canonicalAppRoot } from "../src/host/miniflare-host.ts";
import {
	buildMiniflareWorkersArray,
	loadWranglerMiniflareFragment,
	type WranglerMiniflareFragment,
} from "../src/host/load-wrangler-miniflare.ts";

describe("paths-generated", () => {
	test("default cache dir naming", () => {
		const root = join("/tmp", "proj");
		expect(embedManifestPath(root)).toBe(
			join(root, ".native-worker", "embed-manifest.ts"),
		);
		expect(compileGatewayPath(root)).toBe(
			join(root, ".native-worker", "compile-gateway.ts"),
		);
	});
});

describe("resolveBundledJsEntry", () => {
	let dir: string;
	afterAll(async () => {
		if (dir) await rm(dir, { recursive: true, force: true });
	});

	test("preferred entry wins when index.js exists alongside other files", async () => {
		dir = await mkdtemp(join(tmpdir(), "wn-bundle-"));
		await writeFile(join(dir, "index.js"), "// x", "utf8");
		await writeFile(join(dir, "extra.js"), "// y", "utf8");
		expect(await resolveBundledJsEntry(dir)).toEndWith("index.js");
	});

	test("ambiguous when multiple non-preferred js files", async () => {
		const d = await mkdtemp(join(tmpdir(), "wn-bundle-amb-"));
		await writeFile(join(d, "a.js"), "// a", "utf8");
		await writeFile(join(d, "b.js"), "// b", "utf8");
		try {
			await expect(resolveBundledJsEntry(d)).rejects.toThrow(/Ambiguous/);
		} finally {
			await rm(d, { recursive: true, force: true });
		}
	});

	test("single non-index file", async () => {
		const d = await mkdtemp(join(tmpdir(), "wn-bundle2-"));
		await writeFile(join(d, "foo.js"), "// z", "utf8");
		try {
			expect(await resolveBundledJsEntry(d)).toEndWith("foo.js");
		} finally {
			await rm(d, { recursive: true, force: true });
		}
	});
});

describe("codegen", () => {
	let dir: string;
	afterAll(async () => {
		if (dir) await rm(dir, { recursive: true, force: true });
	});

	test("writeEmbedManifest imports use JSON string paths", async () => {
		dir = await mkdtemp(join(tmpdir(), "wn-emb-"));
		const manifestPath = embedManifestPath(dir);
		await writeEmbedManifest("/abs/workerd", "/abs/bundle.js", manifestPath);
		const txt = await Bun.file(manifestPath).text();
		expect(txt).toContain('"/abs/workerd"');
		expect(txt).toContain('"/abs/bundle.js"');
		expect(txt).toContain('type: "file"');
	});

	test("writeCompileGateway imports native-worker/host", async () => {
		const d = await mkdtemp(join(tmpdir(), "wn-gw-"));
		try {
			const p = join(d, "gate.ts");
			await writeCompileGateway(p, { manifestImportPath: "./embed-manifest" });
			const txt = await Bun.file(p).text();
			expect(txt).toContain('native-worker/host');
			expect(txt).toContain("MINIFLARE_WORKERD_PATH");
		} finally {
			await rm(d, { recursive: true, force: true });
		}
	});
});

describe("resolveBunCompileTarget", () => {
	test("returns a bun-* triple on supported hosts", async () => {
		const target = await resolveBunCompileTarget();
		expect(target).toMatch(/^bun-/);
	});
});

describe("loadWranglerMiniflareFragment", () => {
	let fixtureDir: string;
	afterAll(async () => {
		if (fixtureDir) await rm(fixtureDir, { recursive: true, force: true });
	});

	test("reads KV bindings from a wrangler.jsonc via Wrangler unstable APIs", async () => {
		// Self-contained fixture: write a minimal wrangler.jsonc into a tmp dir, and
		// resolve `wrangler` from this project's root (where it is a devDependency).
		// Previously this pointed at `../../../app`, which only existed on one machine.
		fixtureDir = await mkdtemp(join(tmpdir(), "wn-wrangler-cfg-"));
		const configPath = join(fixtureDir, "wrangler.jsonc");
		await writeFile(
			configPath,
			JSON.stringify({
				name: "fixture-worker",
				main: "worker.js",
				compatibility_date: "2024-09-23",
				kv_namespaces: [
					{ binding: "TASK_KV", id: "0000000000000000000000000000aaaa" },
				],
			}),
			"utf8",
		);
		// Touch a main file so wrangler config validation is happy.
		await writeFile(
			join(fixtureDir, "worker.js"),
			"export default { fetch() { return new Response('ok'); } };",
			"utf8",
		);

		const appRoot = join(import.meta.dir, "..");
		const { startWorkerBindings, workerOptions } = loadWranglerMiniflareFragment({
			appRoot,
			configPath,
		});
		expect(startWorkerBindings.TASK_KV).toMatchObject({
			type: "kv_namespace",
		});
		expect(workerOptions.kvNamespaces?.TASK_KV).toBeDefined();
	});
});

describe("buildMiniflareWorkersArray", () => {
	function fragmentWith(
		externalWorkers: any[],
		name = "primary",
	): WranglerMiniflareFragment {
		return {
			config: { name } as any,
			startWorkerBindings: {},
			workerOptions: {} as any,
			externalWorkers: externalWorkers as any,
		};
	}

	test("primary is index 0 and Wrangler externals follow", () => {
		const out = buildMiniflareWorkersArray(
			fragmentWith([{ name: "aux", modules: true, script: "" }]),
			"/abs/bundle.js",
		);
		expect(out).toHaveLength(2);
		expect(out[0]?.name).toBe("primary");
		expect((out[0] as any).scriptPath).toBe("/abs/bundle.js");
		expect(out[1]?.name).toBe("aux");
	});

	test("extras are merged with Wrangler externals", () => {
		const out = buildMiniflareWorkersArray(
			fragmentWith([{ name: "aux1", modules: true, script: "" }]),
			"/abs/bundle.js",
			[{ name: "aux2", modules: true, script: "" }],
		);
		expect(out.map((w) => w.name)).toEqual(["primary", "aux1", "aux2"]);
	});

	test("extras override Wrangler externals with the same name (last-wins)", () => {
		const out = buildMiniflareWorkersArray(
			fragmentWith([
				{ name: "aux", modules: true, script: "from-wrangler" },
			]),
			"/abs/bundle.js",
			[{ name: "aux", modules: true, script: "from-extra" }],
		);
		expect(out).toHaveLength(2);
		expect((out[1] as any).script).toBe("from-extra");
	});

	test("primary cannot be displaced by an extra with the same name", () => {
		const out = buildMiniflareWorkersArray(
			fragmentWith([], "primary"),
			"/abs/bundle.js",
			[{ name: "primary", modules: true, script: "evil" }],
		);
		expect(out).toHaveLength(1);
		expect(out[0]?.name).toBe("primary");
		expect((out[0] as any).scriptPath).toBe("/abs/bundle.js");
	});
});

describe("buildMiniflareWorkersArray + Miniflare (integration)", () => {
	let dir: string;
	let mf: Miniflare | undefined;
	afterAll(async () => {
		if (mf) await mf.dispose();
		if (dir) await rm(dir, { recursive: true, force: true });
	});

	test("primary worker routes a request through a service binding to an aux worker registered via extraWorkers", async () => {
		const realTmp = await (await import("node:fs/promises")).realpath(tmpdir());
		dir = await mkdtemp(join(realTmp, "wn-svc-binding-"));

		const fragment: WranglerMiniflareFragment = {
			config: { name: "primary" } as any,
			startWorkerBindings: {},
			workerOptions: {
				compatibilityDate: "2024-09-23",
				scriptPath: undefined,
				modules: [
					{
						type: "ESModule",
						path: "primary.js",
						contents: `export default {
							async fetch(req, env) {
								const downstream = await env.AUX.fetch("https://aux.internal/ping");
								const body = await downstream.text();
								return new Response("primary->" + body, { status: 200 });
							},
						};`,
					},
				],
				serviceBindings: { AUX: "aux" },
			} as any,
			externalWorkers: [] as any,
		};

		const auxExtra = {
			name: "aux",
			modules: true,
			compatibilityDate: "2024-09-23",
			script:
				`export default { async fetch() { return new Response("hello-from-aux"); } };`,
		};

		// bundlePath is unused because workerOptions.modules takes precedence in spread order.
		const workers = buildMiniflareWorkersArray(
			fragment,
			join(dir, "unused.js"),
			[auxExtra as any],
		);
		expect(workers.map((w) => w.name)).toEqual(["primary", "aux"]);

		mf = new Miniflare({
			host: "127.0.0.1",
			port: 0,
			telemetry: { enabled: false },
			liveReload: false,
			workers: workers as any,
		});

		const url = await mf.ready;
		const res = await fetch(new URL("/", url));
		expect(res.status).toBe(200);
		expect(await res.text()).toBe("primary->hello-from-aux");
	}, 30_000);
});

describe("canonicalAppRoot", () => {
	test("creates directory and resolves", async () => {
		const d = await mkdtemp(join(tmpdir(), "wn-root-"));
		try {
			const nested = join(d, "a", "b");
			const rp = await canonicalAppRoot(nested);
			expect(rp).toContain("b");
		} finally {
			await rm(d, { recursive: true, force: true });
		}
	});
});

describe("cli", () => {
	test("--help exits 0", async () => {
		const proc = Bun.spawn(["bun", join(import.meta.dir, "../src/cli.ts"), "--help"], {
			stdout: "pipe",
			stderr: "pipe",
		});
		const code = await proc.exited;
		expect(code).toBe(0);
	});

	test("missing command exits 1", async () => {
		const proc = Bun.spawn(["bun", join(import.meta.dir, "../src/cli.ts")], {
			stdout: "pipe",
			stderr: "pipe",
		});
		const code = await proc.exited;
		expect(code).toBe(1);
	});
});
