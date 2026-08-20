import { describe, expect, it } from "bun:test";
import { renderStudioMarkdown } from "../src/client/conversation/markdown";

describe("Studio transcript Markdown", () => {
	it("renders agent formatting while leaving raw HTML and unsafe links inert", () => {
		const rendered = renderStudioMarkdown(
			"## Result\n\nUse `bun run check` before merging.\n\n[unsafe](javascript:alert(1))\n\n<script>alert(1)</script>",
		);

		expect(rendered).toContain("<h2>Result</h2>");
		expect(rendered).toContain("<code>bun run check</code>");
		expect(rendered).toContain("unsafe");
		expect(rendered).not.toContain('href="javascript:');
		expect(rendered).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
	});
});
