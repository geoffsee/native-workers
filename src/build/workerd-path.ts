import { createRequire } from "node:module";
import { join, resolve } from "node:path";

/**
 * Resolves the absolute path to the platform `workerd` binary from the consumer's `node_modules`.
 */
export function resolveWorkerdExecutable(projectRoot: string): string {
	const req = createRequire(join(projectRoot, "package.json"));
	const exported = req("workerd") as string | { default: string };
	const bin =
		typeof exported === "string"
			? exported
			: typeof exported?.default === "string"
				? exported.default
				: undefined;
	if (!bin) {
		throw new Error(
			`Could not resolve workerd executable under ${projectRoot}. Add the "workerd" package as a dependency.`,
		);
	}
	return resolve(bin);
}
