import { and, eq, isNull, or, sql, type SQL } from "drizzle-orm";
import { getDb } from "@/db";
import { folders, messages } from "@/db/schema";
import { getMailboxAccessLevel } from "@/lib/mailboxes/access";
import { recordAction } from "@/lib/agent-actions/service";
import type { McpPrincipal } from "./types";

export function output(value: unknown, isError = false) {
	return { content: [{ type: "text" as const, text: JSON.stringify(value) }], isError };
}

export function audit(principal: McpPrincipal, tool: string, mailboxId?: string) {
	console.info(JSON.stringify({ audit: "mcp", tool, userId: principal.user.id, mailboxId }));
}

export type CompatDb = ReturnType<typeof getDb>;

/** Mailbox allowlist + the key user's access level; manage requires canManage. */
export async function compatDb(env: CloudflareEnv, principal: McpPrincipal, mailboxId: string, manage: boolean): Promise<CompatDb | null> {
	if (!principal.mailboxIds.includes(mailboxId)) return null;
	const db = getDb(env);
	const access = await getMailboxAccessLevel(db, principal.user, mailboxId);
	if (!access?.canRead || (manage && !access.canManage)) return null;
	return db;
}

export const denied = () => output({ error: "Permission denied" }, true);

export function errorMessage(error: unknown, fallback: string) {
	return error instanceof Error ? error.message : fallback;
}

/** ISO 8601 instant or a relative shorthand like 30m, 4h, 3d, 1w. */
export function parseWhen(value: string): Date | null {
	const trimmed = value.trim();
	const relative = trimmed.match(/^(\d+)(m|h|d|w)$/i);
	if (relative) {
		const amount = Number(relative[1]);
		const unit = relative[2].toLowerCase();
		const ms = unit === "m" ? 60_000 : unit === "h" ? 3_600_000 : unit === "d" ? 86_400_000 : 604_800_000;
		return new Date(Date.now() + amount * ms);
	}
	const date = new Date(trimmed);
	return Number.isNaN(date.getTime()) ? null : date;
}

/** Resolve a folder reference (id or display name) to a user folder id. */
export async function resolveFolder(db: CompatDb, mailboxId: string, reference: string): Promise<string | null> {
	const needle = reference.trim().toLowerCase();
	if (!needle) return null;
	const rows = await db.select({ id: folders.id, name: folders.name }).from(folders).where(eq(folders.mailboxId, mailboxId));
	const found = rows.find((row) => row.id.toLowerCase() === needle || row.name.toLowerCase() === needle);
	return found?.id ?? null;
}

/**
 * Folder filter for the agentic-inbox contract: system folders map to message
 * status, custom folders to folderId. `userId` scopes drafts to their author.
 */
export function folderCondition(folder: string, userId: string, folderId: string | null): SQL | null {
	switch (folder) {
		case "inbox": return and(eq(messages.status, "received"), isNull(messages.folderId), isNull(messages.snoozedUntil))!;
		case "sent": return eq(messages.status, "sent");
		case "draft": return and(eq(messages.status, "draft"), eq(messages.userId, userId))!;
		case "archive": return eq(messages.status, "archived");
		case "snoozed": return sql`${messages.snoozedUntil} is not null`;
		case "spam": return eq(messages.status, "spam");
		case "trash": return eq(messages.status, "trash");
		case "scheduled": return eq(messages.status, "queued");
		default: return folderId ? eq(messages.folderId, folderId) : null;
	}
}

/** The conversation key the message list uses: thread id, or the lone message id. */
export function threadKeyOf(row: { id: string; threadId: string | null }): string {
	return row.threadId ?? row.id;
}

/** Record a mutating tool call for the undo log (metadata only, never bodies). */
export async function recordMutation(
	db: CompatDb,
	mailboxId: string,
	tool: string,
	row: { id: string; subject: string | null; threadId: string | null; folderId: string | null; read: boolean; starred: boolean },
	after: { folderId?: string | null; read?: boolean; starred?: boolean },
	undoable: boolean,
): Promise<void> {
	try {
		await recordAction(db, mailboxId, {
			tool,
			messageId: row.id,
			subject: row.subject,
			threadKey: threadKeyOf(row),
			before: { folderId: row.folderId, read: row.read, starred: row.starred },
			after,
			undoable,
		});
	} catch (error) {
		console.error(`Action recording failed for ${tool}`, error);
	}
}

/** Load a message of the mailbox, or throw a tool-readable error. */
export async function ownMessage(db: CompatDb, mailboxId: string, emailId: string) {
	const [row] = await db.select().from(messages).where(and(eq(messages.id, emailId), eq(messages.mailboxId, mailboxId))).limit(1);
	if (!row) throw new Error("Email not found");
	return row;
}

export { and, eq, isNull, or, sql };