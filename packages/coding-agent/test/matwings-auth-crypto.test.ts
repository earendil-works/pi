import { constants, generateKeyPairSync, privateDecrypt } from "node:crypto";
import { describe, expect, it } from "vitest";
import { ENCRYPTED_PREFIX, encryptPassword, isEncrypted } from "../src/core/matwings-auth/crypto.ts";

describe("matwings-auth crypto", () => {
	const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
	const pem = publicKey.export({ type: "spki", format: "pem" }).toString();

	it("encrypts to enc:<base64> and round-trips with RSA-OAEP-SHA256", () => {
		const enc = encryptPassword("hunter2", pem);
		expect(enc.startsWith(ENCRYPTED_PREFIX)).toBe(true);
		expect(isEncrypted(enc)).toBe(true);

		const b64 = enc.slice(ENCRYPTED_PREFIX.length);
		const decrypted = privateDecrypt(
			{ key: privateKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" },
			Buffer.from(b64, "base64"),
		);
		expect(decrypted.toString("utf8")).toBe("hunter2");
	});

	it("isEncrypted is false for plaintext", () => {
		expect(isEncrypted("plaintext")).toBe(false);
	});
});
