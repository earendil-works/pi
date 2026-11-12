// The counter's pane beside the transcript: view kind "counter".
import { BACKGROUND_CONTEXT, contribute, defineFacet, liveIn } from "@p2/app/v1";
import { type PaneProps, useObject, useReadable, useStatus, ViewKinds } from "@p2/app/v1/web";
import { useEffect, useState } from "react";
import { Counter } from "./contract.ts";

function CounterPane({ session, editable }: PaneProps) {
	const ref = useObject(Counter, { session });
	useStatus(ref);
	const board = liveIn(ref, "player");
	const count = useReadable(board?.count);
	const present = useReadable(board?.present) ?? [];
	const [wave, setWave] = useState("");
	useEffect(() => {
		if (!board) return;
		let stopped = false;
		let stop = () => {
			stopped = true;
		};
		void board.waved
			.on(({ value }) => setWave(`${value.from} waved`), BACKGROUND_CONTEXT)
			.then((subscription) => {
				if (stopped) subscription.stop();
				else stop = () => subscription.stop();
			});
		return () => stop();
	}, [board]);
	return (
		<div style={{ padding: "var(--x)" }}>
			<p className="counter-count">{count ?? "…"}</p>
			<p className="muted">Here: {present.join(", ")}</p>
			{editable && board && (
				<p>
					<button type="button" onClick={() => void board.add({ by: 1 }, BACKGROUND_CONTEXT)}>
						+1
					</button>{" "}
					<button type="button" onClick={() => void board.wave(BACKGROUND_CONTEXT)}>
						Wave
					</button>
				</p>
			)}
			<p className="muted">{wave}</p>
		</div>
	);
}

export default defineFacet((host) => {
	contribute(host, "counter.web", (self) => {
		self.contribute(ViewKinds, { counter: CounterPane });
	});
});
