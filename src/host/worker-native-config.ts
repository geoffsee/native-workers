import { dirname, resolve } from "node:path";
import type { WorkerOptions } from "miniflare";
import { resolveBundledJsEntry } from "../build/resolve-bundle-entry.ts";
import { runWranglerDeployDryRun } from "../build/wrangler-dry-run.ts";

type NativeWorkerRawConfig = {
	extra_workers?: unknown;
};

type NativeWorkerRawExtraWorker = {
	name?: unknown;
	modules?: unknown;
	script?: unknown;
	script_path?: unknown;
	scriptPath?: unknown;
	compatibility_date?: unknown;
	compatibilityDate?: unknown;
	compatibility_flags?: unknown;
	compatibilityFlags?: unknown;
	wrangler_project_root?: unknown;
	wranglerProjectRoot?: unknown;
	wrangler_config_path?: unknown;
	wranglerConfigPath?: unknown;
	wrangler_env?: unknown;
	wranglerEnv?: unknown;
	bundle_outdir?: unknown;
	bundleOutdir?: unknown;
	bundle_outdir_relative?: unknown;
	bundleOutdirRelative?: unknown;
};

type NativeWorkerResolvedExtraWorker = {
	name: string;
	modules: boolean;
	script?: string;
	scriptPath?: string;
	compatibilityDate?: string;
	compatibilityFlags?: string[];
};

export type LoadNativeWorkerExtraWorkersArgs = {
	appRoot: string;
	configPath?: string;
	logger?: (message: string) => void;
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function readOptionalString(
	obj: Record<string, unknown>,
	keys: string[],
): string | undefined {
	for (const key of keys) {
		const value = obj[key];
		if (value === undefined) continue;
		if (typeof value !== "string") {
			throw new Error(`Expected "${key}" to be a string.`);
		}
		return value;
	}
	return undefined;
}

function readOptionalBoolean(
	obj: Record<string, unknown>,
	keys: string[],
): boolean | undefined {
	for (const key of keys) {
		const value = obj[key];
		if (value === undefined) continue;
		if (typeof value !== "boolean") {
			throw new Error(`Expected "${key}" to be a boolean.`);
		}
		return value;
	}
	return undefined;
}

function readOptionalStringArray(
	obj: Record<string, unknown>,
	keys: string[],
): string[] | undefined {
	for (const key of keys) {
		const value = obj[key];
		if (value === undefined) continue;
		if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
			throw new Error(`Expected "${key}" to be an array of strings.`);
		}
		return [...value];
	}
	return undefined;
}

function parseRawExtraWorker(
	raw: unknown,
	index: number,
): {
	name: string;
	modules: boolean;
	script?: string;
	scriptPath?: string;
	compatibilityDate?: string;
	compatibilityFlags?: string[];
	wranglerProjectRoot?: string;
	wranglerConfigPath?: string;
	wranglerEnv?: string;
	bundleOutdirRelative?: string;
} {
	if (!isRecord(raw)) {
		throw new Error(
			`worker-native.toml extra_workers[${index}] must be a table/object.`,
		);
	}

	const item = raw as NativeWorkerRawExtraWorker & Record<string, unknown>;
	const name = readOptionalString(item, ["name"]);
	if (!name || name.trim().length === 0) {
		throw new Error(`worker-native.toml extra_workers[${index}].name is required.`);
	}

	return {
		name,
		modules: readOptionalBoolean(item, ["modules"]) ?? true,
		script: readOptionalString(item, ["script"]),
		scriptPath: readOptionalString(item, ["script_path", "scriptPath"]),
		compatibilityDate: readOptionalString(item, [
			"compatibility_date",
			"compatibilityDate",
		]),
		compatibilityFlags: readOptionalStringArray(item, [
			"compatibility_flags",
			"compatibilityFlags",
		]),
		wranglerProjectRoot: readOptionalString(item, [
			"wrangler_project_root",
			"wranglerProjectRoot",
		]),
		wranglerConfigPath: readOptionalString(item, [
			"wrangler_config_path",
			"wranglerConfigPath",
		]),
		wranglerEnv: readOptionalString(item, ["wrangler_env", "wranglerEnv"]),
		bundleOutdirRelative: readOptionalString(item, [
			"bundle_outdir",
			"bundleOutdir",
			"bundle_outdir_relative",
			"bundleOutdirRelative",
		]),
	};
}

