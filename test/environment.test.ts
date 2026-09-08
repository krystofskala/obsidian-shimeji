import { afterEach, describe, expect, it } from "vitest";
import { ObsidianDomEnvironment } from "../src/engine/Environment";

function rectAt(top: number, bottom = 0, width = 0): DOMRect {
	return { top, left: 0, right: width, bottom, width, height: bottom - top, x: 0, y: top, toJSON: () => ({}) };
}

function addTabHeaderContainer(rect: { top: number; bottom: number; width: number }): HTMLElement {
	const el = document.createElement("div");
	el.className = "workspace-tab-header-container";
	el.getBoundingClientRect = () => rectAt(rect.top, rect.bottom, rect.width);
	document.body.appendChild(el);
	return el;
}

describe("ObsidianDomEnvironment.getWorldTop", () => {
	afterEach(() => {
		document.querySelectorAll(".workspace-tab-header-container").forEach((el) => el.remove());
	});

	// The real fix (see Environment.ts's own comment): main.ts now injects the real
	// `app.workspace` — a documented, public Obsidian API object — instead of this class
	// guessing a `.workspace` CSS selector, which is what it used to (and still does, as a
	// fallback only) rely on.
	it("reads the injected workspace's containerEl rect when one is provided", () => {
		const containerEl = document.createElement("div");
		containerEl.getBoundingClientRect = () => rectAt(42);
		const env = new ObsidianDomEnvironment({ containerEl });
		expect(env.getWorldTop()).toBe(42);
	});

	it("never returns a negative top (clamped to 0)", () => {
		const containerEl = document.createElement("div");
		containerEl.getBoundingClientRect = () => rectAt(-10);
		const env = new ObsidianDomEnvironment({ containerEl });
		expect(env.getWorldTop()).toBe(0);
	});

	it("falls back to 0 when nothing was injected and no .workspace element exists in the DOM", () => {
		const env = new ObsidianDomEnvironment();
		expect(env.getWorldTop()).toBe(0);
	});

	// Regression coverage for a real, confirmed (not guessed) bug: Obsidian can merge the tab
	// strip into the same row as the title bar's own window controls — a user's own screenshot
	// showed exactly this — in which case app.workspace.containerEl starts at literal y=0
	// (nothing to exclude by that measurement alone) even though the tab-header row itself has a
	// real, nonzero height that's the actual boundary mattering here. A user's own console
	// confirmed `.workspace-tab-header-spacer` (inside `.workspace-tab-header-container`) computes
	// `-webkit-app-region: drag` — this is the real element carrying the drag region.
	it("uses the tab-header row's own bottom edge when workspace.containerEl starts at 0", () => {
		const containerEl = document.createElement("div");
		containerEl.getBoundingClientRect = () => rectAt(0);
		addTabHeaderContainer({ top: 0, bottom: 40, width: 400 });
		const env = new ObsidianDomEnvironment({ containerEl });
		expect(env.getWorldTop()).toBe(40);
	});

	it("unions multiple top-row tab-header containers (side-by-side pane groups) via their max bottom", () => {
		const containerEl = document.createElement("div");
		containerEl.getBoundingClientRect = () => rectAt(0);
		addTabHeaderContainer({ top: 0, bottom: 36, width: 300 });
		addTabHeaderContainer({ top: 0, bottom: 40, width: 300 }); // slightly taller sibling
		const env = new ObsidianDomEnvironment({ containerEl });
		expect(env.getWorldTop()).toBe(40);
	});

	it("ignores a lower pane group's own tab-header row in a vertically-split layout", () => {
		const containerEl = document.createElement("div");
		containerEl.getBoundingClientRect = () => rectAt(0);
		addTabHeaderContainer({ top: 0, bottom: 40, width: 400 }); // the real title-bar row
		addTabHeaderContainer({ top: 300, bottom: 340, width: 400 }); // an unrelated lower pane group
		const env = new ObsidianDomEnvironment({ containerEl });
		expect(env.getWorldTop()).toBe(40);
	});

	it("takes whichever of the two signals excludes more", () => {
		const containerEl = document.createElement("div");
		containerEl.getBoundingClientRect = () => rectAt(50); // e.g. a genuinely separate title bar sibling
		addTabHeaderContainer({ top: 50, bottom: 70, width: 400 }); // tab row inside workspace, taller
		const env = new ObsidianDomEnvironment({ containerEl });
		expect(env.getWorldTop()).toBe(70);
	});
});

