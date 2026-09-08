/**
 * Bundled into its own separate file, `vault-search.js` (see esbuild.config.mjs), rather than
 * living in main.js's own bundle. `@huggingface/transformers` is, by itself, over half this
 * plugin's total code (see esbuild.config.mjs's own measurement) — every install used to pay the
 * cost of Obsidian parsing/compiling all of it on every single startup, whether or not vault
 * search was ever turned on. embeddings.ts now loads this file at runtime via a dynamic `import()`
 * of its own absolute on-disk path (see main.ts's applyVaultSearchEnabled) instead of importing
 * the package by name — esbuild can only inline a package into main.js's bundle when it can
 * statically resolve the import target at build time, and an absolute path built from a runtime
 * value is never that. This file exists purely so there is something at that path to load: a
 * second, independent esbuild entry point that bundles the package for real.
 */
export * from "@huggingface/transformers";
