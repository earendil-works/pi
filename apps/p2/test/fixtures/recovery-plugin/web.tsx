// Test only (ui-recovery.test.ts): a composer slot that throws while `p2-test-crash:<session>` is set on the device, so
// the page's root boundary has something to catch outside every pane's boundary.
import { contribute, defineFacet } from "@p2/app/v1";
import { Slots, useRoute } from "@p2/app/v1/web";

function Crash() {
	const session = useRoute().session;
	if (session && localStorage.getItem(`p2-test-crash:${session}`) === "1")
		throw new Error("The test's crash: state an older page left");
	return null;
}

export default defineFacet((host) => {
	contribute(host, "recovery.web", (self) => {
		self.contribute(Slots, { "composer:recovery-crash": Crash });
	});
});
