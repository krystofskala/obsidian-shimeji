import { describe, expect, it } from "vitest";
import { reconcileStoredSettings, resolveEffectiveSettings, type StoredShimejiSettings } from "../src/platformSettings";
import { DEFAULT_SETTINGS, type ShimejiSettings } from "../src/settings";
import type { AiBackend } from "../src/ai/backends";

function stored(overrides: { desktop?: Partial<ShimejiSettings>; mobileOverrides?: Partial<ShimejiSettings> } = {}): StoredShimejiSettings {
	return {
		desktop: { ...DEFAULT_SETTINGS, ...overrides.desktop },
		mobileOverrides: { ...overrides.mobileOverrides },
	};
}

function backend(name: string): AiBackend {
	return { id: name, name, kind: "anthropic", baseUrl: "", apiKey: `${name}-key`, model: "claude-sonnet-5", dailyLimit: 0 };
}

describe("resolveEffectiveSettings", () => {
	it("on desktop, returns the desktop base exactly as given, by reference", () => {
		const s = stored({ desktop: { scale: 2 } });
		expect(resolveEffectiveSettings(s, false)).toBe(s.desktop);
	});

	it("on mobile with no overrides, matches the desktop base value for value", () => {
		const s = stored({ desktop: { scale: 2, allowDragging: false } });
		expect(resolveEffectiveSettings(s, true)).toEqual(s.desktop);
	});

	it("on mobile, an overridden key uses the override; every other key still inherits desktop", () => {
		const s = stored({
			desktop: { scale: 2, allowDragging: true, maxMascots: 8 },
			mobileOverrides: { allowDragging: false },
		});
		const effective = resolveEffectiveSettings(s, true);
		expect(effective.allowDragging).toBe(false);
		expect(effective.scale).toBe(2);
		expect(effective.maxMascots).toBe(8);
	});

	// resolveEffectiveSettings deep-clones on the way out specifically so this never happens —
	// see its own comment. Without that, an onChange handler that mutates an object/array-valued
	// setting in place (rather than replacing the whole field) would corrupt the desktop base
	// through the shared reference, on a device that was only ever supposed to be overriding it.
	it("on mobile, mutating an object-valued field on the returned settings never reaches back into stored.desktop", () => {
		const s = stored({ desktop: { disabledBehaviors: { somePack: ["Sit"] } } });
		const effective = resolveEffectiveSettings(s, true);
		effective.disabledBehaviors.somePack.push("Walk");
		effective.disabledBehaviors.otherPack = ["Jump"];
		expect(s.desktop.disabledBehaviors).toEqual({ somePack: ["Sit"] });
	});

	it("on mobile, mutating an object-valued field on the returned settings never reaches back into stored.mobileOverrides", () => {
		const s = stored({ mobileOverrides: { disabledBehaviors: { somePack: ["Sit"] } } });
		const effective = resolveEffectiveSettings(s, true);
		effective.disabledBehaviors.somePack.push("Walk");
		expect(s.mobileOverrides.disabledBehaviors).toEqual({ somePack: ["Sit"] });
	});
});

