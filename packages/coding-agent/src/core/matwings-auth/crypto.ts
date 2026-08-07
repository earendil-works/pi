import { constants, publicEncrypt } from "node:crypto";

/** Prefix marking an RSA-encrypted value (matches the backend contract). */
export const ENCRYPTED_PREFIX = "enc:";

/**
 * RSA-OAEP-SHA256 encrypt a plaintext password with the backend's public key,
 * returning the `enc:<base64>` string the backend expects. Used for both the
 * login password and the bind flow's `current_password`.
 *
 * @param plaintext - The raw password.
 * @param publicKeyPem - PEM-encoded RSA public key from /auth/password-public-key.
 */
export function encryptPassword(plaintext: string, publicKeyPem: string): string {
	const encrypted = publicEncrypt(
		{
			key: publicKeyPem,
			padding: constants.RSA_PKCS1_OAEP_PADDING,
			oaepHash: "sha256",
		},
		Buffer.from(plaintext, "utf8"),
	);
	return `${ENCRYPTED_PREFIX}${encrypted.toString("base64")}`;
}

/** Whether a value is already in the encrypted `enc:` form. */
export function isEncrypted(value: string): boolean {
	return value.startsWith(ENCRYPTED_PREFIX);
}