async function resolveExtraWorker(
	raw: ReturnType<typeof parseRawExtraWorker>,
	configDir: string,
	logger?: (message: string) => void,
): Promise<NativeWorkerResolvedExtraWorker> {
	if (raw.script && raw.scriptPath) {
		throw new Error(
			`worker-native.toml extra_workers "${raw.name}" cannot set both "script" and "script_path".`,
		);
	}

	const base: NativeWorkerResolvedExtraWorker = {
		name: raw.name,
		modules: raw.modules,
		...(raw.compatibilityDate !== undefined
			? { compatibilityDate: raw.compatibilityDate }
			: {}),
		...(raw.compatibilityFlags !== undefined
			? { compatibilityFlags: raw.compatibilityFlags }
			: {}),
	};

	if (raw.script) {
		return { ...base, script: raw.script };
	}

	if (raw.scriptPath) {
		return { ...base, scriptPath: resolve(configDir, raw.scriptPath) };
	}

	const usesWranglerBundle =
		raw.wranglerProjectRoot !== undefined ||
		raw.wranglerConfigPath !== undefined ||
		raw.wranglerEnv !== undefined ||
		raw.bundleOutdirRelative !== undefined;

	if (!usesWranglerBundle) {
		throw new Error(
			`worker-native.toml extra_workers "${raw.name}" must set one of: script, script_path, or wrangler_* bundle fields.`,
		);
	}

	const wranglerProjectRoot = resolve(configDir, raw.wranglerProjectRoot ?? ".");
	const bundleOutdirRelative = raw.bundleOutdirRelative ?? "dist/worker";

	logger?.(
		`[worker-native:config] Bundling extra worker "${raw.name}" from ${wranglerProjectRoot} -> ${bundleOutdirRelative}`,
	);

	const wr = await runWranglerDeployDryRun(
		wranglerProjectRoot,
		bundleOutdirRelative,
		{
			configPath: raw.wranglerConfigPath,
			envName: raw.wranglerEnv,
		},
	);
	if (wr.exitCode !== 0) {
		const details = [wr.stderr.trim(), wr.stdout.trim()].filter(Boolean).join("\n");
		throw new Error(
			`Failed to bundle extra worker "${raw.name}" via wrangler dry-run (exit ${wr.exitCode}).${details ? `\n${details}` : ""}`,
		);
	}

	const bundlePath = await resolveBundledJsEntry(
		resolve(wranglerProjectRoot, bundleOutdirRelative),
	);
	return { ...base, scriptPath: resolve(bundlePath) };
}

export async function loadNativeWorkerConfigExtraWorkers(
	args: LoadNativeWorkerExtraWorkersArgs,
): Promise<WorkerOptions[]> {
	const configPath =
		args.configPath !== undefined
			? resolve(args.appRoot, args.configPath)
			: resolve(args.appRoot, "worker-native.toml");

	const configFile = Bun.file(configPath);
	const exists = await configFile.exists();
	if (!exists) {
		if (args.configPath !== undefined) {
			throw new Error(`worker-native config file not found: ${configPath}`);
		}
		return [];
	}

	const parsed = Bun.TOML.parse(await configFile.text()) as NativeWorkerRawConfig;
	if (!isRecord(parsed)) {
		throw new Error(`worker-native.toml must contain a TOML table/object root.`);
	}

	const rawExtraWorkers = parsed.extra_workers;
	if (rawExtraWorkers === undefined) {
		return [];
	}
	if (!Array.isArray(rawExtraWorkers)) {
		throw new Error(`worker-native.toml "extra_workers" must be an array of tables.`);
	}

	const configDir = dirname(configPath);
	const resolved: NativeWorkerResolvedExtraWorker[] = [];
	for (let i = 0; i < rawExtraWorkers.length; i += 1) {
		const raw = rawExtraWorkers[i];
		const parsedWorker = parseRawExtraWorker(raw, i);
		resolved.push(await resolveExtraWorker(parsedWorker, configDir, args.logger));
	}

	return resolved.map((w) => {
		const out: WorkerOptions = {
			name: w.name,
			modules: w.modules,
			...(w.compatibilityDate !== undefined
				? { compatibilityDate: w.compatibilityDate }
				: {}),
			...(w.compatibilityFlags !== undefined
				? { compatibilityFlags: w.compatibilityFlags }
				: {}),
		};

		if (w.script !== undefined) out.script = w.script;
		if (w.scriptPath !== undefined) out.scriptPath = w.scriptPath;
		return out;
	});
}
