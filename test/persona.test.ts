import { describe, expect, it } from "vitest";
import { resolvePersona } from "../src/ai/persona";
import type { MascotPack } from "../src/shimeji/types";

function pack(id: string, name: string): MascotPack {
	return { id, name, actions: new Map(), behaviors: new Map(), resolveImage: (p) => p };
}

describe("resolvePersona", () => {
	it("returns the configured override for that pack, trimmed", () => {
		const p = pack("pack-a", "Jacob");
		const result = resolvePersona(p, new Map([["pack-a", "  You are a grumpy pirate.  "]]));
		expect(result).toContain("You are a grumpy pirate.");
	});

	it("always appends the speak-only rule, override or default alike", () => {
		const p = pack("pack-a", "Jacob");
		const withOverride = resolvePersona(p, new Map([["pack-a", "You are a grumpy pirate."]]));
		const withDefault = resolvePersona(p, new Map());
		expect(withOverride).toContain("no asterisk actions");
		expect(withDefault).toContain("no asterisk actions");
	});

	it("falls back to a generic default when the pack has no override at all", () => {
		const p = pack("pack-a", "Jacob");
		const result = resolvePersona(p, new Map());
		expect(result).toContain("Jacob");
	});

	it("falls back to the generic default when the override is present but blank", () => {
		const p = pack("pack-a", "Jacob");
		expect(resolvePersona(p, new Map([["pack-a", ""]]))).toContain("Jacob");
		expect(resolvePersona(p, new Map([["pack-a", "   "]]))).toContain("Jacob");
	});

	it("only uses this pack's own override, never another pack's", () => {
		const p = pack("pack-a", "Jacob");
		const result = resolvePersona(p, new Map([["pack-b", "You are a grumpy pirate."]]));
		expect(result).not.toContain("pirate");
		expect(result).toContain("Jacob");
	});

	it("interpolates each pack's own name into its default persona", () => {
		const a = resolvePersona(pack("pack-a", "Jacob"), new Map());
		const b = resolvePersona(pack("pack-b", "Momo"), new Map());
		expect(a).toContain("Jacob");
		expect(b).toContain("Momo");
		expect(a).not.toBe(b);
	});

	it("degrades gracefully with no active pack at all", () => {
		expect(() => resolvePersona(undefined, new Map())).not.toThrow();
		expect(resolvePersona(undefined, new Map()).length).toBeGreaterThan(0);
	});
});
