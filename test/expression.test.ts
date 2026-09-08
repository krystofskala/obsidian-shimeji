import { describe, expect, it, vi } from "vitest";
import { evaluate, evaluateCondition, parseCondition, parseExpression, type ExprContext, type ExprValue } from "../src/shimeji/Expression";

function contextFrom(vars: Record<string, ExprValue>): ExprContext {
	return {
		resolve(path) {
			return vars[path.join(".")];
		},
		call(name, args) {
			if (name === "random") return (typeof args[0] === "number" ? args[0] : 1) / 2;
			return undefined;
		},
	};
}

describe("expression evaluator", () => {
	it("evaluates arithmetic with correct precedence", () => {
		expect(evaluate(parseExpression("2 + 3 * 4"), contextFrom({}))).toBe(14);
		expect(evaluate(parseExpression("(2 + 3) * 4"), contextFrom({}))).toBe(20);
	});

	it("evaluates comparisons and boolean logic", () => {
		expect(evaluate(parseExpression("3 < 5 && 5 > 1"), contextFrom({}))).toBe(true);
		expect(evaluate(parseExpression("3 > 5 || 1 == 1"), contextFrom({}))).toBe(true);
		expect(evaluate(parseExpression("!(1 == 1)"), contextFrom({}))).toBe(false);
	});

	it("evaluates a ternary", () => {
		expect(evaluate(parseExpression("1 < 2 ? 10 : 20"), contextFrom({}))).toBe(10);
	});

	it("resolves dotted identifier paths through the context", () => {
		const ctx = contextFrom({ "mascot.anchor.x": 42 });
		expect(evaluate(parseExpression("mascot.anchor.x"), ctx)).toBe(42);
		expect(evaluate(parseExpression("mascot.anchor.x < 100"), ctx)).toBe(true);
	});

	it("calls functions", () => {
		expect(evaluate(parseExpression("random(10)"), contextFrom({}))).toBe(5);
	});

	it("treats unresolved identifiers as falsy rather than throwing", () => {
		const ctx = contextFrom({});
		expect(evaluate(parseExpression("mascot.somethingUnknown"), ctx)).toBeUndefined();
		expect(evaluateCondition(parseExpression("mascot.somethingUnknown"), ctx)).toBe(false);
	});

	it("parses a wrapped #{...} condition and evaluates it", () => {
		const node = parseCondition("#{mascot.anchor.x < 200}");
		expect(node).toBeDefined();
		expect(evaluateCondition(node, contextFrom({ "mascot.anchor.x": 10 }))).toBe(true);
		expect(evaluateCondition(node, contextFrom({ "mascot.anchor.x": 999 }))).toBe(false);
	});

	it("gracefully defaults to true for unwrapped/unparseable conditions", () => {
		expect(parseCondition("not-a-condition")).toBeUndefined();
		expect(evaluateCondition(parseCondition("not-a-condition"), contextFrom({}))).toBe(true);
		expect(evaluateCondition(undefined, contextFrom({}))).toBe(true);
	});
});

describe("condition diagnostics", () => {
	// Reported live as `#{mascot.totalCount 50}` — two operands, no operator. `<` and `>` are not
	// legal raw characters in an XML attribute value, so a pack writing a bare `<` (or `&lt` without
	// its semicolon) can end up parsed with the operator simply gone. The raw text in the warning
	// then looks almost right, and the actual defect is invisible in it.
	it("names the owning action/behavior and flags a probably-dropped comparison operator", () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		try {
			expect(parseCondition("#{mascot.totalCount 50}", "behavior Evolve")).toBeUndefined();
			const text = warn.mock.calls.map((c) => c.join(" ")).join("\n");
			expect(text).toContain("behavior Evolve");
			expect(text).toContain("&lt;");
		} finally {
			warn.mockRestore();
		}
	});

	it("does not blame XML escaping for a condition that genuinely has an operator", () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		try {
			parseCondition("#{mascot.totalCount < < 50}", "behavior Other");
			const text = warn.mock.calls.map((c) => c.join(" ")).join("\n");
			expect(text).toContain("behavior Other");
			expect(text).not.toContain("&lt;");
		} finally {
			warn.mockRestore();
		}
	});
});
