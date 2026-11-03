import { ownerOrigin } from "../src/runtime/owner-link.ts";

const args = process.argv.slice(2);
try {
	if (args.length > 1) throw new Error("Usage: npm run owner-link [base-url]");
	const base = ownerOrigin(args[0] ?? process.env.P2_PUBLIC_URL ?? `http://127.0.0.1:${process.env.PORT ?? 8788}`);
	const port = Number(process.env.PORT ?? 8788);
	if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid PORT");
	// Direct loopback, no proxy/browser headers: shell access on the machine proves ownership.
	const response = await fetch(`http://127.0.0.1:${port}/owner-token`, {
		redirect: "error",
		signal: AbortSignal.timeout(10_000),
	});
	if (!response.ok) throw new Error("Cannot mint an owner link; check the running server and PORT");
	const value: unknown = await response.json();
	if (
		!value ||
		typeof value !== "object" ||
		!("token" in value) ||
		typeof value.token !== "string" ||
		!/^[a-f0-9]{64}$/.test(value.token)
	)
		throw new Error("Invalid owner-token response");
	const link = new URL("/owner", base);
	link.hash = value.token;
	// This command intentionally emits the private invitation to the invoking user's terminal only.
	console.log(link.href);
} catch (error) {
	console.error(error instanceof Error ? error.message : "Cannot mint an owner link");
	process.exitCode = 1;
}
