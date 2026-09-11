import type { CustomActionSpec, CustomBehaviorSpec, CustomPackContent } from "./customContent";

/**
 * **Invented.** How a mascot reacts to finishing a race first or last — see engine/race.ts for the
 * race itself.
 *
 * Built out of the pack's **own** actions, like everything else in this folder, so it works on any
 * character without knowing a single image filename. The celebration is three real jumps: `Falling`
 * with an upward `InitialVY`, then `Bouncing` to land, which is precisely the idiom the bundled pack
 * uses for its own `WalkRightAlongIEAndJump`:
 *
 *     <ActionReference Name="Falling" InitialVX="${15+Math.random()*5}" InitialVY="${-20-Math.random()*5}"/>
 *     <ActionReference Name="Bouncing" />
 *
 * Worth saying why it is not a *script*. Three hops was the obvious first attempt — `startScript`
 * already exists and already sequences moves — and it produces exactly one jump. A script is a
 * circuit, so losing your grip cancels it (laps.ts relies on that), and leaving the ground to jump
 * is losing your grip. Inside a single action the runner sequences the fall and the landing itself,
 * which is why the pack composes jumps this way and not the other.
 *
 * Both behaviours are `frequency: 0`, so autonomous selection never picks them; they exist purely to
 * be started by name (`Mascot.startNamedBehavior` → `BehaviorAI.forceBehavior`, which ignores
 * frequency). That is also why this overlay is unconditional rather than sitting behind a setting —
 * a mascot that is not in a race is affected by none of it.
 *
 * Everything here goes through the same `mergeCustomContent` path a user's own hand-authored content
 * does, so it is not privileged: a user action or behavior of the same name replaces it outright.
 */

export const RACE_CELEBRATION_BEHAVIOR = "RaceCelebration";
export const RACE_DEFEAT_BEHAVIOR = "RaceDefeat";

/** How many times the winner jumps. The user asked for three, and three is also about as many as
 * reads as celebrating rather than as a mascot that has forgotten how to stop. */
const CELEBRATION_JUMPS = 3;

/**
 * Matching the bundled pack's own jumps, which launch at `-20-Math.random()*5`. Against `Falling`'s
 * gravity of 2 and RegistanceY of 0.1 that peaks a little under 80px — a clear hop for a 128px
 * character, and short enough that three of them take about three seconds rather than ten.
 */
const JUMP_VY = "${-20-Math.random()*5}";

/**
 * Sad poses in descending order of how sad they look, and every one of them is an action a real pack
 * is likely to have: `Sprawl` is what the bundled pack's own `LieDown` is made of, `Sit` and `Stand`
 * are near-universal. The first one present wins, and a pack with none of them simply gets no
 * defeat behaviour — the race then says the placing and leaves it at that, which is a good deal
 * better than referencing an action that does not exist.
 */
const LYING_DOWN = ["Sprawl", "LieDown", "Sit", "SitDown", "Stand"];

/** Long enough to read as dejection rather than a pause. Ticks, at 25/sec. */
const SULK_TICKS = "${250+Math.random()*250}";

let nextId = 0;
function id(): string {
	nextId += 1;
	return `race-${nextId}`;
}

function reference(name: string, paramOverrides: Record<string, string> = {}) {
	return { id: id(), name, condition: "", paramOverrides };
}

function sequence(name: string, children: ReturnType<typeof reference>[]): CustomActionSpec {
	return { id: id(), name, type: "Sequence", borderType: "", loop: false, animations: [], children, embeddedClass: "", params: {} };
}

function behavior(name: string): CustomBehaviorSpec {
	// frequency 0 and no condition: never chosen on its own, always available when asked for by
	// name. No nextBehaviors either, so afterwards the mascot returns to the pack's ordinary pool
	// rather than to anything this file decides.
	return { id: id(), name, frequency: 0, condition: "", nextBehaviors: [] };
}

/**
 * @param actionNames what the pack in question actually defines, so the defeat pose can be chosen
 * from what is there rather than hoped for.
 */
export function buildRaceReactionsContent(actionNames: ReadonlySet<string>): CustomPackContent {
	const actions: CustomActionSpec[] = [];
	const behaviors: CustomBehaviorSpec[] = [];

	// The celebration needs both halves of the idiom; without them there is no way to jump that does
	// not get cancelled the moment the mascot leaves the ground.
	if (actionNames.has("Falling") && actionNames.has("Bouncing")) {
		const jumps = Array.from({ length: CELEBRATION_JUMPS }, () => [
			reference("Falling", { InitialVX: "0", InitialVY: JUMP_VY }),
			reference("Bouncing"),
		]).flat();
		actions.push(sequence(RACE_CELEBRATION_BEHAVIOR, jumps));
		behaviors.push(behavior(RACE_CELEBRATION_BEHAVIOR));
	}

	const lieDown = LYING_DOWN.find((name) => actionNames.has(name));
	if (lieDown) {
		actions.push(sequence(RACE_DEFEAT_BEHAVIOR, [reference(lieDown, { Duration: SULK_TICKS })]));
		behaviors.push(behavior(RACE_DEFEAT_BEHAVIOR));
	}

	return { actions, behaviors };
}
