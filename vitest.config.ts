import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
	// The `obsidian` package is types-only and has no runtime entry, so Vite cannot resolve it at
	// all — which made every module importing a value from it (PackLoader's normalizePath)
	// untestable, `vi.mock` included: resolution fails before the mock is consulted. See the stub.
	resolve: {
		alias: { obsidian: resolve(__dirname, "test/stubs/obsidian.ts") },
	},
	test: {
		environment: "jsdom",
	},
});
