import { normalizePath, type App } from "obsidian";
import type { Pixels } from "./pixels";

/**
 * The browser half of the sprite editor: decoding a vault image into pixels, encoding pixels back
 * into a PNG, and getting files in and out of a pack's image folder.
 *
 * Kept apart from `pixels.ts` so that the algorithms there stay testable — everything in this file
 * needs a real canvas, a real `Image` decoder, or a real vault, and none of the three exist under
 * jsdom. Nothing here makes a decision worth testing; it is all glue.
 */

/** A sheet, decoded and ready to work on. */
export interface DecodedImage {
	pixels: Pixels;
	width: number;
	height: number;
	/** An object URL for the original file, for anything that wants to draw the image directly
	 * rather than go through the pixel buffer. The caller owns it and must revoke it. */
	url: string;
}

const MIME_BY_EXTENSION: Record<string, string> = {
	png: "image/png",
	jpg: "image/jpeg",
	jpeg: "image/jpeg",
	gif: "image/gif",
	webp: "image/webp",
};

export function mimeTypeForPath(path: string): string {
	const ext = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
	return MIME_BY_EXTENSION[ext] ?? "image/png";
}

/** Resolves a pack-relative image reference (`/shime1.png`, as it appears in a Pose) to its real
 * vault path under the pack's image folder. */
export function packImagePath(imgDir: string, packRelative: string): string {
	return normalizePath(`${imgDir}/${packRelative.trim().replace(/^[/\\]+/, "")}`);
}

function decodeBlob(blob: Blob): Promise<{ image: HTMLImageElement; url: string }> {
	const url = URL.createObjectURL(blob);
	return new Promise((resolve, reject) => {
		const image = new Image();
		image.onload = () => resolve({ image, url });
		image.onerror = () => {
			URL.revokeObjectURL(url);
			reject(new Error("the file could not be decoded as an image"));
		};
		image.src = url;
	});
}

function pixelsFrom(image: HTMLImageElement): Pixels {
	const canvas = document.createElement("canvas");
	canvas.width = image.naturalWidth;
	canvas.height = image.naturalHeight;
	const ctx = canvas.getContext("2d", { willReadFrequently: true });
	if (!ctx) throw new Error("canvas 2D context unavailable");
	ctx.drawImage(image, 0, 0);
	const data = ctx.getImageData(0, 0, canvas.width, canvas.height);
	return { data: data.data, width: canvas.width, height: canvas.height };
}

/**
 * Decodes an arbitrary Blob/File — straight from a native file picker, with no vault round-trip
 * at all — into the same shape `decodeVaultImage` produces. For anything that only ever needs
 * the pixels and a display URL rather than a permanent copy in the pack folder: the character
 * wizard's per-pose fit editor decodes the user's source photo this way, since the photo itself
 * is never worth keeping — only whatever gets composited from it.
 *
 * Throws on an undecodable file, unlike `decodeVaultImage` — there is no "missing file, grey out
 * a row" case here, since the caller just picked this file and expects it to be one.
 */
export async function decodeImageBlob(blob: Blob): Promise<DecodedImage> {
	const { image, url } = await decodeBlob(blob);
	return { pixels: pixelsFrom(image), width: image.naturalWidth, height: image.naturalHeight, url };
}

/** Decodes a vault image into a pixel buffer. Returns undefined when the file is missing or is not
 * a decodable image, rather than throwing — a bad file in the folder should grey out one row of
 * the editor, not take the modal down. */
export async function decodeVaultImage(app: App, path: string): Promise<DecodedImage | undefined> {
	try {
		if (!(await app.vault.adapter.exists(path))) return undefined;
		const bin = await app.vault.adapter.readBinary(path);
		return await decodeImageBlob(new Blob([bin], { type: mimeTypeForPath(path) }));
	} catch (e) {
		console.warn(`[obsidian-shimeji] could not read "${path}" as an image`, e);
		return undefined;
	}
}

/** Paints a pixel buffer onto a canvas, for preview. */
export function pixelsToCanvas(pixels: Pixels): HTMLCanvasElement {
	const canvas = document.createElement("canvas");
	canvas.width = pixels.width;
	canvas.height = pixels.height;
	const ctx = canvas.getContext("2d");
	if (!ctx) throw new Error("canvas 2D context unavailable");
	// Filled through createImageData rather than `new ImageData(buffer, ...)`: the constructor's
	// typing insists on a buffer it knows is not shared, which a plain Uint8ClampedArray is not.
	const target = ctx.createImageData(pixels.width, pixels.height);
	target.data.set(pixels.data);
	ctx.putImageData(target, 0, 0);
	return canvas;
}