describe("ObsidianDomEnvironment.getWorldBottom", () => {
	const originalInnerHeight = window.innerHeight;
	afterEach(() => {
		Object.defineProperty(window, "innerHeight", { value: originalInnerHeight, configurable: true });
	});
	function setInnerHeight(px: number): void {
		Object.defineProperty(window, "innerHeight", { value: px, configurable: true });
	}

	// Regression coverage for a real, reported bug: Obsidian Mobile docks a toolbar to the
	// bottom of the screen, and nothing before this excluded it from the world's floor — an
	// autonomously walking/falling mascot would settle at the literal window bottom, behind
	// that toolbar, reading as "fell below the bottom edge".
	it("reads the injected workspace's containerEl bottom when it stops above the window edge", () => {
		setInnerHeight(800);
		const containerEl = document.createElement("div");
		containerEl.getBoundingClientRect = () => rectAt(0, 740, 400);
		const env = new ObsidianDomEnvironment({ containerEl });
		expect(env.getWorldBottom()).toBe(740);
	});

	it("falls back to window.innerHeight when nothing was injected and no .workspace element exists", () => {
		setInnerHeight(800);
		const env = new ObsidianDomEnvironment();
		expect(env.getWorldBottom()).toBe(800);
	});

	it("never returns more than window.innerHeight, even if the measured rect somehow extends past it", () => {
		setInnerHeight(800);
		const containerEl = document.createElement("div");
		containerEl.getBoundingClientRect = () => rectAt(0, 850, 400);
		const env = new ObsidianDomEnvironment({ containerEl });
		expect(env.getWorldBottom()).toBe(800);
	});

	it("falls back to window.innerHeight when the workspace rect is collapsed (not yet laid out)", () => {
		setInnerHeight(800);
		const containerEl = document.createElement("div");
		containerEl.getBoundingClientRect = () => rectAt(0, 0, 0);
		const env = new ObsidianDomEnvironment({ containerEl });
		expect(env.getWorldBottom()).toBe(800);
	});

	it("falls back to the selector-based .workspace lookup when no workspace was injected", () => {
		setInnerHeight(800);
		const workspaceEl = document.createElement("div");
		workspaceEl.className = "workspace";
		workspaceEl.getBoundingClientRect = () => rectAt(0, 760, 400);
		document.body.appendChild(workspaceEl);
		try {
			const env = new ObsidianDomEnvironment();
			expect(env.getWorldBottom()).toBe(760);
		} finally {
			workspaceEl.remove();
		}
	});

	// Regression coverage for the follow-up report: the .workspace-rect approach above wasn't
	// enough on Mobile — the floor kept landing behind the toolbar again specifically while
	// scrolling through a note, meaning that rect isn't reliably pinned to the toolbar's actual
	// on-screen position the whole time a note scrolls. On mobile this now ignores the rect
	// entirely and reserves a flat pixel margin off window.innerHeight instead — a genuinely
	// viewport-pinned number with nothing scrollable about it.
	describe("on mobile (document.body has the is-mobile class)", () => {
		afterEach(() => {
			document.body.classList.remove("is-mobile");
		});

		it("reserves a fixed margin off window.innerHeight instead of reading any workspace rect", () => {
			setInnerHeight(800);
			document.body.classList.add("is-mobile");
			// Deliberately a rect that would otherwise be trusted (see the "reads the injected
			// workspace's..." case above) — proving the mobile path ignores it outright rather than
			// merely happening to agree with it here.
			const containerEl = document.createElement("div");
			containerEl.getBoundingClientRect = () => rectAt(0, 740, 400);
			const env = new ObsidianDomEnvironment({ containerEl });
			expect(env.getWorldBottom()).toBe(800 - 64);
		});

		it("tracks window.innerHeight directly, exactly as it would if it were a position:fixed element", () => {
			document.body.classList.add("is-mobile");
			const env = new ObsidianDomEnvironment();
			setInnerHeight(600);
			expect(env.getWorldBottom()).toBe(600 - 64);
			// Simulates the address-bar/keyboard-driven resize this fix exists to survive — no
			// rect/layout change needed, just the viewport itself changing height.
			setInnerHeight(500);
			expect(env.getWorldBottom()).toBe(500 - 64);
		});

		it("never returns a negative bottom on a viewport shorter than the reserve", () => {
			setInnerHeight(40);
			document.body.classList.add("is-mobile");
			const env = new ObsidianDomEnvironment();
			expect(env.getWorldBottom()).toBe(0);
		});
	});
});
