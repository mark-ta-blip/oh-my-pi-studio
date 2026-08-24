import { describe, expect, test } from "bun:test";
import {
	NOTIFICATION_BODY_LIMIT,
	NOTIFICATION_TITLE_LIMIT,
	parseNotificationContent,
} from "../src/main/notification-content";

/** Built rather than written literally, so no control byte ends up in this source. */
const BELL = String.fromCharCode(7);
const CONTROL_ONLY = String.fromCharCode(7, 0, 31);

describe("parseNotificationContent", () => {
	test("passes ordinary content through", () => {
		expect(parseNotificationContent("OMP run finished", "Your session is ready for the next prompt.")).toEqual({
			title: "OMP run finished",
			body: "Your session is ready for the next prompt.",
		});
	});

	test("keeps an empty body, which is a valid notification", () => {
		expect(parseNotificationContent("OMP run finished", "")).toEqual({ title: "OMP run finished", body: "" });
	});

	test.each([
		["a non-string title", 1, "body"],
		["a non-string body", "title", { text: "body" }],
		["a missing title", undefined, "body"],
		["an empty title", "", "body"],
		["a whitespace-only title", "   \t ", "body"],
		["a control-character-only title", CONTROL_ONLY, "body"],
	])("rejects %s", (_label, title, body) => {
		// An untitled OS notification renders as an anonymous popup the user cannot
		// attribute to anything.
		expect(parseNotificationContent(title, body)).toBeUndefined();
	});

	test("collapses a title to one line, because every platform draws it as one", () => {
		expect(parseNotificationContent("OMP run\nneeds\tattention", "body")?.title).toBe("OMP run needs attention");
	});

	test("strips control characters from the body but keeps its newlines", () => {
		const body = ["line one", `line${BELL}two`].join("\n");

		expect(parseNotificationContent("title", body)?.body).toBe("line one\nline two");
	});

	test("bounds a title the renderer made too long", () => {
		const result = parseNotificationContent("a".repeat(500), "body");

		expect(result?.title).toHaveLength(NOTIFICATION_TITLE_LIMIT);
		expect(result?.title.endsWith("…")).toBe(true);
	});

	test("bounds a body the renderer made too long", () => {
		const result = parseNotificationContent("title", "b".repeat(5000));

		expect(result?.body).toHaveLength(NOTIFICATION_BODY_LIMIT);
		expect(result?.body.endsWith("…")).toBe(true);
	});

	test("leaves content that is exactly at the limit alone", () => {
		const title = "a".repeat(NOTIFICATION_TITLE_LIMIT);

		expect(parseNotificationContent(title, "")?.title).toBe(title);
	});
});
