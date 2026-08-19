import * as path from "node:path";
import * as zlib from "node:zlib";

interface Raster {
	width: number;
	height: number;
	pixels: Uint8Array;
}

type Color = readonly [number, number, number, number];

const packageRoot = path.resolve(import.meta.dir, "..");
const resourcesDir = path.join(packageRoot, "resources");
const PNG_SIGNATURE = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);

function writeUint32(target: Uint8Array, offset: number, value: number): void {
	target[offset] = (value >>> 24) & 0xff;
	target[offset + 1] = (value >>> 16) & 0xff;
	target[offset + 2] = (value >>> 8) & 0xff;
	target[offset + 3] = value & 0xff;
}

function writeUint16LE(target: Uint8Array, offset: number, value: number): void {
	target[offset] = value & 0xff;
	target[offset + 1] = (value >>> 8) & 0xff;
}

function writeUint32LE(target: Uint8Array, offset: number, value: number): void {
	target[offset] = value & 0xff;
	target[offset + 1] = (value >>> 8) & 0xff;
	target[offset + 2] = (value >>> 16) & 0xff;
	target[offset + 3] = (value >>> 24) & 0xff;
}

function concatBytes(parts: readonly Uint8Array[]): Uint8Array {
	const length = parts.reduce((total, part) => total + part.length, 0);
	const result = new Uint8Array(length);
	let offset = 0;
	for (const part of parts) {
		result.set(part, offset);
		offset += part.length;
	}
	return result;
}

