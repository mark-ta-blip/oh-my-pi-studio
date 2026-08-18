import { expect, test } from "bun:test";
import { resolveExternalHttpUrl } from "../src/main/external-url";

test("permits provider OAuth web URLs while refusing non-web protocols", () => {
	expect(resolveExternalHttpUrl("https://provider.example/authorize?state=opaque")).toBe(
		"https://provider.example/authorize?state=opaque",
	);
	expect(resolveExternalHttpUrl("http://127.0.0.1:4317/launch")).toBe("http://127.0.0.1:4317/launch");
	expect(resolveExternalHttpUrl("file:///C:/private.txt")).toBeNull();
	expect(resolveExternalHttpUrl("javascript:alert(1)")).toBeNull();
});
