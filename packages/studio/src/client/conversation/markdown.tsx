import { Marked } from "@oh-my-pi/pi-utils/marked";
import type { ReactNode } from "react";
import { memo, useMemo } from "react";

function escapeHtml(value: string): string {
	return value
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&#39;");
}

function unescapeHtml(value: string): string {
	const parseCodePoint = (raw: number): string => {
		if (!Number.isFinite(raw) || raw < 0 || raw > 0x10ffff) return "";
		try {
			return String.fromCodePoint(raw);
		} catch {
			return "";
		}
	};

	return value.replace(/&(amp|lt|gt|quot|apos|nbsp|#\d+|#x[0-9a-fA-F]+);/gi, (match, entity) => {
		const normalized = entity.toLowerCase();
		switch (normalized) {
			case "nbsp":
				return " ";
			case "lt":
				return "<";
			case "gt":
				return ">";
			case "quot":
				return '"';
			case "apos":
				return "'";
			case "amp":
				return "&";
			default:
				if (normalized.startsWith("#x")) return parseCodePoint(Number.parseInt(normalized.slice(2), 16));
				if (normalized.startsWith("#")) return parseCodePoint(Number(normalized.slice(1)));
				return match;
		}
	});
}

function safeHref(value: string): string | null {
	const href = value.trim();
	if (/^(?:https?:|mailto:)/i.test(href)) return href;
	if (/^[a-z][a-z0-9+.-]*:/i.test(href)) return null;
	return href;
}

const markdown = new Marked({
	breaks: true,
	gfm: true,
	renderer: {
		html({ text }) {
			const cleaned = text.replace(/<\/?(?:advisory|span|text)\b(?:\s[^>]*)?\s*\/?>/gi, "");
			return cleaned === "" ? "" : escapeHtml(unescapeHtml(cleaned));
		},
		link({ href, title, tokens }) {
			const content = this.parser.parseInline(tokens);
			const safeUrl = safeHref(href);
			if (safeUrl === null) return content;
			const titleAttribute = title ? ` title="${escapeHtml(title)}"` : "";
			return `<a href="${escapeHtml(safeUrl)}"${titleAttribute} target="_blank" rel="noopener noreferrer">${content}</a>`;
		},
	},
});

export function renderStudioMarkdown(text: string): string {
	try {
		return markdown.parse(text, { async: false });
	} catch {
		return escapeHtml(text);
	}
}

interface StudioMarkdownProps {
	text: string;
}

/** GFM transcript rendering aligned with the CLI's Markdown-based message components. */
export const StudioMarkdown = memo(function StudioMarkdown({ text }: StudioMarkdownProps): ReactNode {
	const html = useMemo(() => renderStudioMarkdown(text), [text]);
	return <div className="studio-message-markdown" dangerouslySetInnerHTML={{ __html: html }} />;
});
