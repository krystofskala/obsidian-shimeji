/**
 * A reference of Obsidian's own documented events, for the Custom triggers picker in settings.ts.
 *
 * Not invented and not guessed — every entry here is copied from the `on(name: '...', ...)`
 * overloads in `node_modules/obsidian/obsidian.d.ts`, the same package this plugin already gets
 * its types from. That makes this list exhaustive for what it claims to be exhaustive of: every
 * event Obsidian's public API fires on `app.workspace`, `app.vault`, or `app.metadataCache` — the
 * three (and only three) singletons in that API that extend `Events` and so can be `.on()`'d at
 * all (`App` itself does not; see the doc comment on `CustomVaultReaction.source`).
 *
 * What it can never be exhaustive of is a community plugin's *own* events — those are minted by
 * that plugin, not documented here, and nothing short of reading that plugin's source could list
 * them. That is why a custom trigger's event-name field stays a free-text input with this only as
 * a `<datalist>` of suggestions, not a closed dropdown: typing a name not on this list is not an
 * error, just not autocompleted.
 *
 * Deliberately excluded: `WorkspaceLeaf`'s own `pinned-change`/`group-change`. Those fire on one
 * particular leaf instance, not on the `workspace` singleton itself, so they don't fit the "bind
 * a name on a shared emitter" model applyCustomVaultReactions uses — wiring them would mean
 * picking (and re-picking, as leaves open and close) which leaf to listen to, a different feature.
 */
export interface ObsidianEventRef {
	name: string;
	desc: string;
}

/** `app.workspace.on(...)` — panes, layout, and editor-chrome events. */
const WORKSPACE_EVENTS: ObsidianEventRef[] = [
	{ name: "file-open", desc: "the active file changed (a new leaf, an existing one, or an embed)" },
	{ name: "active-leaf-change", desc: "the focused pane changed" },
	{ name: "layout-change", desc: "panes were added, closed, split, or rearranged" },
	{ name: "resize", desc: "a pane was resized, or the workspace layout changed" },
	{ name: "quick-preview", desc: "the active markdown file changed, before it's saved to disk" },
	{ name: "editor-change", desc: "an edit was applied in the editor, by the user or a script" },
	{ name: "editor-paste", desc: "the editor received a paste event" },
	{ name: "editor-drop", desc: "the editor received a drop event" },
	{ name: "editor-menu", desc: "the user opened the editor's right-click menu" },
	{ name: "file-menu", desc: "the user opened a file's right-click menu" },
	{ name: "files-menu", desc: "the user opened the right-click menu on several selected files" },
	{ name: "url-menu", desc: "the user opened the right-click menu on an external URL" },
	{ name: "window-open", desc: "a new popout window was created" },
	{ name: "window-close", desc: "a popout window was closed" },
	{ name: "css-change", desc: "the app's CSS/theme changed" },
	{ name: "quit", desc: "the app is about to quit (not guaranteed to run — best effort only)" },
];

/** `app.vault.on(...)` — file-system events for the whole vault. */
const VAULT_EVENTS: ObsidianEventRef[] = [
	{ name: "create", desc: "a file or folder was created (also fires once per file on vault load)" },
	{ name: "modify", desc: "a file was modified — raw and undebounced, unlike the built-in @note:edit" },
	{ name: "delete", desc: "a file or folder was deleted" },
	{ name: "rename", desc: "a file or folder was renamed or moved" },
];

/** `app.metadataCache.on(...)` — events about the vault's indexed links and frontmatter. */
const METADATA_CACHE_EVENTS: ObsidianEventRef[] = [
	{ name: "changed", desc: "a file finished (re)indexing and its cache is now up to date" },
	{ name: "deleted", desc: "a file was deleted and its cache entry removed" },
	{ name: "resolve", desc: "one file's links were resolved against the rest of the vault" },
	{ name: "resolved", desc: "the whole vault finished resolving links (fires again after edits)" },
];

export const OBSIDIAN_EVENTS_BY_SOURCE: Record<"workspace" | "vault" | "metadataCache", ObsidianEventRef[]> = {
	workspace: WORKSPACE_EVENTS,
	vault: VAULT_EVENTS,
	metadataCache: METADATA_CACHE_EVENTS,
};
