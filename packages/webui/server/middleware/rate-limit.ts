import type { NextFunction, Request, Response } from "express";

export interface RateLimitConfig {
	windowMs: number;
	max: number;
	keyFn?: (req: Request) => string;
}

interface Bucket {
	count: number;
	resetAt: number;
}

export function rateLimit(config: RateLimitConfig) {
	const buckets = new Map<string, Bucket>();
	const keyFn = config.keyFn ?? ((req: Request) => req.ip ?? "unknown");
	return (req: Request, res: Response, next: NextFunction) => {
		const key = keyFn(req);
		const now = Date.now();
		const bucket = buckets.get(key);
		if (!bucket || bucket.resetAt <= now) {
			buckets.set(key, { count: 1, resetAt: now + config.windowMs });
			next();
			return;
		}
		if (bucket.count >= config.max) {
			res
				.status(429)
				.json({ error: "rate_limited", retryAfterMs: bucket.resetAt - now });
			return;
		}
		bucket.count++;
		next();
	};
}