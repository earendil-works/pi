// The echo plugin: a WebSocket of its own protocol at `/echo/:room`, after the server checked who is connecting.

import { defineFacet } from "@earendil-works/chord/next";
import { Http } from "@earendil-works/chord/next/http";

export default defineFacet((_host, self) =>
	self.contribute(Http, {
		sockets: {
			"/echo/:room": (socket, request, ctx) => {
				const who = JSON.stringify(ctx.principal);
				socket.send(`welcome to ${request.params.room}, ${who}`);
				socket.on("message", (data) => socket.send(`echo: ${String(data)}`));
			},
		},
	}),
);
