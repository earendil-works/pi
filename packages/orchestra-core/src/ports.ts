// Port allocation: supervisor owns dev-server ports (agents never pick).
import { createServer } from "node:net";

export async function allocatePort(preferred?: number): Promise<number> {
	if (preferred !== undefined) {
		const ok = await isFree(preferred);
		if (ok) return preferred;
	}
	return new Promise((resolve, reject) => {
		const s = createServer();
		s.once("error", reject);
		s.listen(0, "127.0.0.1", () => {
			const addr = s.address();
			if (typeof addr === "object" && addr) {
				const port = addr.port;
				s.close(() => resolve(port));
			} else reject(new Error("no port"));
		});
	});
}

function isFree(port: number): Promise<boolean> {
	return new Promise((resolve) => {
		const s = createServer();
		s.once("error", () => resolve(false));
		s.listen(port, "127.0.0.1", () => s.close(() => resolve(true)));
	});
}
