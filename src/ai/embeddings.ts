import { requestUrl } from "obsidian";
import type * as Transformers from "@huggingface/transformers";
import type { FeatureExtractionPipeline } from "@huggingface/transformers";

/**
 * Local, in-browser semantic embeddings — the only file in this plugin that touches
 * `@huggingface/transformers` (the maintained successor to `@xenova/transformers`), which is
 * itself the first real runtime dependency this plugin has ever taken on. Everything else in
 * `vaultSearch.ts`/`VaultSearchIndex.ts` depends on the small `Embedder` interface below, not
 * this library directly — the same "pure logic depends on a small interface, one file owns the
 * messy IO" split `ai/providers.ts` already uses for `sendAiMessage`/`providerConfigError`.
 *
 * A small, well-established sentence-embedding model (384-dim), not a generative one — this is
 * the "does this note relate to this question" half of the feature, not the half that writes
 * prose. `device: "wasm"` is forced explicitly rather than left to auto-detection: the package
 * also pulls in `onnxruntime-node` and `sharp` (its Node-native backend and image-preprocessing
 * deps, unused here and irrelevant to a text-only embedding), and Obsidian's desktop app runs in
 * an Electron renderer that genuinely is misdetected as "Node, not browser" by the library's own
 * environment check — a plugin has to run identically on every desktop OS, and WASM is the
 * portable choice a platform-specific native addon is not.
 *
 * That misdetection used to make this request fail outright ("Unsupported device: 'wasm'"): the
 * library decides which devices even exist, at module load, from the same Node-vs-browser check,
 * before this call's `device: "wasm"` is ever read — under the (correct, for real Node) assumption
 * that Node means the native `onnxruntime-node` addon is available, `wasm` was never a legal
 * device to request at all in that branch. Forcing WASM here couldn't fix that by itself; see
 * esbuild.config.mjs's `define` for what actually corrects the misdetection.
 *
 * Both `@huggingface/transformers` itself and the ONNX WASM runtime it needs are loaded lazily,
 * on the first real `embed()` call:
 *
 * - The library's own JS used to be a dynamic `import()` of the bare package name — which reads
 *   as lazy, but isn't: esbuild's own `format: "cjs"`/single-`outfile` build (see
 *   esbuild.config.mjs) can't code-split a dynamic import into a separately-fetched chunk the way
 *   an ESM build with `splitting: true` could, so a bare-name dynamic import still ends up baked
 *   into main.js's own bundle regardless (confirmed by measuring: main.js didn't shrink from
 *   converting a static import to a dynamic one). `loadTransformers` below instead loads
 *   `vaultSearchRuntime`'s own separately-bundled output file (`vault-search.js`, built as its own
 *   esbuild entry point — see esbuild.config.mjs) via a dynamic `import()` of that file's absolute
 *   on-disk path, supplied by main.ts's `loadTransformersModule`. A runtime-computed path (not a
 *   string literal) is exactly what esbuild can't resolve at build time, so main.js's own build
 *   has nothing to inline any more — confirmed by measuring the same way: `@huggingface/
 *   transformers` (over half this plugin's total code) no longer appears in main.js's bundle at
 *   all. The library's own module-level setup (backends/onnx.js's own initialization, its
 *   Node-vs-browser environment check) now only actually runs the first time vault search is
 *   used, not unconditionally at Obsidian's own plugin-load time for every single install
 *   regardless of whether anyone ever turns the feature on.
 * - The WASM runtime binary (not the embedding model — the small engine that runs it) used to
 *   ship as a file committed into this plugin's own folder, resolved via a local resource path.
 *   That only worked in this dev vault, where the file happens to already be sitting on disk —
 *   Obsidian's plugin installer only ever auto-fetches main.js/manifest.json/styles.css from a
 *   release, never an extra folder a plugin happens to also produce, so a real community-plugin
 *   install would have no such file and vault search would fail outright the first time anyone
 *   used it. `ensureCached` below fetches it from the CDN and caches it into the plugin's own
 *   folder instead, the same "downloads once, cached after" shape the embedding model's own
 *   weights already use (env.allowRemoteModels below) — stated plainly in the Vault search
 *   settings copy so neither download is mistaken for a bug.
 *
 * NOT independently verifiable from this environment: fetching either the model or the WASM
 * runtime requires reaching the open internet, which this development sandbox's network policy
 * blocks outright. The pipeline construction and fetch shape below are exercised as far as the
 * network boundary; the actual downloads, WASM loading, and real embedding output need
 * verifying live, in a real Obsidian install with normal internet access.
 */
const MODEL_NAME = "Xenova/all-MiniLM-L6-v2";
/** Must match the filenames the onnxruntime-web CDN build actually serves — see
 * ONNXRUNTIME_WEB_VERSION below for why only this one (plain, non-jsep/jspi/webgpu) variant is
 * fetched. */
const WASM_RUNTIME_FILE = "ort-wasm-simd-threaded.wasm";
const WASM_LOADER_FILE = "ort-wasm-simd-threaded.mjs";
/** Pinned to the exact onnxruntime-web version `@huggingface/transformers` currently resolves to
 * (see package-lock.json) — the WASM binary and the JS glue code driving it have to be the same
 * build, so this needs bumping by hand if that dependency version ever changes. A drift here
 * fails loudly (the model simply won't load, no silent wrong-answer risk) rather than quietly,
 * so it surfaces on the very next live check rather than shipping unnoticed. */
