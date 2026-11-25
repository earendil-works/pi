// When something happened, as the transcript and the activity panel show it: the clock today, the date before it on
// other days, and the full date and time as its tooltip.

/** A moment's short form: "14:32" today, "3 Mar 14:32" on other days. */
export function clockTime(at: number): string {
	const date = new Date(at);
	const time = date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
	return date.toDateString() === new Date().toDateString()
		? time
		: `${date.toLocaleDateString([], { day: "numeric", month: "short" })} ${time}`;
}

/** A `<time>`: the short form, the full date and time on hover. */
export function Time({ at, className }: { at: number; className?: string }) {
	const date = new Date(at);
	return (
		<time className={className} dateTime={date.toISOString()} title={date.toLocaleString()}>
			{clockTime(at)}
		</time>
	);
}