/** Encodes a pixel buffer as PNG bytes. Always PNG: a sliced pose needs its transparency, and that
 * rules out JPEG whatever the sheet it came from was. */
export async function pixelsToPngBytes(pixels: Pixels): Promise<ArrayBuffer> {
	const canvas = pixelsToCanvas(pixels);
	const blob: Blob = await new Promise((resolve, reject) => {
		canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("failed to encode PNG"))), "image/png");
	});
	return blob.arrayBuffer();
}

/** Strips a filename down to something safe to sit in a pack folder and be referenced from XML. */
export function sanitizeImageName(name: string): string {
	return (
		name
			.trim()
			.toLowerCase()
			.replace(/\.[a-z0-9]+$/i, "")
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/(^-|-$)/g, "") || "pose"
	);
}

/**
 * Writes an image into the pack's folder under a free name, and returns the pack-relative
 * reference a Pose should use (`/walk-1.png`).
 *
 * Never overwrites: a pack's images are the user's own files, and silently replacing one would
 * break every pose already pointing at it. The suffix counts up until the name is free.
 */
export async function writePackImage(app: App, imgDir: string, baseName: string, bytes: ArrayBuffer): Promise<string> {
	if (!(await app.vault.adapter.exists(imgDir))) await app.vault.adapter.mkdir(imgDir);
	const base = sanitizeImageName(baseName);
	let candidate = `${base}.png`;
	let suffix = 2;
	while (await app.vault.adapter.exists(normalizePath(`${imgDir}/${candidate}`))) {
		candidate = `${base}-${suffix}.png`;
		suffix++;
	}
	await app.vault.adapter.writeBinary(normalizePath(`${imgDir}/${candidate}`), bytes);
	return `/${candidate}`;
}

/** Copies raw bytes from outside the vault (a native file picker) into the pack's folder. Keeps
 * the original extension, since an imported sheet is not necessarily a PNG and re-encoding one
 * just to store it would be lossy for no reason. */
export async function importPackImage(app: App, imgDir: string, fileName: string, bytes: ArrayBuffer): Promise<string> {
	if (!(await app.vault.adapter.exists(imgDir))) await app.vault.adapter.mkdir(imgDir);
	const dot = fileName.lastIndexOf(".");
	const ext = dot > 0 ? fileName.slice(dot).toLowerCase() : ".png";
	const base = sanitizeImageName(fileName);
	let candidate = `${base}${ext}`;
	let suffix = 2;
	while (await app.vault.adapter.exists(normalizePath(`${imgDir}/${candidate}`))) {
		candidate = `${base}-${suffix}${ext}`;
		suffix++;
	}
	await app.vault.adapter.writeBinary(normalizePath(`${imgDir}/${candidate}`), bytes);
	return candidate;
}

/**
 * Replaces a vault image with new pixels, in place.
 *
 * Deliberately the same path, so poses already referencing it keep working — that is the whole
 * point of background removal being an edit rather than a new file. Written as PNG regardless of
 * what the original was, because the result has an alpha channel that a JPEG could not carry; a
 * `.jpg` file containing PNG bytes would still decode, but the extension would then be a lie, so
 * the caller is told the new path and is responsible for repointing anything that refers to it.
 */
export async function overwriteVaultImageAsPng(app: App, path: string, pixels: Pixels): Promise<string> {
	const bytes = await pixelsToPngBytes(pixels);
	const isPng = path.toLowerCase().endsWith(".png");
	const target = isPng ? path : `${path.slice(0, path.lastIndexOf("."))}.png`;
	await app.vault.adapter.writeBinary(normalizePath(target), bytes);
	if (target !== path && (await app.vault.adapter.exists(path))) await app.vault.adapter.remove(path);
	return target;
}

/** Removes an image from the pack folder. */
export async function deletePackImage(app: App, imgDir: string, fileName: string): Promise<void> {
	const path = packImagePath(imgDir, fileName);
	if (await app.vault.adapter.exists(path)) await app.vault.adapter.remove(path);
}
