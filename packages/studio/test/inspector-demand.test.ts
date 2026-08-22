import { describe, expect, it } from "bun:test";
import { studioInspectorDemand } from "../src/client/inspector-demand";

describe("Studio inspector demand", () => {
	const features = {
		activityTimeline: true,
		approvalControls: true,
		changeReview: true,
		planSummary: true,
		runHistory: true,
		subagentVisibility: true,
		toolCards: true,
		usageHistory: true,
	};

	it("does not hydrate inspector resources while closed", () => {
		expect([...studioInspectorDemand(false, "history", features)]).toEqual([]);
	});

	it("maps each visible panel to only its resources", () => {
		expect([...studioInspectorDemand(true, "overview", features)].sort()).toEqual(["approvals", "plan", "subagents"]);
		expect([...studioInspectorDemand(true, "activity", features)].sort()).toEqual(["activity", "toolDisplays"]);
		expect([...studioInspectorDemand(true, "changes", features)]).toEqual(["changeSet"]);
		expect([...studioInspectorDemand(true, "history", features)].sort()).toEqual(["runHistory", "usageHistory"]);
	});

	it("does not demand disabled capabilities", () => {
		expect([...studioInspectorDemand(true, "overview", {})]).toEqual([]);
	});
});
