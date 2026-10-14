import { fetchWithHeaderDeadline } from "../../src/api/antigravity/stream.ts";

// No sockets or other referenced handles: only the watchdog may keep this process alive.
const response = await fetchWithHeaderDeadline(
	"https://unused.example.test",
	{},
	undefined,
	0,
	10,
	async () => new Response(new ReadableStream()),
);
try {
	await response.text();
	process.exitCode = 1;
} catch (error) {
	console.log(error instanceof Error ? error.message : String(error));
}
