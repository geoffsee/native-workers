import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SHIM_NAME = "native-worker-workerd-shim";

const thisDir = dirname(fileURLToPath(import.meta.url));
const shimAbs = join(thisDir, "..", "runtime", "workerd-package-shim.ts");

/**
 * Redirects bare `workerd` imports to the packaged placeholder — real binary is embedded and
 * the generated compile gateway assigns `MINIFLARE_WORKERD_PATH` before Miniflare loads.
 */
export function createWorkerdBundlerPlugin(): Bun.BunPlugin {
	return {
		name: SHIM_NAME,
		setup(build) {
			build.onResolve({ filter: /^workerd$/ }, () => ({
				path: shimAbs,
			}));
		},
	};
}
