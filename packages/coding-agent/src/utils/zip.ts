import { writeFile } from "node:fs/promises";
import { crc32, deflateRawSync } from "node:zlib";

interface ZipEntry {
	name: string;
	data: string | Uint8Array;
}

function dosDateTime(date: Date): { time: number; day: number } {
	return {
		time: (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1),
		day: ((Math.max(1980, date.getFullYear()) - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
	};
}

/** Create the small, classic ZIP archives used by bug reports. */
function createZipArchive(entries: readonly ZipEntry[]): Buffer {
	const files: Buffer[] = [];
	const directory: Buffer[] = [];
	const { time, day } = dosDateTime(new Date());
	let offset = 0;

	for (const entry of entries) {
		const name = Buffer.from(entry.name);
		const data = typeof entry.data === "string" ? Buffer.from(entry.data) : Buffer.from(entry.data);
		const compressed = deflateRawSync(data);
		const checksum = crc32(data);

		const local = Buffer.alloc(30);
		local.writeUInt32LE(0x04034b50, 0);
		local.writeUInt16LE(20, 4);
		local.writeUInt16LE(0x0800, 6);
		local.writeUInt16LE(8, 8);
		local.writeUInt16LE(time, 10);
		local.writeUInt16LE(day, 12);
		local.writeUInt32LE(checksum, 14);
		local.writeUInt32LE(compressed.length, 18);
		local.writeUInt32LE(data.length, 22);
		local.writeUInt16LE(name.length, 26);

		const central = Buffer.alloc(46);
		central.writeUInt32LE(0x02014b50, 0);
		central.writeUInt16LE(20, 4);
		central.writeUInt16LE(20, 6);
		central.writeUInt16LE(0x0800, 8);
		central.writeUInt16LE(8, 10);
		central.writeUInt16LE(time, 12);
		central.writeUInt16LE(day, 14);
		central.writeUInt32LE(checksum, 16);
		central.writeUInt32LE(compressed.length, 20);
		central.writeUInt32LE(data.length, 24);
		central.writeUInt16LE(name.length, 28);
		central.writeUInt32LE(offset, 42);

		files.push(local, name, compressed);
		directory.push(central, name);
		offset += local.length + name.length + compressed.length;
	}

	const centralDirectory = Buffer.concat(directory);
	const end = Buffer.alloc(22);
	end.writeUInt32LE(0x06054b50, 0);
	end.writeUInt16LE(entries.length, 8);
	end.writeUInt16LE(entries.length, 10);
	end.writeUInt32LE(centralDirectory.length, 12);
	end.writeUInt32LE(offset, 16);
	return Buffer.concat([...files, centralDirectory, end]);
}

export function writeZipArchive(filePath: string, entries: readonly ZipEntry[]): Promise<void> {
	return writeFile(filePath, createZipArchive(entries));
}
