import type { AppDatabase } from "@/db";
import { attachmentTexts } from "@/db/schema";
import type { AttachmentContent, StoredAttachment } from "@/lib/email/attachment-types";

/**
 * Attachment text extraction for search, ported from agentic-inbox. Text-ish
 * parts are decoded locally; HTML is stripped to text. Rich formats (PDF)
 * need the AI conversion adapter and are skipped until it lands. Every
 * function is defensive — a file that cannot be decoded simply has no search
 * text.
 */

/** Longest text one attachment contributes to the search index. */
export const MAX_ATTACHMENT_TEXT_CHARS = 100_000;
/** Inputs larger than this are skipped instead of decoded (5 MiB). */
export const MAX_ATTACHMENT_TEXT_INPUT_BYTES = 5 * 1024 * 1024;
/** Most rows one storeAttachmentTexts call writes. */
export const MAX_ATTACHMENT_TEXT_ROWS = 50;

const TEXT_APPLICATION_TYPES = new Set([
	"application/json",
	"application/xml",
	"application/javascript",
	"application/x-ndjson",
	"application/csv",
	"application/x-sh",
	"application/yaml",
	"application/x-yaml",
]);
const TEXT_EXTENSIONS = /\.(txt|md|csv|json|xml|ya?ml|log|ts|tsx|js|jsx|py|rs|go|sh|eml|ics)$/i;

const decoder = new TextDecoder("utf-8", { fatal: false });

function stripHtml(html: string): string {
	return html
		.replace(/<script[\s\S]*?<\/script>/gi, " ")
		.replace(/<style[\s\S]*?<\/style>/gi, " ")
		.replace(/<br\s*\/?>/gi, "\n")
		.replace(/<\/(p|div|li|h[1-6]|tr)>/gi, "\n")
		.replace(/<[^>]+>/g, " ")
		.replace(/&nbsp;/gi, " ")
		.replace(/&lt;/gi, "<")
		.replace(/&gt;/gi, ">")
		.replace(/&quot;/gi, '"')
		.replace(/&#39;/gi, "'")
		.replace(/&amp;/gi, "&")
		.replace(/[ \t]{2,}/g, " ");
}

/** Extracted search text, or null when the attachment cannot contribute any. */
export function extractAttachmentText(filename: string, type: string, content: ArrayBuffer): string | null {
	if (content.byteLength === 0 || content.byteLength > MAX_ATTACHMENT_TEXT_INPUT_BYTES) return null;
	const lowerType = (type || "").toLowerCase().split(";")[0].trim();
	const isHtml = lowerType === "text/html" || /\.html?$/i.test(filename);
	const isText = lowerType.startsWith("text/") || TEXT_APPLICATION_TYPES.has(lowerType) || TEXT_EXTENSIONS.test(filename);
	if (!isText) return null;
	let text: string;
	try {
		text = decoder.decode(content);
	} catch {
		return null;
	}
	if (isHtml) text = stripHtml(text);
	text = text.replace(/\u0000/g, "").trim();
	if (!text) return null;
	return text.length > MAX_ATTACHMENT_TEXT_CHARS ? text.slice(0, MAX_ATTACHMENT_TEXT_CHARS) : text;
}

/**
 * Store extracted text for a message's freshly stored attachments. `stored`
 * and `sources` are index-aligned (storeMessageAttachments preserves order).
 * Best-effort: extraction failures never fail intake.
 */
export async function storeAttachmentTexts(db: AppDatabase, stored: StoredAttachment[], sources: AttachmentContent[]): Promise<number> {
	let written = 0;
	for (let index = 0; index < stored.length && written < MAX_ATTACHMENT_TEXT_ROWS; index += 1) {
		const source = sources[index];
		if (!source) continue;
		const text = extractAttachmentText(stored[index].filename, stored[index].type, source.content);
		if (!text) continue;
		try {
			await db.insert(attachmentTexts).values({ attachmentId: stored[index].id, content: text }).onConflictDoNothing();
			written += 1;
		} catch {
			// Search text is derived data; losing one row never loses mail.
		}
	}
	return written;
}