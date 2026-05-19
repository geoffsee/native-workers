/**
 * Miniflare may eagerly resolve the `workerd` npm export before honoring
 * `MINIFLARE_WORKERD_PATH`.
 *
 * When bundling into a Bun-compiled executable, replace the real npm `workerd` module with this
 * placeholder; embed the binary via {@link codegen/write-embed-manifest} and ensure
 * {@link codegen/write-compile-gateway} sets `MINIFLARE_WORKERD_PATH` from the embedded file path before
 * Miniflare loads.
 */

export const compatibilityDate = "2026-05-18";
export const version = "0.0.0-worker-native-shim";

const fallbackPath =
	"/__embedded_worker_native__/workerd-placeholder-if-env-unset";

export default fallbackPath;
