import type { NativeStateName } from "../engine/types";

/**
 * A small original, non-representational blob character used only so the plugin is
 * testable before a real Shimeji-compatible artwork pack is loaded. Not modeled on any
 * existing character.
 */
export const PLACEHOLDER_WIDTH = 48;
export const PLACEHOLDER_HEIGHT = 56;

export function createPlaceholderElement(): SVGSVGElement {
	const doc = document;
	const NS = "http://www.w3.org/2000/svg";
	const svg = doc.createElementNS(NS, "svg") as SVGSVGElement;
	svg.setAttribute("viewBox", `0 0 ${PLACEHOLDER_WIDTH} ${PLACEHOLDER_HEIGHT}`);
	svg.setAttribute("width", String(PLACEHOLDER_WIDTH));
	svg.setAttribute("height", String(PLACEHOLDER_HEIGHT));

	const legs = doc.createElementNS(NS, "g");
	legs.setAttribute("class", "shimeji-legs");
	legs.innerHTML = `
		<ellipse class="leg leg-left" cx="17" cy="49" rx="6" ry="5" fill="#4a5a8a" />
		<ellipse class="leg leg-right" cx="31" cy="49" rx="6" ry="5" fill="#4a5a8a" />
	`;

	const arms = doc.createElementNS(NS, "g");
	arms.setAttribute("class", "shimeji-arms");
	arms.innerHTML = `
		<ellipse class="arm arm-left" cx="7" cy="30" rx="5" ry="8" fill="#6f8ae0" />
		<ellipse class="arm arm-right" cx="41" cy="30" rx="5" ry="8" fill="#6f8ae0" />
	`;

	const body = doc.createElementNS(NS, "g");
	body.setAttribute("class", "shimeji-body");
	body.innerHTML = `
		<ellipse cx="24" cy="28" rx="17" ry="19" fill="#7c9fff" stroke="#3a4a7a" stroke-width="1.5" />
		<circle class="eye eye-left" cx="18" cy="26" r="2.4" fill="#233" />
		<circle class="eye eye-right" cx="30" cy="26" r="2.4" fill="#233" />
		<path class="mouth" d="M 19 34 Q 24 37 29 34" stroke="#233" stroke-width="1.4" fill="none" stroke-linecap="round" />
	`;

	svg.append(legs, body, arms);
	return svg;
}

interface PoseParts {
	legs: SVGGElement;
	arms: SVGGElement;
	body: SVGGElement;
}

function getParts(svg: SVGSVGElement): PoseParts {
	return {
		legs: svg.querySelector(".shimeji-legs") as SVGGElement,
		arms: svg.querySelector(".shimeji-arms") as SVGGElement,
		body: svg.querySelector(".shimeji-body") as SVGGElement,
	};
}

/** Procedurally poses the placeholder for the given native state; `t` is elapsed ms in that state. */
export function applyPlaceholderPose(svg: SVGSVGElement, state: NativeStateName, t: number): void {
	const { legs, arms, body } = getParts(svg);
	const bob = Math.sin(t / 220) * 1.4;

	switch (state) {
		case "walk":
		case "chase-mouse": {
			const swing = Math.sin(t / 90) * 14;
			legs.setAttribute("transform", `rotate(${swing} 24 44)`);
			arms.setAttribute("transform", `rotate(${-swing * 0.6} 24 30)`);
			body.setAttribute("transform", `translate(0 ${Math.abs(bob)})`);
			break;
		}
		case "climb-wall": {
			const swing = Math.sin(t / 140) * 10;
			legs.setAttribute("transform", `rotate(${swing} 24 44)`);
			arms.setAttribute("transform", `rotate(${swing} 24 30)`);
			body.removeAttribute("transform");
			break;
		}
		case "walk-ceiling": {
			const swing = Math.sin(t / 100) * 12;
			legs.setAttribute("transform", `rotate(${swing} 24 44)`);
			arms.removeAttribute("transform");
			body.removeAttribute("transform");
			break;
		}
		case "fall":
		case "thrown": {
			legs.setAttribute("transform", "translate(0 -3) scale(1.05 0.9)");
			arms.setAttribute("transform", "rotate(-25 24 30)");
			body.setAttribute("transform", "scale(0.95 1.08)");
			break;
		}
		case "dragged": {
			arms.setAttribute("transform", "translate(0 -6) rotate(8 24 30)");
			legs.setAttribute("transform", "translate(0 2)");
			body.removeAttribute("transform");
			break;
		}
		case "sit": {
			legs.setAttribute("transform", "scale(1.15 0.55) translate(0 18)");
			arms.removeAttribute("transform");
			body.setAttribute("transform", "translate(0 6) scale(1.05 0.9)");
			break;
		}
		case "idle":
		default: {
			legs.removeAttribute("transform");
			arms.removeAttribute("transform");
			body.setAttribute("transform", `translate(0 ${bob})`);
			break;
		}
	}
}
