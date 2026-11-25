// A session's shared counter: its count (state), who looks at it now (state), waves (an event).
import { arr, int, obj, str } from "@earendil-works/pi-schema";
import { method, param, remote, serverHost } from "@p2/app/v1";

export const Counter = remote("counter.board", {
	version: 1,
	params: { session: param.str() },
	hostAddress: serverHost,
	variants: {
		player: {
			state: { count: int(), present: arr(str()) },
			events: { waved: obj({ from: str() }) },
			methods: { add: method(obj({ by: int({ minimum: -100, maximum: 100 }) })), wave: method() },
		},
	},
});
