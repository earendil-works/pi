export function stripAnsi(value: string): string {
	let output = "";
	let index = 0;

	while (index < value.length) {
		const code = value.charCodeAt(index);

		if (code === 0x1b) {
			const next = value[index + 1];

			if (next === "[") {
				index = skipCsi(value, index + 2);
				continue;
			}

			if (next === "]" || next === "P" || next === "^" || next === "_") {
				index = skipStringControl(value, index + 2);
				continue;
			}

			if (next && "()*+-./#".includes(next)) {
				index = Math.min(index + 3, value.length);
				continue;
			}

			if (next && isEscFinalByte(next.charCodeAt(0))) {
				index += 2;
				continue;
			}
		} else if (code === 0x9b) {
			index = skipCsi(value, index + 1);
			continue;
		} else if (code === 0x9d || code === 0x90 || code === 0x9e || code === 0x9f) {
			index = skipStringControl(value, index + 1);
			continue;
		}

		output += value[index];
		index++;
	}

	return output;
}

function isEscFinalByte(code: number): boolean {
	return (
		(code >= 0x30 && code <= 0x39) ||
		(code >= 0x41 && code <= 0x50) ||
		(code >= 0x52 && code <= 0x54) ||
		code === 0x5a ||
		code === 0x63 ||
		(code >= 0x66 && code <= 0x6e) ||
		(code >= 0x71 && code <= 0x75) ||
		code === 0x79 ||
		code === 0x3d ||
		code === 0x3e ||
		code === 0x3c ||
		code === 0x7e
	);
}

function skipCsi(value: string, start: number): number {
	let index = start;
	while (index < value.length) {
		const code = value.charCodeAt(index);
		index++;
		if (code >= 0x40 && code <= 0x7e) {
			return index;
		}
	}
	return value.length;
}

function skipStringControl(value: string, start: number): number {
	let index = start;
	while (index < value.length) {
		const code = value.charCodeAt(index);
		if (code === 0x07 || code === 0x9c) {
			return index + 1;
		}
		if (code === 0x1b && value[index + 1] === "\\") {
			return index + 2;
		}
		index++;
	}
	return value.length;
}
