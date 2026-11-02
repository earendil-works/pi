import { num, obj, str } from "@earendil-works/pi-schema";
import { hostNamed, method, remote } from "../../src/index.ts";

export const Echo = remote("t.echo", {
	version: 1,
	input: obj({}, { open: true }),
	host: hostNamed("w1"),
	variants: {
		main: { methods: { echo: method(str(), str()), pid: method(undefined, num()) } },
	},
});
