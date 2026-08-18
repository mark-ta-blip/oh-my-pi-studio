import { expect, test } from "bun:test";
import { mergeStudioAuthProgress } from "../src/client/auth-flow";

test("keeps the provider sign-in URL across later progress and prompt updates", () => {
	const authorization = {
		flowId: "ath_0123456789abcdef0123456789abcdef",
		providerId: "openai",
		phase: "authorization" as const,
		authorizationUrl: "https://login.example.test/authorize",
		launchUrl: "https://login.example.test/launch",
		instructions: "Sign in in your browser.",
	};
	const progress = mergeStudioAuthProgress(authorization, {
		flowId: authorization.flowId,
		providerId: authorization.providerId,
		phase: "progress",
		message: "Waiting for browser sign-in.",
	});
	const prompted = mergeStudioAuthProgress(progress, {
		flowId: authorization.flowId,
		providerId: authorization.providerId,
		phase: "prompt",
		prompt: { message: "Paste API key", allowEmpty: false },
	});
	const validating = mergeStudioAuthProgress(prompted, {
		flowId: authorization.flowId,
		providerId: authorization.providerId,
		phase: "progress",
		message: "Validating API key.",
	});

	expect(prompted).toMatchObject({
		phase: "prompt",
		authorizationUrl: authorization.authorizationUrl,
		launchUrl: authorization.launchUrl,
		instructions: authorization.instructions,
		prompt: { message: "Paste API key", allowEmpty: false },
	});
	expect(validating.prompt).toBeUndefined();
});
