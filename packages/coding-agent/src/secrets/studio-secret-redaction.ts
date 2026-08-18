const STUDIO_REDACT_DISPLAY_SECRETS_ENV = "OMP_STUDIO_REDACT_DISPLAY_SECRETS";

export function shouldRestoreDisplaySecrets(
	environment: Readonly<Record<string, string | undefined>> = Bun.env,
): boolean {
	return environment[STUDIO_REDACT_DISPLAY_SECRETS_ENV] !== "1";
}

export function studioRpcChildEnvironment(
	environment: Readonly<Record<string, string | undefined>> = Bun.env,
): Record<string, string | undefined> {
	return { ...environment, [STUDIO_REDACT_DISPLAY_SECRETS_ENV]: "1" };
}
