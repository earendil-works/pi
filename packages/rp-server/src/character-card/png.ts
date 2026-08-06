const PNG_SIGNATURE = Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);

/**
 * Extract the character card JSON from a PNG buffer. SillyTavern embeds the
 * base64-encoded card JSON in a `tEXt` chunk whose keyword is `chara`.
 * Returns the decoded card JSON text, or `undefined` when no `chara` chunk
 * exists.
 */
export function extractCharacterCardFromPng(data: Uint8Array): string | undefined {
	if (!hasPngSignature(data)) {
		throw new Error("Not a PNG file");
	}
	let offset = PNG_SIGNATURE.length;
	while (offset + 8 <= data.length) {
		const length = readUInt32BE(data, offset);
		const dataStart = offset + 8;
		const dataEnd = dataStart + length;
		if (dataEnd + 4 > data.length) {
			break;
		}
		const type = String.fromCharCode(data[offset + 4], data[offset + 5], data[offset + 6], data[offset + 7]);
		if (type === "tEXt") {
			const chunkData = data.subarray(dataStart, dataEnd);
			const separator = chunkData.indexOf(0);
			if (separator >= 0) {
				const keyword = textDecoder.decode(chunkData.subarray(0, separator));
				if (keyword === "chara") {
					const encoded = textDecoder.decode(chunkData.subarray(separator + 1));
					const decoded = base64Decode(encoded);
					if (decoded.length === 0) {
						return undefined;
					}
					return decoded;
				}
			}
		}
		if (type === "IEND") {
			break;
		}
		offset = dataEnd + 4;
	}
	return undefined;
}

function hasPngSignature(data: Uint8Array): boolean {
	if (data.length < PNG_SIGNATURE.length) {
		return false;
	}
	for (let index = 0; index < PNG_SIGNATURE.length; index++) {
		if (data[index] !== PNG_SIGNATURE[index]) {
			return false;
		}
	}
	return true;
}

function readUInt32BE(data: Uint8Array, offset: number): number {
	return ((data[offset] << 24) | (data[offset + 1] << 16) | (data[offset + 2] << 8) | data[offset + 3]) >>> 0;
}

const textDecoder = new TextDecoder("latin1");

function base64Decode(encoded: string): string {
	return Buffer.from(encoded, "base64").toString("utf8");
}
