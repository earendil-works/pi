/**
 * Format elapsed time in milliseconds to a human-readable string.
 * @param ms - Elapsed time in milliseconds
 * @returns Formatted string like "10s", "1m 10s", "1h 1m 10s"
 */
export function formatElapsed(ms: number): string {
	const totalSeconds = Math.floor(ms / 1000);
	const hours = Math.floor(totalSeconds / 3600);
	const minutes = Math.floor((totalSeconds % 3600) / 60);
	const seconds = totalSeconds % 60;

	if (hours > 0) {
		return `${hours}h ${minutes}m ${seconds}s`;
	} else if (minutes > 0) {
		return `${minutes}m ${seconds}s`;
	} else {
		return `${seconds}s`;
	}
}
