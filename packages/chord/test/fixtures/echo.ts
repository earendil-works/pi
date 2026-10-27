import { Type } from "typebox";
import { hostNamed, method, remote } from "../../src/index.ts";

export const Echo = remote("t.echo", {
	version: 1,
	input: Type.Object({}),
	host: hostNamed("w1"),
	variants: {
		main: { methods: { echo: method(Type.String(), Type.String()), pid: method(undefined, Type.Number()) } },
	},
});
