import { describe, expect, it } from "vitest";
import { parseBehaviorsXml } from "../src/shimeji/BehaviorsParser";

/**
 * Real packs write the transition wrapper two different ways, and the schema allows both.
 *
 * Reading only `<NextBehavior>` meant a pack written with `<NextBehaviorList>` silently lost every
 * transition it declared: it parsed without complaint, loaded without complaint, and then chained
 * nothing — every behaviour falling back to the ambient pool, so none of the authored sequences
 * (chase then sit and watch; finish eating then stand up) ever happened. Five of the user's own
 * packs were written that way.
 */
function wrapped(tag: string): string {
	return `<Mascot><BehaviorList>
		<Behavior Name="ChaseMouse" Frequency="0" Hidden="true">
			<${tag} Add="false">
				<BehaviorReference Name="SitAndFaceMouse" Frequency="7" />
			</${tag}>
		</Behavior>
		<Behavior Name="SitAndFaceMouse" Frequency="0" Hidden="true" />
	</BehaviorList></Mascot>`;
}

describe("the NextBehaviour wrapper", () => {
	it.each(["NextBehavior", "NextBehaviorList"])("is read when spelled <%s>", (tag) => {
		const behaviors = parseBehaviorsXml(wrapped(tag));
		expect(behaviors.get("ChaseMouse")!.nextBehaviors).toEqual([
			{ name: "SitAndFaceMouse", frequency: 7, condition: undefined, add: false },
		]);
	});

	it("keeps Add from the wrapper either way", () => {
		const xml = wrapped("NextBehaviorList").replace('Add="false"', 'Add="true"');
		expect(parseBehaviorsXml(xml).get("ChaseMouse")!.nextBehaviors[0].add).toBe(true);
	});

	it("still accepts the flat comma-separated attribute form", () => {
		// A third spelling, and the one the fallback below the element scan exists for.
		const xml = `<Mascot><BehaviorList>
			<Behavior Name="A" Frequency="1" NextBehaviorList="B,C" />
			<Behavior Name="B" Frequency="1" /><Behavior Name="C" Frequency="1" />
		</BehaviorList></Mascot>`;
		expect(parseBehaviorsXml(xml).get("A")!.nextBehaviors.map((n) => n.name)).toEqual(["B", "C"]);
	});
});