describe("reconcileStoredSettings", () => {
	it("on desktop, the effective settings become the new desktop base, and mobileOverrides is left untouched", () => {
		const s = stored({ mobileOverrides: { allowDragging: false } });
		const effective = { ...s.desktop, scale: 3 };
		const result = reconcileStoredSettings(s, effective, false);
		expect(result.desktop).toBe(effective);
		expect(result.mobileOverrides).toBe(s.mobileOverrides);
	});

	it("on mobile, a key changed away from the desktop value becomes an override", () => {
		const s = stored({ desktop: { allowDragging: true } });
		const effective = { ...resolveEffectiveSettings(s, true), allowDragging: false };
		const result = reconcileStoredSettings(s, effective, true);
		expect(result.mobileOverrides.allowDragging).toBe(false);
	});

	it("on mobile, a key left equal to the desktop value is never added as an override", () => {
		const s = stored({ desktop: { allowDragging: true } });
		const effective = resolveEffectiveSettings(s, true); // nothing changed
		const result = reconcileStoredSettings(s, effective, true);
		expect(result.mobileOverrides.allowDragging).toBeUndefined();
	});

	it("on mobile, a key changed back to match desktop again stops being an override", () => {
		const s = stored({ desktop: { allowDragging: true }, mobileOverrides: { allowDragging: false } });
		const effective = { ...resolveEffectiveSettings(s, true), allowDragging: true };
		const result = reconcileStoredSettings(s, effective, true);
		expect(result.mobileOverrides.allowDragging).toBeUndefined();
	});

	it("on mobile, an object-valued key is compared by content, not by reference", () => {
		const s = stored({ desktop: { disabledBehaviors: { pack: ["Sit"] } } });
		const effective = { ...resolveEffectiveSettings(s, true), disabledBehaviors: { pack: ["Sit"] } }; // same content, fresh object
		const result = reconcileStoredSettings(s, effective, true);
		expect(result.mobileOverrides.disabledBehaviors).toBeUndefined();
	});

	it("on mobile, an object-valued key with genuinely different content becomes an override", () => {
		const s = stored({ desktop: { disabledBehaviors: { pack: ["Sit"] } } });
		const effective = { ...resolveEffectiveSettings(s, true), disabledBehaviors: { pack: ["Sit", "Walk"] } };
		const result = reconcileStoredSettings(s, effective, true);
		expect(result.mobileOverrides.disabledBehaviors).toEqual({ pack: ["Sit", "Walk"] });
	});

	it("on mobile, leaves an unrelated pre-existing override alone when a different key changes", () => {
		const s = stored({ desktop: { allowDragging: true, scale: 2 }, mobileOverrides: { allowDragging: false } });
		const effective = { ...resolveEffectiveSettings(s, true), scale: 5 };
		const result = reconcileStoredSettings(s, effective, true);
		expect(result.mobileOverrides.allowDragging).toBe(false);
		expect(result.mobileOverrides.scale).toBe(5);
	});

	it("round-trips through resolve then reconcile with no changes and ends up with the same overrides", () => {
		const s = stored({ desktop: { scale: 2 }, mobileOverrides: { allowDragging: false } });
		const effective = resolveEffectiveSettings(s, true);
		const result = reconcileStoredSettings(s, effective, true);
		expect(result.mobileOverrides).toEqual(s.mobileOverrides);
	});
});

describe("PLATFORM_SHARED_KEYS (aiBackends never splits per-device)", () => {
	it("on mobile, always reflects the desktop list even when a stale mobileOverrides.aiBackends is sitting in storage", () => {
		const s = stored({
			desktop: { aiBackends: [backend("Anthropic"), backend("Groq")] },
			mobileOverrides: { aiBackends: [backend("Anthropic")] }, // e.g. left over from before this fix
		});
		const effective = resolveEffectiveSettings(s, true);
		expect(effective.aiBackends).toEqual([backend("Anthropic"), backend("Groq")]);
	});

	it("on mobile, editing aiBackends writes straight into the desktop base, not mobileOverrides", () => {
		const s = stored({ desktop: { aiBackends: [backend("Anthropic")] } });
		const effective = { ...resolveEffectiveSettings(s, true), aiBackends: [backend("Anthropic"), backend("Ollama")] };
		const result = reconcileStoredSettings(s, effective, true);
		expect(result.desktop.aiBackends).toEqual([backend("Anthropic"), backend("Ollama")]);
		expect(result.mobileOverrides.aiBackends).toBeUndefined();
	});

	it("a stale mobileOverrides.aiBackends is dropped by the very next mobile save, even with no other change", () => {
		const s = stored({
			desktop: { aiBackends: [backend("Anthropic"), backend("Groq")] },
			mobileOverrides: { aiBackends: [backend("Anthropic")], allowDragging: false },
		});
		const effective = resolveEffectiveSettings(s, true); // nothing changed on this device
		const result = reconcileStoredSettings(s, effective, true);
		expect(result.mobileOverrides.aiBackends).toBeUndefined();
		expect(result.mobileOverrides.allowDragging).toBe(false); // unrelated real override survives
	});

	it("a backend added on mobile is visible back on desktop afterward, same as an edit made on desktop itself", () => {
		const s = stored({ desktop: { aiBackends: [backend("Anthropic")] } });
		const effective = { ...resolveEffectiveSettings(s, true), aiBackends: [backend("Anthropic"), backend("Groq")] };
		const afterMobileSave = reconcileStoredSettings(s, effective, true);
		expect(resolveEffectiveSettings(afterMobileSave, false).aiBackends).toEqual([backend("Anthropic"), backend("Groq")]);
	});
});
