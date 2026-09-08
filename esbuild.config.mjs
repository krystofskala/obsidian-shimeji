import esbuild from "esbuild";
import process from "process";
import builtins from "builtin-modules";

const production = process.argv[2] === "production";

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
});

if (production) {
	await mainContext.rebuild();
	await vaultSearchContext.rebuild();
	process.exit(0);
} else {
	await mainContext.watch();
	await vaultSearchContext.watch();
}
