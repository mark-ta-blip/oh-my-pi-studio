import * as fs from "node:fs/promises";
import * as path from "node:path";

const TAR_BLOCK_SIZE = 512;
const TAR_SIZE_OFFSET = 124;
const TAR_SIZE_LENGTH = 12;
const TAR_MTIME_OFFSET = 136;
const TAR_MTIME_LENGTH = 12;
const TAR_CHECKSUM_OFFSET = 148;
const TAR_CHECKSUM_LENGTH = 8;

async function collectFiles(dir: string): Promise<string[]> {
	const entries = await fs.readdir(dir, { withFileTypes: true });
	const files: string[] = [];
	for (const entry of entries) {
		const fullPath = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			files.push(...(await collectFiles(fullPath)));
		} else if (entry.isFile()) {
			files.push(fullPath);
		}
	}
	files.sort();
	return files;
}

function readTarOctal(bytes: Uint8Array, offset: number, length: number): number {
	const value = Buffer.from(bytes.subarray(offset, offset + length))
		.toString("ascii")
		.replace(/\0.*$/, "")
		.trim();
	return value ? Number.parseInt(value, 8) : 0;
}

function writeTarOctal(bytes: Uint8Array, offset: number, length: number, value: number): void {
	const octal = value.toString(8);
	if (octal.length >= length) throw new Error(`Tar value ${value} does not fit in ${length} bytes`);
	bytes.fill(0x30, offset, offset + length - 1);
	bytes.set(Buffer.from(octal), offset + length - 1 - octal.length);
	bytes[offset + length - 1] = 0;
}

function normalizeTarMetadata(bytes: Uint8Array): void {
	for (let offset = 0; offset + TAR_BLOCK_SIZE <= bytes.length; ) {
		const header = bytes.subarray(offset, offset + TAR_BLOCK_SIZE);
		if (header.every(byte => byte === 0)) return;

		const size = readTarOctal(header, TAR_SIZE_OFFSET, TAR_SIZE_LENGTH);
		writeTarOctal(header, TAR_MTIME_OFFSET, TAR_MTIME_LENGTH, 0);
		header.fill(0x20, TAR_CHECKSUM_OFFSET, TAR_CHECKSUM_OFFSET + TAR_CHECKSUM_LENGTH);

		let checksum = 0;
		for (const byte of header) checksum += byte;
		const checksumOctal = checksum.toString(8).padStart(6, "0");
		if (checksumOctal.length > 6) throw new Error(`Tar checksum ${checksum} exceeds the header field`);
		header.set(Buffer.from(checksumOctal), TAR_CHECKSUM_OFFSET);
		header[TAR_CHECKSUM_OFFSET + 6] = 0;
		header[TAR_CHECKSUM_OFFSET + 7] = 0x20;

		offset += TAR_BLOCK_SIZE * (1 + Math.ceil(size / TAR_BLOCK_SIZE));
		if (offset > bytes.length) throw new Error("Tar entry extends beyond the archive");
	}
}

function sanitizeArchivePath(archivePath: string): string | null {
	const normalized = archivePath.replaceAll("\\", "/").replace(/^\.\/+/, "");
	if (!normalized || normalized === ".") return null;
	if (
		normalized.split("/").some(segment => segment === "." || segment === "..") ||
		path.posix.isAbsolute(normalized) ||
		path.win32.isAbsolute(normalized)
	) {
		return null;
	}
	return normalized;
}

function isWithinDirectory(root: string, candidate: string): boolean {
	const relative = path.relative(root, candidate);
	return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

/** Build a byte-stable gzip tar archive for static assets embedded in a Bun binary. */
export async function buildEmbeddedArchiveBase64(dir: string): Promise<string> {
	const files = await collectFiles(dir);
	const entries: Record<string, Uint8Array> = {};
	for (const filePath of files) {
		const relativePath = path.relative(dir, filePath).split(path.sep).join("/");
		entries[relativePath] = await Bun.file(filePath).bytes();
	}

	const archiveBytes = await new Bun.Archive(entries).bytes();
	normalizeTarMetadata(archiveBytes);
	return Buffer.from(Bun.gzipSync(archiveBytes, { level: 9 })).toString("base64");
}

/** Decode a checked-in base64 gzip archive, treating blank generated assets as absent. */
export function decodeEmbeddedArchive(txt: string): Buffer | null {
	const normalized = txt.replaceAll(/\s+/g, "");
	if (!normalized || !/^[A-Za-z0-9+/]+={0,2}$/.test(normalized)) return null;
	const archiveBytes = Buffer.from(normalized, "base64");
	if (archiveBytes[0] !== 0x1f || archiveBytes[1] !== 0x8b) return null;
	return archiveBytes;
}

/** Extract embedded static assets without allowing archive members to escape their destination. */
export async function extractEmbeddedArchive(archiveBytes: Buffer, outputDir: string): Promise<void> {
	const archive = new Bun.Archive(archiveBytes);
	const files = await archive.files();
	const extractRoot = path.resolve(outputDir);

	for (const [archivePath, file] of files) {
		const sanitizedPath = sanitizeArchivePath(archivePath);
		if (!sanitizedPath) continue;
		const destinationPath = path.resolve(extractRoot, sanitizedPath);
		if (!isWithinDirectory(extractRoot, destinationPath)) {
			throw new Error(`Archive entry escapes extraction directory: ${archivePath}`);
		}
		await Bun.write(destinationPath, file);
	}
}
