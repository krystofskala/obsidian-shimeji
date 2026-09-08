import esbuild from "esbuild";
import process from "process";
import fs from "node:fs";
import path from "node:path";
import builtins from "builtin-modules";

const production = process.argv[2] === "production";

/** Per-machine target: the real Obsidian vault's plugin folder to copy build output into after
 * every build, so `npm run dev`/`npm run build` alone is "live" — no manual copy step, and no
 * Obsidian-Sync-visible junction/symlink sitting inside the vault pointing back at this whole dev
 * repo (node_modules, .git, and all). Deliberately a local, gitignored file rather than an
 * argument or a hardcoded path: this repo runs on more than one machine (e.g. a work PC and a
 * home PC sharing the same synced vault under different absolute paths), and the target has no
 * reason to be the same path twice, let alone committed. Missing file (nothing configured yet, or
 * a machine — like this one — with no real vault at all) just skips the copy silently. */
const vaultPluginDir = (() => {
	const configPath = path.join(process.cwd(), "vault-plugin-path.local.txt");
	if (!fs.existsSync(configPath)) return undefined;
	const configured = fs.readFileSync(configPath, "utf8").trim();
	return configured || undefined;
})();

/** Copies every build output file that currently exists in the repo root into vaultPluginDir,
 * creating it if needed. Attached to both contexts below so either one's rebuild (main.ts changed,
 * or just vaultSearchRuntime.ts) re-syncs everything — copying the other, unchanged file again is
 * harmless and keeps this simple rather than tracking which output belongs to which context. */
function copyToVaultPlugin() {
	return {
		name: "copy-to-vault",
		setup(build) {
			build.onEnd((result) => {
				if (!vaultPluginDir || result.errors.length > 0) return;
				fs.mkdirSync(vaultPluginDir, { recursive: true });
				for (const fileName of ["main.js", "manifest.json", "styles.css", "vault-search.js"]) {
					const source = path.join(process.cwd(), fileName);
					if (fs.existsSync(source)) fs.copyFileSync(source, path.join(vaultPluginDir, fileName));
				}
				console.log(`[copy-to-vault] synced to ${vaultPluginDir}`);
			});
		},
	};
}

const codemirrorExternal = [
	"@codemirror/autocomplete",
	"@codemirror/collab",
	"@codemirror/commands",
	"@codemirror/language",
	"@codemirror/lint",
	"@codemirror/search",
	"@codemirror/state",
	"@codemirror/view",
	"@lezer/common",
	"@lezer/highlight",
	"@lezer/lr",
];

// The actual root cause of the "Unsupported device: 'wasm'" crash the onnxruntime-node/sharp
// externals below are only ever a defensive half-measure for: @huggingface/transformers decides
// which ONNX backend to use, and which devices it considers valid at all, from its own top-level
// `typeof process !== "undefined" && process?.release?.name === "node"` check — evaluated once, at
// module load, before ai/embeddings.ts's `device: "wasm"` request is ever looked at. Obsidian's
// desktop app is a real Electron renderer, where `process` is a real global with
// `release.name === "node"` — genuinely true, not a bug in Electron — so the library concludes
// it's running under plain Node and builds its `supportedDevices` list accordingly: `cpu`/`webgpu`
// only, `wasm` never included, because real Node is expected to reach the native
// `onnxruntime-node` addon instead. This bundle deliberately never ships that addon (a native
// addon needs a different binary per desktop OS, which is exactly what WASM avoids), so forcing
// `device: "wasm"` at the call site was necessary but not sufficient: it just requests a device
// the library had already, unconditionally, decided not to support in this session. Rewriting
// just this one expression at build time — not all of `process`, which real desktop-only code
// elsewhere may still legitimately read — makes the library's own check evaluate false the same
// way it would in an actual browser, regardless of what the real Electron `process` global says
// at runtime. Confirmed empirically (a standalone esbuild bundle of
// `process?.release?.name === "node"` with this same define, run under plain Node) to fold the
// whole expression to a constant `false` at build time, not merely shadow it at runtime. Needed in
// both bundles below: main.js only carries the type of this check (erased), but vault-search.js is
// where the real package — and this exact check — actually lives now.
const browserProcessDefine = { "process.release.name": '"browser"' };

const sharedOptions = {
	bundle: true,
	format: "cjs",
	target: "es2020",
	logLevel: "info",
	sourcemap: production ? false : "inline",
	treeShaking: true,
	minify: production,
};

const mainContext = await esbuild.context({
	...sharedOptions,
	banner: {
		js: "/* obsidian-shimeji: bundled build, see src/ for source. */",
	},
	entryPoints: ["src/main.ts"],
	// @huggingface/transformers is deliberately never resolvable from here — see
	// vaultSearchRuntime.ts and embeddings.ts's loadTransformers. Nothing in main.ts's own import
	// graph references the package by name any more (only by an ambient type, which esbuild's own
	// TypeScript support erases before bundling even starts), so there is nothing left for this
	// build to accidentally inline.
	external: ["obsidian", "electron", ...codemirrorExternal, ...builtins],
	define: browserProcessDefine,
	outfile: "main.js",
	plugins: [copyToVaultPlugin()],
});

// A second, independent bundle: the one place `@huggingface/transformers` (and the onnxruntime-web
// backend it pulls in) actually gets compiled in. Loaded by embeddings.ts at runtime, only once
// vault search is actually turned on — see vaultSearchRuntime.ts's own top comment for why this
// has to be a real separate esbuild entry point rather than a dynamic import() inside main.ts's own
// bundle (the two build to the same result either way; splitting main.ts's build wouldn't help on
// its own without this).
const vaultSearchContext = await esbuild.context({
	...sharedOptions,
	entryPoints: ["src/ai/vaultSearchRuntime.ts"],
	// Same reasoning as main's own external list for onnxruntime-node/sharp (see the comment
	// above): neither is ever reachable through the browser build this bundle actually resolves
	// to, and declaring them external turns "unreachable today" into "can never silently get
	// bundled in" if a future dependency bump ever changes that.
	external: ["onnxruntime-node", "sharp", ...builtins],
	define: browserProcessDefine,
	outfile: "vault-search.js",
	plugins: [copyToVaultPlugin()],
});

if (production) {
	await mainContext.rebuild();
	await vaultSearchContext.rebuild();
	process.exit(0);
} else {
	await mainContext.watch();
	await vaultSearchContext.watch();
}
