/**
 * Bounds on what a renderer can put in an OS notification.
 *
 * The renderer supplies both strings, and a notification is drawn by the OS
 * outside the app's window — so length and control characters are the shell's
 * problem, not the compositor's. Pure, so the rules are testable.
 */

export const NOTIFICATION_TITLE_LIMIT = 120;
export const NOTIFICATION_BODY_LIMIT = 400;

export interface StudioNotificationContent {
	body: string;
	title: string;
}

/**
 * Every Unicode control character except newline, which a body may legitimately
 * contain. Read the double negation as "is a control, and is not a newline":
 * `\P{Cc}` is everything that is not a control, so excluding it from a negated
 * class leaves the controls.
 */
const CONTROL_CHARACTERS = /[^\P{Cc}\n]/gu;

function truncate(value: string, limit: number): string {
	return value.length <= limit ? value : `${value.slice(0, limit - 1)}…`;
}

/**
 * Validate and bound notification content.
 *
 * A title is required: an OS notification with an empty title renders as an
 * anonymous popup the user cannot attribute to anything. A body is optional, so an
 * empty one is kept rather than rejected. Titles are collapsed to a single line
 * because every platform draws them as one.
 */
export function parseNotificationContent(title: unknown, body: unknown): StudioNotificationContent | undefined {
	if (typeof title !== "string" || typeof body !== "string") return undefined;
	const cleanTitle = title.replace(CONTROL_CHARACTERS, " ").replace(/\s+/gu, " ").trim();
	if (cleanTitle === "") return undefined;
	const cleanBody = body.replace(CONTROL_CHARACTERS, " ").trim();
	return {
		title: truncate(cleanTitle, NOTIFICATION_TITLE_LIMIT),
		body: truncate(cleanBody, NOTIFICATION_BODY_LIMIT),
	};
}
