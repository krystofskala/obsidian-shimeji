/**
 * Test stub for the `obsidian` module. The real package ships types only (no runtime entry), so
 * anything importing a *value* from it — PackLoader's `normalizePath` — is otherwise untestable:
 * Vite fails to resolve the id before `vi.mock` ever gets a look in. Aliased in vitest.config.ts.
 *
 * Only implement what tests actually exercise, and implement it faithfully: `normalizePath`'s real
 * behavior (backslashes to forward slashes, duplicate separators collapsed, leading/trailing ones
 * trimmed) is load-bearing for the sound-path tests, so a lazy identity stub would let a genuine
 * path bug pass.
 */
export function normalizePath(path: string): string {
	return path
		.replace(/\\/g, "/")
		.replace(/\/{2,}/g, "/")
		.replace(/^\/+|\/+$/g, "");
}

export class Plugin {}
export class PluginSettingTab {}
export class Setting {}
export class Modal {}
export class Notice {}
export class MarkdownView {}
export class WorkspaceWindow {}
export class Menu {}
export const Platform = { isMobile: false };

/** Minimal but honest: real Component's full lifecycle (registerEvent/registerDomEvent/intervals)
 * is never exercised by anything this stub needs to support — only construction and unload() are,
 * since SpeechBubbles/RewriteSelectionModal construct one purely to own whatever
 * MarkdownRenderer.renderMarkdown attaches, unconditionally at construction time (a class field
 * initializer), not lazily behind some code path a test could choose not to reach. */
export class Component {
	private children: Component[] = [];
	load(): void {}
	unload(): void {
		for (const child of this.children) child.unload();
		this.children = [];
	}
	addChild<T extends Component>(child: T): T {
		this.children.push(child);
		return child;
	}
	removeChild<T extends Component>(child: T): T {
		this.children = this.children.filter((c) => c !== child);
		return child;
	}
}

/** Deliberately not a real markdown-to-HTML engine — no test here exercises *what* renders, only
 * that rendering it doesn't throw and lands in the given element. Real embed/link resolution
 * (![[...]], hover previews) needs a live vault and is exactly the kind of thing this plugin's own
 * DOM-heavy UI classes are already treated as IO glue for and left to typecheck/build/manual
 * verification instead — see AiBackendChain's own doc comment for the precedent. */
export const MarkdownRenderer = {
	async renderMarkdown(markdown: string, el: HTMLElement, _sourcePath: string, _component: Component): Promise<void> {
		el.textContent = markdown;
	},
};
