import type { StudioProviderModel, StudioThinkingLevel } from "../protocol";

const THINKING_LEVEL_ORDER: StudioThinkingLevel[] = ["minimal", "low", "medium", "high", "xhigh", "max"];
const CURSOR_THINKING_VARIANT_PATTERN = /^(.*?)-(minimal|low|medium|high|xhigh|max)(-.+)?$/;

interface CursorThinkingVariant {
	familyId: string;
	level: StudioThinkingLevel;
}

export interface StudioThinkingPicker {
	kind: "native" | "model_variant";
	levels: StudioThinkingLevel[];
	selectedLevel?: StudioThinkingLevel;
}

function getCursorThinkingVariant(model: StudioProviderModel): CursorThinkingVariant | undefined {
	if (model.providerId !== "cursor" || model.thinkingLevels?.length) return undefined;
	const match = CURSOR_THINKING_VARIANT_PATTERN.exec(model.id);
	if (!match) return undefined;
	const [, prefix, level, suffix = ""] = match;
	return { familyId: `${prefix}${suffix}`, level: level as StudioThinkingLevel };
}

export function getStudioThinkingPicker(
	selectedModel: StudioProviderModel | undefined,
	providerModels: readonly StudioProviderModel[],
): StudioThinkingPicker | undefined {
	if (!selectedModel) return undefined;
	if (selectedModel.thinkingLevels?.length) {
		return { kind: "native", levels: selectedModel.thinkingLevels };
	}
	const selectedVariant = getCursorThinkingVariant(selectedModel);
	if (!selectedVariant) return undefined;
	const levels = new Set<StudioThinkingLevel>();
	for (const model of providerModels) {
		const variant = getCursorThinkingVariant(model);
		if (variant?.familyId === selectedVariant.familyId) levels.add(variant.level);
	}
	if (levels.size < 2) return undefined;
	return {
		kind: "model_variant",
		levels: THINKING_LEVEL_ORDER.filter(level => levels.has(level)),
		selectedLevel: selectedVariant.level,
	};
}

export function getStudioThinkingVariantModel(
	selectedModel: StudioProviderModel,
	providerModels: readonly StudioProviderModel[],
	level: StudioThinkingLevel,
): StudioProviderModel | undefined {
	const selectedVariant = getCursorThinkingVariant(selectedModel);
	if (!selectedVariant) return undefined;
	return providerModels.find(model => {
		const variant = getCursorThinkingVariant(model);
		return variant?.familyId === selectedVariant.familyId && variant.level === level;
	});
}
