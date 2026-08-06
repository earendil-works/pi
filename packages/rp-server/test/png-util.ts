const PNG_SIGNATURE = Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);

function crc32(data: Uint8Array): number {
	let crc = 0xffffffff;
	for (const byte of data) {
		crc ^= byte;
		for (let bit = 0; bit < 8; bit++) {
			crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
		}
	}
	return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
	const typeBytes = Uint8Array.from([...type].map((char) => char.charCodeAt(0)));
	const body = new Uint8Array(typeBytes.length + data.length);
	body.set(typeBytes, 0);
	body.set(data, typeBytes.length);
	const length = Uint8Array.from([
		(data.length >>> 24) & 0xff,
		(data.length >>> 16) & 0xff,
		(data.length >>> 8) & 0xff,
		data.length & 0xff,
	]);
	const crcValue = crc32(body);
	const crc = Uint8Array.from([
		(crcValue >>> 24) & 0xff,
		(crcValue >>> 16) & 0xff,
		(crcValue >>> 8) & 0xff,
		crcValue & 0xff,
	]);
	const result = new Uint8Array(length.length + body.length + crc.length);
	result.set(length, 0);
	result.set(body, length.length);
	result.set(crc, length.length + body.length);
	return result;
}

export function buildPngWithCard(cardJson: string): Uint8Array {
	const encoded = Buffer.from(cardJson, "utf8").toString("base64");
	const keywordBytes = Uint8Array.from([...("chara" as string)].map((char) => char.charCodeAt(0)));
	const valueBytes = Uint8Array.from([...encoded].map((char) => char.charCodeAt(0)));
	const data = new Uint8Array(keywordBytes.length + 1 + valueBytes.length);
	data.set(keywordBytes, 0);
	data.set(valueBytes, keywordBytes.length + 1);
	const textChunk = chunk("tEXt", data);
	const endChunk = chunk("IEND", new Uint8Array(0));
	const result = new Uint8Array(PNG_SIGNATURE.length + textChunk.length + endChunk.length);
	result.set(PNG_SIGNATURE, 0);
	result.set(textChunk, PNG_SIGNATURE.length);
	result.set(endChunk, PNG_SIGNATURE.length + textChunk.length);
	return result;
}

export function buildPngWithTextChunks(textChunks: Array<{ keyword: string; value: string }>): Uint8Array {
	const parts: Uint8Array[] = [PNG_SIGNATURE];
	for (const { keyword, value } of textChunks) {
		const keywordBytes = Uint8Array.from([...keyword].map((char) => char.charCodeAt(0)));
		const valueBytes = Uint8Array.from([...value].map((char) => char.charCodeAt(0)));
		const data = new Uint8Array(keywordBytes.length + 1 + valueBytes.length);
		data.set(keywordBytes, 0);
		data.set(valueBytes, keywordBytes.length + 1);
		parts.push(chunk("tEXt", data));
	}
	parts.push(chunk("IEND", new Uint8Array(0)));
	const total = parts.reduce((sum, part) => sum + part.length, 0);
	const result = new Uint8Array(total);
	let offset = 0;
	for (const part of parts) {
		result.set(part, offset);
		offset += part.length;
	}
	return result;
}
