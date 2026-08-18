import { decodeEmbeddedArchive } from "@oh-my-pi/pi-utils/embedded-archive";

/**
 * Embedded stats dashboard archive handling.
 *
 * `embedded-client.generated.txt` holds the base64 of a gzipped tar of the
 * built dashboard (`dist/client`). It is populated by
 * `gen:stats` for compiled binaries and the
 * prepacked npm bundle, and reset to an empty file afterwards so the dev tree
 * keeps building the dashboard from source.
 */

/**
 * Decode the generated archive text.
 *
 * Returns `null` when the content is blank or not a raw gzip archive encoded as
 * base64 — notably the legacy placeholder that contained a TypeScript
 * `export const … = "";` stub, which must be treated as "no archive embedded"
 * rather than decoded into garbage bytes.
 */
export function decodeEmbeddedClientArchive(txt: string): Buffer | null {
	return decodeEmbeddedArchive(txt);
}