const ONNXRUNTIME_WEB_VERSION = "1.26.0-dev.20260416-b7804b056c";

function cdnUrl(fileName: string): string {
	return `https://cdn.jsdelivr.net/npm/onnxruntime-web@${ONNXRUNTIME_WEB_VERSION}/dist/${fileName}`;
}

export interface Embedder {
	/** A normalized embedding vector for `text` — two calls' outputs are directly comparable by
	 * plain dot product (see vaultSearch.ts's rankRelevant), no separate magnitude to divide out. */
	embed(text: string): Promise<number[]>;
}

/** The small set of file-IO primitives LocalEmbedder needs from the real vault, injected rather
 * than this file importing `App`/`vault.adapter` directly — the same "thunk into what only
 * main.ts has" shape VaultSearchIndex's own constructor already uses for its dataFolder/
 * excludedPaths parameters. Keeps this file just as free of any other Obsidian-specific type as
 * it already is. */
export interface WasmAssetStore {
	exists(fileName: string): Promise<boolean>;
	write(fileName: string, data: ArrayBuffer): Promise<void>;
	resourceUrl(fileName: string): string;
	/** Loads `vault-search.js` — the separately-bundled output that actually contains
	 * `@huggingface/transformers` (see esbuild.config.mjs and vaultSearchRuntime.ts) — via a
	 * dynamic `import()` of its absolute on-disk path. Only main.ts can build that path (it needs
	 * `manifest.dir` plus the real vault filesystem root), so it owns doing the import itself
	 * rather than just handing this file a path string to import on its own. */
	loadTransformersModule(): Promise<typeof Transformers>;
}

let modulePromise: Promise<typeof Transformers> | undefined;

/** Loaded once, reused for every LocalEmbedder instance and every call after. */
function loadTransformers(assets: WasmAssetStore): Promise<typeof Transformers> {
	modulePromise ??= assets.loadTransformersModule();
	return modulePromise;
}

export class LocalEmbedder implements Embedder {
	/** Loaded once, reused for every call after — the model load itself is what's slow (and, on
	 * first use ever, network-dependent), not any individual embedding. */
	private pipelinePromise?: Promise<FeatureExtractionPipeline>;

	constructor(private assets: WasmAssetStore) {}

	/** Fetches `fileName` from the CDN and caches it into the plugin's own folder the first time
	 * it's needed; every call after just resolves the already-cached copy. See this file's own
	 * top comment for why this replaced a file this plugin used to ship directly. */
	private async ensureCached(fileName: string): Promise<string> {
		if (!(await this.assets.exists(fileName))) {
			const response = await requestUrl({ url: cdnUrl(fileName), throw: false });
			if (response.status !== 200) {
				throw new Error(`Couldn't download ${fileName} (HTTP ${response.status}) — vault search needs network access the first time it runs.`);
			}
			await this.assets.write(fileName, response.arrayBuffer);
		}
		return this.assets.resourceUrl(fileName);
	}

	private getPipeline(): Promise<FeatureExtractionPipeline> {
		if (!this.pipelinePromise) {
			this.pipelinePromise = (async () => {
				const { env, pipeline } = await loadTransformers(this.assets);
				// Explicit rather than left to the library's own environment auto-detection, so
				// behavior is the same regardless of how Obsidian's Electron renderer gets
				// classified: always fetch the embedding model from the Hub, never go looking for
				// local model files first.
				env.allowLocalModels = false;
				env.allowRemoteModels = true;
				// `env.backends.onnx.wasm` is typed `Partial<...>` (onnxruntime-common's own Env
				// type isn't guaranteed populated) and separately `readonly` (can't be replaced
				// with a fresh object, only mutated) — but importing anything from this package
				// always runs backends/onnx.js's own module-level setup first, which
				// unconditionally leaves a real object here in every version this plugin has ever
				// seen. A thrown guard satisfies the type honestly, without asserting past a case
				// that would mean this dependency changed shape under us.
				const onnxWasm = env.backends.onnx.wasm;
				if (!onnxWasm) throw new Error("onnxruntime-web's env.wasm was never initialized (unexpected — see LocalEmbedder's getPipeline).");
				const [wasm, mjs] = await Promise.all([this.ensureCached(WASM_RUNTIME_FILE), this.ensureCached(WASM_LOADER_FILE)]);
				onnxWasm.wasmPaths = { wasm, mjs };
				return pipeline("feature-extraction", MODEL_NAME, { device: "wasm" });
			})();
		}
		return this.pipelinePromise;
	}

	async embed(text: string): Promise<number[]> {
		const extractor = await this.getPipeline();
		// Mean-pooled + normalized is the standard way to turn a sentence-transformer's
		// per-token output into one fixed-size vector for the whole input.
		const output = await extractor(text, { pooling: "mean", normalize: true });
		return Array.from(output.data as ArrayLike<number>);
	}
}
