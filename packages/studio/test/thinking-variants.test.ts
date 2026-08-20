import { describe, expect, it } from "bun:test";
import { getStudioThinkingPicker, getStudioThinkingVariantModel } from "../src/client/thinking-variants";
import type { StudioProviderModel } from "../src/protocol";

const cursorGrokVariants: StudioProviderModel[] = [
	...(["low", "medium", "xhigh"] as const).map(level => ({
		id: `cursor-grok-4.6-${level}-fast`,
		name: `Cursor Grok 4.6 ${level} Fast`,
		providerId: "cursor",
		reasoning: false,
		supportsImageInput: false,
		supportsTools: true,
	})),
];

describe("Studio thinking picker", () => {
	it("maps Cursor Grok effort variants to their sibling model ids", () => {
		const selectedModel = cursorGrokVariants[2];
		if (!selectedModel) throw new Error("Expected the Cursor Grok xhigh model fixture.");
		expect(getStudioThinkingPicker(selectedModel, cursorGrokVariants)).toEqual({
			kind: "model_variant",
			levels: ["low", "medium", "xhigh"],
			selectedLevel: "xhigh",
		});
		expect(getStudioThinkingVariantModel(selectedModel, cursorGrokVariants, "low")?.id).toBe(
			"cursor-grok-4.6-low-fast",
		);
	});

	it("keeps request-level thinking controls on models that expose them", () => {
		const model: StudioProviderModel = {
			id: "gpt-5.6",
			name: "GPT-5.6",
			providerId: "openai",
			reasoning: true,
			thinkingLevels: ["low", "medium", "high", "xhigh", "max"],
			supportsImageInput: true,
			supportsTools: true,
		};
		expect(getStudioThinkingPicker(model, [model])).toEqual({
			kind: "native",
			levels: ["low", "medium", "high", "xhigh", "max"],
		});
	});
});
