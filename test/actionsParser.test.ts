import { describe, expect, it } from "vitest";
import { parseActionsXml } from "../src/shimeji/ActionsParser";
import { SHIMEJI_TICKS_PER_SEC, SHIMEJI_TICK_MS } from "../src/shimeji/constants";

const FIXTURE_XML = `<?xml version="1.0"?>
<Mascot>
  <ActionList>
    <Action Name="Stand" Type="Animate" BorderType="Floor">
      <Animation>
        <Pose Image="/pose1.png" ImageAnchor="32,64" Duration="500" />
      </Animation>
    </Action>
    <Action Name="WalkLoop" Type="Move">
      <Animation>
        <Pose Image="/pose2.png" ImageAnchor="32,64" Velocity="4,0" Duration="90" />
        <Pose Image="/pose3.png" ImageAnchor="32,64" Velocity="4,0" Duration="90" />
      </Animation>
    </Action>
    <Action Name="IdleThenWalk" Type="Sequence">
      <ActionReference Name="Stand" />
      <ActionReference Name="WalkLoop" />
    </Action>
    <Action Name="PickASide" Type="Select">
      <ActionReference Name="Stand" Condition="#{mascot.anchor.x &lt; 100}" />
      <ActionReference Name="WalkLoop" />
    </Action>
    <Action Name="Fall" Type="Embedded" Class="com.group_finity.mascot.action.Fall" BorderType="Floor">
      <Animation>
        <Pose Image="/falling.png" ImageAnchor="32,64" Duration="100" />
      </Animation>
    </Action>
    <Action Name="ClimbWall" Type="Move" BorderType="Wall">
      <Animation Condition="#{TargetY &lt; mascot.anchor.y}">
        <Pose Image="/up.png" ImageAnchor="32,64" Velocity="0,-1" Duration="4" />
      </Animation>
      <Animation Condition="#{TargetY &gt;= mascot.anchor.y}">
        <Pose Image="/down.png" ImageAnchor="32,64" Velocity="0,1" Duration="4" />
      </Animation>
    </Action>
    <Action Name="Weird" Type="TotallyMadeUp">
      <Animation><Pose Image="/x.png" Duration="10" /></Animation>
    </Action>
    <Action Type="Animate">
      <Animation><Pose Image="/no-name.png" Duration="10" /></Animation>
    </Action>
  </ActionList>
</Mascot>`;

describe("parseActionsXml", () => {
	const actions = parseActionsXml(FIXTURE_XML);

	it("parses Animate poses with anchor/duration converted from ticks to ms", () => {
		const stand = actions.get("Stand");
		expect(stand?.type).toBe("Animate");
		expect(stand?.borderType).toBe("Floor");
		expect(stand?.animations).toEqual([
			{ condition: undefined, hotspots: [], poses: [{ image: "/pose1.png", anchor: { x: 32, y: 64 }, velocity: undefined, durationMs: 500 * SHIMEJI_TICK_MS }] },
		]);
	});

	it("parses Move poses with velocity converted from px/tick to px/second", () => {
		const walk = actions.get("WalkLoop");
		expect(walk?.type).toBe("Move");
		const poses = walk?.animations[0].poses ?? [];
		expect(poses).toHaveLength(2);
		expect(poses[0].velocity).toEqual({ x: 4 * SHIMEJI_TICKS_PER_SEC, y: 0 });
	});

	it("parses Sequence children in order", () => {
		const seq = actions.get("IdleThenWalk");
		expect(seq?.type).toBe("Sequence");
		expect(seq?.children.map((c) => c.name)).toEqual(["Stand", "WalkLoop"]);
	});

	it("parses Select children with a Condition expression", () => {
		const select = actions.get("PickASide");
		expect(select?.type).toBe("Select");
		expect(select?.children[0].condition).toBeDefined();
		expect(select?.children[1].condition).toBeUndefined();
	});

	it("marks Embedded actions with a short embeddedName taken from the Class attribute", () => {
		const fall = actions.get("Fall");
		expect(fall?.type).toBe("Embedded");
		expect(fall?.embeddedName).toBe("Fall");
		expect(fall?.animations[0].poses).toHaveLength(1);
	});

	it("parses multiple condition-gated Animation variants on one Action", () => {
		const climb = actions.get("ClimbWall");
		expect(climb?.animations).toHaveLength(2);
		expect(climb?.animations[0].condition).toBeDefined();
		expect(climb?.animations[0].poses[0].image).toBe("/up.png");
		expect(climb?.animations[1].poses[0].image).toBe("/down.png");
	});

	it("falls back unknown Type values to Stay instead of throwing", () => {
		expect(actions.get("Weird")?.type).toBe("Stay");
	});

	it("skips top-level Action elements without a Name", () => {
		expect(actions.size).toBe(7);
	});
});