function crc32(bytes: Uint8Array): number {
	let checksum = 0xffffffff;
	for (const value of bytes) {
		checksum ^= value;
		for (let bit = 0; bit < 8; bit += 1) {
			checksum = (checksum >>> 1) ^ (0xedb88320 & -(checksum & 1));
		}
	}
	return (checksum ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Uint8Array): Uint8Array {
	const typeBytes = new TextEncoder().encode(type);
	const chunk = new Uint8Array(data.length + 12);
	writeUint32(chunk, 0, data.length);
	chunk.set(typeBytes, 4);
	chunk.set(data, 8);
	writeUint32(chunk, data.length + 8, crc32(concatBytes([typeBytes, data])));
	return chunk;
}

function encodePng(raster: Raster): Uint8Array {
	const header = new Uint8Array(13);
	writeUint32(header, 0, raster.width);
	writeUint32(header, 4, raster.height);
	header[8] = 8;
	header[9] = 6;
	const stride = raster.width * 4;
	const scanlines = new Uint8Array((stride + 1) * raster.height);
	for (let row = 0; row < raster.height; row += 1) {
		const scanlineOffset = row * (stride + 1);
		scanlines.set(raster.pixels.subarray(row * stride, (row + 1) * stride), scanlineOffset + 1);
	}
	return concatBytes([
		PNG_SIGNATURE,
		pngChunk("IHDR", header),
		// PNG IDAT stores a zlib stream; Bun.deflateSync emits raw DEFLATE.
		pngChunk("IDAT", zlib.deflateSync(scanlines, { level: 9 })),
		pngChunk("IEND", new Uint8Array()),
	]);
}

function setPixel(raster: Raster, x: number, y: number, color: Color): void {
	if (x < 0 || x >= raster.width || y < 0 || y >= raster.height) return;
	const offset = (y * raster.width + x) * 4;
	raster.pixels[offset] = color[0];
	raster.pixels[offset + 1] = color[1];
	raster.pixels[offset + 2] = color[2];
	raster.pixels[offset + 3] = color[3];
}

function fillRoundedRect(
	raster: Raster,
	x: number,
	y: number,
	width: number,
	height: number,
	radius: number,
	color: Color,
): void {
	const right = x + width;
	const bottom = y + height;
	for (let row = Math.floor(y); row < Math.ceil(bottom); row += 1) {
		for (let column = Math.floor(x); column < Math.ceil(right); column += 1) {
			const centerX = column + 0.5;
			const centerY = row + 0.5;
			const nearestX = Math.min(Math.max(centerX, x + radius), right - radius);
			const nearestY = Math.min(Math.max(centerY, y + radius), bottom - radius);
			if (Math.hypot(centerX - nearestX, centerY - nearestY) <= radius) setPixel(raster, column, row, color);
		}
	}
}

function createAppIcon(size: number): Raster {
	const raster: Raster = { width: size, height: size, pixels: new Uint8Array(size * size * 4) };
	const scale = size / 512;
	const scaled = (value: number): number => value * scale;
	fillRoundedRect(raster, scaled(24), scaled(24), scaled(464), scaled(464), scaled(106), [14, 56, 51, 255]);
	fillRoundedRect(raster, scaled(43), scaled(43), scaled(426), scaled(426), scaled(86), [21, 78, 69, 255]);
	fillRoundedRect(raster, scaled(96), scaled(234), scaled(70), scaled(176), scaled(20), [224, 244, 239, 255]);
	fillRoundedRect(raster, scaled(221), scaled(154), scaled(70), scaled(256), scaled(20), [224, 244, 239, 255]);
	fillRoundedRect(raster, scaled(346), scaled(234), scaled(70), scaled(176), scaled(20), [224, 244, 239, 255]);
	fillRoundedRect(raster, scaled(122), scaled(204), scaled(268), scaled(34), scaled(17), [109, 201, 177, 255]);
	fillRoundedRect(raster, scaled(352), scaled(96), scaled(68), scaled(68), scaled(34), [240, 119, 83, 255]);
	return raster;
}

function createTrayIcon(size: number): Raster {
	const raster: Raster = { width: size, height: size, pixels: new Uint8Array(size * size * 4) };
	const scale = size / 64;
	const scaled = (value: number): number => value * scale;
	fillRoundedRect(raster, scaled(2), scaled(2), scaled(60), scaled(60), scaled(16), [14, 56, 51, 255]);
	fillRoundedRect(raster, scaled(13), scaled(29), scaled(9), scaled(22), scaled(3), [233, 247, 242, 255]);
	fillRoundedRect(raster, scaled(28), scaled(19), scaled(9), scaled(32), scaled(3), [233, 247, 242, 255]);
	fillRoundedRect(raster, scaled(43), scaled(29), scaled(9), scaled(22), scaled(3), [233, 247, 242, 255]);
	fillRoundedRect(raster, scaled(17), scaled(25), scaled(30), scaled(5), scaled(2), [109, 201, 177, 255]);
	return raster;
}

function encodeIco(images: readonly { size: number; bytes: Uint8Array }[]): Uint8Array {
	const directorySize = 6 + images.length * 16;
	const directory = new Uint8Array(directorySize);
	writeUint16LE(directory, 0, 0);
	writeUint16LE(directory, 2, 1);
	writeUint16LE(directory, 4, images.length);
	let offset = directorySize;
	for (let index = 0; index < images.length; index += 1) {
		const image = images[index];
		const entry = 6 + index * 16;
		directory[entry] = image.size === 256 ? 0 : image.size;
		directory[entry + 1] = image.size === 256 ? 0 : image.size;
		directory[entry + 2] = 0;
		directory[entry + 3] = 0;
		writeUint16LE(directory, entry + 4, 1);
		writeUint16LE(directory, entry + 6, 32);
		writeUint32LE(directory, entry + 8, image.bytes.length);
		writeUint32LE(directory, entry + 12, offset);
		offset += image.bytes.length;
	}
	return concatBytes([directory, ...images.map(image => image.bytes)]);
}

function encodeIcns(images: readonly { type: string; bytes: Uint8Array }[]): Uint8Array {
	const imageChunks = images.map(image => {
		const chunk = new Uint8Array(image.bytes.length + 8);
		chunk.set(new TextEncoder().encode(image.type), 0);
		writeUint32(chunk, 4, chunk.length);
		chunk.set(image.bytes, 8);
		return chunk;
	});
	const header = new Uint8Array(8);
	header.set(new TextEncoder().encode("icns"));
	writeUint32(header, 4, header.length + imageChunks.reduce((total, chunk) => total + chunk.length, 0));
	return concatBytes([header, ...imageChunks]);
}

const appImages = [16, 32, 48, 64, 128, 256].map(size => ({ size, bytes: encodePng(createAppIcon(size)) }));
const appIcon = appImages.at(-1);
if (!appIcon) throw new Error("Could not generate the OMP Studio application icon.");
const appIcon512 = encodePng(createAppIcon(512));
const appIcon1024 = encodePng(createAppIcon(1024));

await Bun.write(path.join(resourcesDir, "icon.png"), appIcon512);
await Bun.write(path.join(resourcesDir, "icon.ico"), encodeIco(appImages));
await Bun.write(
	path.join(resourcesDir, "icon.icns"),
	encodeIcns([
		{ type: "icp4", bytes: appImages[0].bytes },
		{ type: "icp5", bytes: appImages[1].bytes },
		{ type: "icp6", bytes: appImages[3].bytes },
		{ type: "ic07", bytes: appImages[4].bytes },
		{ type: "ic08", bytes: appIcon.bytes },
		{ type: "ic09", bytes: appIcon512 },
		{ type: "ic10", bytes: appIcon1024 },
	]),
);
await Bun.write(path.join(resourcesDir, "tray-icon.png"), encodePng(createTrayIcon(64)));
console.log("Generated OMP Studio desktop assets.");
