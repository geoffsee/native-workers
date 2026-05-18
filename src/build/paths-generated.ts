import { join } from "node:path";

export const WORKER_NATIVE_CACHE_DIR_NAME = ".native-worker";

export function defaultWorkerNativeGeneratedDir(projectRoot: string): string {
	return join(projectRoot, WORKER_NATIVE_CACHE_DIR_NAME);
}

export function embedManifestPath(projectRoot: string): string {
	return join(defaultWorkerNativeGeneratedDir(projectRoot), "embed-manifest.ts");
}

export function compileGatewayPath(projectRoot: string): string {
	return join(defaultWorkerNativeGeneratedDir(projectRoot), "compile-gateway.ts");
}
