// The lists plugin on the server: a JSON API for command-line clients. A route runs as whoever sent the request (the
// kit answered 401 before this code runs when nobody signed in), so its `ctx.get` reaches the list's worker as them.

import { defineFacet, Todos } from "@todo/app/v1";
import { Http } from "@todo/app/v1/server";

export default defineFacet((_host, self) => {
	self.contribute(Http, {
		routes: {
			"GET /api/lists/:list": async (request, ctx) => {
				const todos = await ctx.get(Todos, { list: request.params.list! });
				return { kind: "json", value: todos.items.value };
			},
			"POST /api/lists/:list": async (request, ctx) => {
				const todos = await ctx.get(Todos, { list: request.params.list! });
				await todos.add(String(await request.json()), ctx);
				return { kind: "json", value: "added" };
			},
		},
	});
});
