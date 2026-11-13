// The scope prompt's button: next to the sidebar's collapse button, and in the top bar while the sidebar is not shown
// (collapsed, or a phone's drawer), so it is always at hand. It switches pointing mode on, and off again.
import { useOwner } from "@p2/app/v1/web";
import { setPointing, usePointing } from "./mode.ts";

/** The button, for the owner only (as the overlay is). */
export function ScopeToggle() {
	return useOwner() ? <Button /> : null;
}

function Button() {
	const pointing = usePointing();
	return (
		<button
			type="button"
			className={`icon-button scope-toggle scope-ui ${pointing ? "on" : ""}`}
			aria-pressed={pointing}
			aria-label="Prompt anywhere"
			title={pointing ? "Stop prompting anywhere" : "Prompt anywhere (Cmd+.)"}
			onClick={() => setPointing(!pointing)}
		>
			<PointIcon />
		</button>
	);
}

/**
 * A viewfinder's corners around a ring, for a mouse and a finger alike: Material Symbols' "center_focus_weak"
 * (Apache-2.0, Google; as Elanor's icon set has it). Web facets import only host packages, so its path is here.
 */
function PointIcon() {
	return (
		<svg width="20" height="20" viewBox="0 -960 960 960" fill="currentColor" aria-hidden="true">
			<path d="M480-336q-60 0-102-42t-42-102q0-60 42-102t102-42q60 0 102 42t42 102q0 60-42 102t-102 42Zm.21-72Q510-408 531-429.21t21-51Q552-510 530.79-531t-51-21Q450-552 429-530.79t-21 51Q408-450 429.21-429t51 21Zm-.21-72ZM216-144q-29.7 0-50.85-21.15Q144-186.3 144-216v-168h72v168h168v72H216Zm360 0v-72h168v-168h72v168q0 29.7-21.15 50.85Q773.7-144 744-144H576ZM144-576v-168q0-29.7 21.15-50.85Q186.3-816 216-816h168v72H216v168h-72Zm600 0v-168H576v-72h168q29.7 0 50.85 21.15Q816-773.7 816-744v168h-72Z" />
		</svg>
	);
}
