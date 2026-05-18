/**
 * Resolves the `Bun.build` `compile.target` triple for the current host OS.
 */
export async function resolveBunCompileTarget(): Promise<Bun.Build.CompileTarget> {
	const platform = process.platform;
	const arch = process.arch;

	if (platform === "darwin") {
		if (arch === "arm64") return "bun-darwin-arm64";
		if (arch === "x64") return "bun-darwin-x64";
	}

	if (platform === "linux") {
		let musl = false;
		try {
			musl = await Bun.file("/etc/alpine-release").exists();
		} catch {
			musl = false;
		}

		if (arch === "arm64") {
			return musl ? "bun-linux-arm64-musl" : "bun-linux-arm64";
		}
		if (arch === "x64") {
			return musl ? "bun-linux-x64-musl" : "bun-linux-x64";
		}
	}

	if (platform === "win32") {
		if (arch === "arm64") return "bun-windows-arm64";
		if (arch === "x64") return "bun-windows-x64";
	}

	throw new Error(
		`Unsupported host for Bun.compile (platform=${platform}, arch=${arch}).`,
	);
}
