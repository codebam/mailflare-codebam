import { and, eq, gte, lte, sql } from "drizzle-orm";
import type { AppDatabase } from "@/db";
import { messages } from "@/db/schema";
import type { ParsedEmail } from "@/lib/email/parse";

/**
 * Delivery-report (DSN) matching, ported from agentic-inbox's delivery-match.
 * A bounce names the original message by Message-ID; the matcher tries the
 * stored provider Message-ID first, then a bounded subject+recipient fallback
 * that matches only when exactly one Sent copy remains — ambiguity is a
 * no-op, never a guess. Best-effort: the DSN itself is stored as ordinary
 * mail whatever the match does.
 */

/** How far before a report's arrival a Sent copy may be dated and still be considered. */
export const DELIVERY_MATCH_WINDOW_DAYS = 7;
/** Slack after the report's arrival for clock skew. */
export const DELIVERY_MATCH_WINDOW_SKEW_MS = 60 * 60 * 1000;

export function deliveryMatchWindow(receivedAt: Date): { from: Date; to: Date } {
	const anchor = receivedAt.getTime();
	return {
		from: new Date(anchor - DELIVERY_MATCH_WINDOW_DAYS * 24 * 60 * 60 * 1000),
		to: new Date(anchor + DELIVERY_MATCH_WINDOW_SKEW_MS),
	};
}

/** Trim, collapse whitespace, casefold; no prefix stripping, deliberately conservative. */
export function normalizeDeliverySubject(value: string | null | undefined): string {
	return (value ?? "").replace(/\s+/g, " ").trim().toLowerCase();
}

export type DeliveryReport = {
	status: "failed" | "delayed" | "delivered";
	detail: string | null;
	originalMessageId: string | null;
	finalRecipient: string | null;
	originalSubject: string | null;
};

const decoder = new TextDecoder();

function attachmentText(parsed: ParsedEmail, types: string[]): string | null {
	for (const attachment of parsed.attachments) {
		if (types.includes(attachment.type.toLowerCase())) {
			try { return decoder.decode(attachment.content); } catch { return null; }
		}
	}
	return null;
}

/** A DSN carries a message/delivery-status part (multipart/report). */
export function isDeliveryReport(parsed: ParsedEmail): boolean {
	return parsed.attachments.some((attachment) => attachment.type.toLowerCase() === "message/delivery-status");
}

/** Parse the delivery-status fields and the embedded original headers. */
export function parseDeliveryReport(parsed: ParsedEmail): DeliveryReport | null {
	const statusText = attachmentText(parsed, ["message/delivery-status"]);
	if (!statusText) return null;
	const fields = new Map<string, string>();
	let lastKey: string | null = null;
	for (const line of statusText.split(/\r?\n/)) {
		if (/^\s/.test(line) && lastKey) {
			fields.set(lastKey, `${fields.get(lastKey) ?? ""} ${line.trim()}`);
			continue;
		}
		const match = line.match(/^([A-Za-z-]+):\s*(.*)$/);
		if (match) {
			lastKey = match[1].toLowerCase();
			fields.set(lastKey, match[2].trim());
		}
	}
	const action = (fields.get("action") ?? "").toLowerCase();
	const status = action === "failed" ? "failed" : action === "delayed" ? "delayed" : action === "delivered" || action === "relayed" || action === "expanded" ? "delivered" : null;
	if (!status) return null;
	const diagnostic = fields.get("diagnostic-code") ?? null;
	const statusField = fields.get("status") ?? null;
	const detail = [statusField, diagnostic].filter(Boolean).join(" — ").slice(0, 500) || null;
	const finalRecipientRaw = fields.get("final-recipient") ?? fields.get("original-recipient") ?? null;
	const finalRecipient = finalRecipientRaw ? finalRecipientRaw.split(";").pop()!.trim().toLowerCase() : null;
	// The original Message-ID and Subject ride in the text/rfc822-headers part when present.
	const headersText = attachmentText(parsed, ["text/rfc822-headers"]);
	let originalMessageId: string | null = null;
	let originalSubject: string | null = null;
	if (headersText) {
		const idMatch = headersText.match(/^Message-ID:\s*(.+)$/im);
		if (idMatch) originalMessageId = idMatch[1].trim();
		const subjectMatch = headersText.match(/^Subject:\s*(.+)$/im);
		if (subjectMatch) originalSubject = subjectMatch[1].trim();
	}
	return { status, detail, originalMessageId, finalRecipient, originalSubject };
}

function stripAngleBrackets(value: string): string {
	return value.trim().replace(/^<|>$/g, "");
}

/**
 * Match the report to a Sent copy and record the outcome. Returns what
 * happened; never throws for a missing match.
 */
export async function applyDeliveryReport(
	db: AppDatabase,
	mailboxId: string,
	parsed: ParsedEmail,
	receivedAt = new Date(),
): Promise<{ matched: boolean; messageId?: string; status?: DeliveryReport["status"] }> {
	if (!isDeliveryReport(parsed)) return { matched: false };
	const report = parseDeliveryReport(parsed);
	if (!report) return { matched: false };
	const sentCondition = and(eq(messages.mailboxId, mailboxId), eq(messages.direction, "outbound"), eq(messages.status, "sent"));
	let target: { id: string } | undefined;
	if (report.originalMessageId) {
		const bare = stripAngleBrackets(report.originalMessageId);
		const [row] = await db
			.select({ id: messages.id })
			.from(messages)
			.where(and(sentCondition, sql`(${messages.providerMessageId} = ${bare} OR ${messages.providerMessageId} = ${`<${bare}>`})`))
			.limit(1);
		target = row;
	}
	if (!target && report.originalSubject && report.finalRecipient) {
		const window = deliveryMatchWindow(receivedAt);
		const candidates = await db
			.select({ id: messages.id, subject: messages.subject, toAddr: messages.toAddr })
			.from(messages)
			.where(and(sentCondition, gte(messages.createdAt, window.from), lte(messages.createdAt, window.to)));
		const subject = normalizeDeliverySubject(report.originalSubject);
		const matches = candidates.filter((row) =>
			normalizeDeliverySubject(row.subject) === subject &&
			(row.toAddr ?? "").toLowerCase().includes(report.finalRecipient!),
		);
		if (matches.length === 1) target = matches[0];
	}
	if (!target) return { matched: false };
	await db.update(messages).set({ deliveryStatus: report.status, deliveryDetail: report.detail }).where(eq(messages.id, target.id));
	return { matched: true, messageId: target.id, status: report.status };
}