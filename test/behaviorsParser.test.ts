import { describe, expect, it } from "vitest";
import { parseBehaviorsXml } from "../src/shimeji/BehaviorsParser";
import { evaluateCondition } from "../src/shimeji/Expression";

const FIXTURE_XML = `<?xml version="1.0"?>
<Mascot>
  <BehaviorList>
    <Behavior Name="Fall" Frequency="0" />
    <Behavior Name="WalkAround" Frequency="100">
      <NextBehavior Add="true">
        <BehaviorReference Name="SitDown" Frequency="5" />
      </NextBehavior>
    </Behavior>
    <Behavior Name="SitDown" Frequency="50" Condition="#{mascot.grounded}" />
    <Behavior Name="FlatList" Frequency="10" NextBehaviorList="WalkAround, SitDown" />
    <Condition Condition="#{mascot.onFloor}">
      <Behavior Name="OnFloorOnly" Frequency="100" />
      <Behavior Name="OnFloorAndGrounded" Frequency="100" Condition="#{mascot.grounded}" />
    </Condition>
  </BehaviorList>
</Mascot>`;

describe("parseBehaviorsXml", () => {
	const behaviors = parseBehaviorsXml(FIXTURE_XML);

	it("parses frequency (no separate Hidden flag — Frequency=0 alone keeps it out of the pool)", () => {
		expect(behaviors.get("Fall")?.frequency).toBe(0);
	});

	it("parses a Condition expression", () => {
		expect(behaviors.get("SitDown")?.condition).toBeDefined();
	});

	it("parses child BehaviorReference transitions with the wrapper's Add flag and edge frequency", () => {
		const walk = behaviors.get("WalkAround");
		expect(walk?.nextBehaviors).toEqual([{ name: "SitDown", frequency: 5, condition: undefined, add: true }]);
	});

	it("falls back to a flat comma-separated NextBehaviorList attribute", () => {
		const flat = behaviors.get("FlatList");
		expect(flat?.nextBehaviors).toEqual([
			{ name: "WalkAround", frequency: 1, add: false },
			{ name: "SitDown", frequency: 1, add: false },
		]);
	});

	it("propagates an enclosing <Condition> wrapper onto every behavior it contains", () => {
		const onFloor = behaviors.get("OnFloorOnly");
		expect(onFloor?.condition).toBeDefined();
		expect(evaluateCondition(onFloor?.condition, { resolve: () => false, call: () => undefined })).toBe(false);
	});

	it("combines the wrapper condition with the behavior's own Condition attribute (AND)", () => {
		const combined = behaviors.get("OnFloorAndGrounded");
		expect(combined?.condition).toBeDefined();
		const trueCtx = { resolve: () => true, call: () => undefined };
		const falseCtx = { resolve: () => false, call: () => undefined };
		expect(evaluateCondition(combined?.condition, trueCtx)).toBe(true);
		expect(evaluateCondition(combined?.condition, falseCtx)).toBe(false);
	});
});
