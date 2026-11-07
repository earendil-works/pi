// ULID generation (Crockford base32, 48-bit timestamp + 80-bit random).
import { randomBytes } from "node:crypto";

const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

export function ulid(now: number = Date.now(), rand?: Uint8Array): string {
	const bytes = rand ?? randomBytes(10);
	if (bytes.length !== 10) throw new Error("ulid: rand must be 10 bytes");
	// 48-bit timestamp (JS bitwise is 32-bit, so use modulo 2**48).
	let t = BigInt(now) % 2n ** 48n;
	let out = "";
	for (let i = 0; i < 10; i++) {
		out = ALPHABET[Number(t % 32n)] + out;
		t /= 32n;
	}
	// 80 bits → 16 chars
	let v = 0n;
	for (let i = 0; i < 10; i++) v = (v << 8n) | BigInt(bytes[i]);
	let chars = "";
	for (let i = 0; i < 16; i++) {
		chars = ALPHABET[Number(v % 32n)] + chars;
		v /= 32n;
	}
	return out + chars;
}

export function isUlid(s: string): boolean {
	if (s.length !== 26) return false;
	for (const c of s) if (!ALPHABET.includes(c)) return false;
	return true;
}
