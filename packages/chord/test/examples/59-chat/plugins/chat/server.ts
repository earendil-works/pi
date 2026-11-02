// The chat plugin on the server: the channel list, the sign-in page (pick a name: the kit's ephemeral login), and the
// attachments' URLs (`/files/<channel>/<id>`), read from the channel's room as the signed-in user.

import { BACKGROUND_CONTEXT, Channels, constant, defineFacet, Room } from "@chat/app/v1";
import { Http } from "@chat/app/v1/server";

/** The chat's channels: two, each its own worker. */
const CHANNELS = ["general", "random"];

/** The sign-in page: a name, posted to the kit's login, then the chat. */
const signIn = (
	nonce: string,
): string => `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Chat</title></head>
<body><form id="login"><input name="name" placeholder="Pick a name" autofocus required> <button>Join</button></form>
<script nonce="${nonce}">
document.getElementById("login").addEventListener("submit", async (event) => {
	event.preventDefault();
	const name = new FormData(event.target).get("name");
	const answer = await fetch("/_chord/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name }) });
	if (answer.ok) location.href = "/chat";
});
</script></body></html>`;

export default defineFacet((host, self) => {
	host.serve(Channels, () => ({ variant: "main", members: { names: constant(CHANNELS) } }));
	self.contribute(Http, {
		routes: {
			"GET /": { public: true, handler: async (request) => ({ kind: "html", body: signIn(request.nonce) }) },
			"GET /files/:channel/:id": async (request, ctx) => {
				const room = await ctx.get(Room, { id: request.params.channel! });
				const file = await room.attachment(request.params.id!, BACKGROUND_CONTEXT).catch(() => undefined);
				if (file === undefined) return { kind: "error", status: 404 };
				return {
					kind: "bytes",
					mime: file.mime,
					size: file.size,
					inline: file.mime.startsWith("image/") ? true : undefined,
					download: file.mime.startsWith("image/") ? undefined : file.name,
					read: (offset, length) =>
						room.read({ id: file.id, offset, length: Math.min(length, 1024 * 1024) }, BACKGROUND_CONTEXT),
				};
			},
		},
	});
});
