/** Restrict renderer-initiated browser launches to normal web URLs. */
export function resolveExternalHttpUrl(value: string): string | null {
	try {
		const url = new URL(value);
		return url.protocol === "http:" || url.protocol === "https:" ? url.href : null;
	} catch {
		return null;
	}
}
