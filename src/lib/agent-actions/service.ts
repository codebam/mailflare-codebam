import { and, desc, eq, sql } from "drizzle-orm";
import type { AppDatabase } from "@/db";
import { agentActions, messages } from "@/db/schema";
import { newId } from "@/lib/ids";
import type { ActionState, AgentAction, UndoResult } from "./types";

/**
 * Metadata-only log of mutating tool calls. Bodies are never stored — only
 * the tool, the message reference, and the before/after folder/read/star
 * state needed to undo once.
 */

export async function recordAction(
	db: AppDatabase,
	mailboxId: string,
	input: {
		tool: string;
		messageId?: string | null;
		subject?: string | null;
		threadKey?: string | null;
		before?: ActionState | null;
		after?: ActionState | null;
		undoable?: boolean;
	},
): Promise<AgentAction> {
	const id = newActionId(new Date());
	await db.insert(agentActions).values({
		id,
		mailboxId,
		tool: input.tool,
		messageId: input.messageId ?? null,
		subject: input.subject ?? null,
		threadKey: input.threadKey ?? null,
		beforeState: input.before ? JSON.stringify(input.before) : null,
		afterState: input.after ? JSON.stringify(input.after) : null,
		undoable: input.undoable === true,
	});
	const [row] = await db.select().from(agentActions).where(eq(agentActions.id, id)).limit(1);
	if (!row) throw new Error("The action was not recorded");
	return toAction(row);
}

/** Newest first, with the total number recorded for the mailbox. */
export async function listActions(db: AppDatabase, mailboxId: string, limit = 50): Promise<{ actions: AgentAction[]; total: number }> {
	const bounded = Math.max(1, Math.min(Math.floor(limit), 200));
	const rows = await db.select().from(agentActions).where(eq(agentActions.mailboxId, mailboxId)).orderBy(desc(agentActions.createdAt), desc(agentActions.id)).limit(bounded);
	const [count] = await db.select({ total: sql<number>`count(*)` }).from(agentActions).where(eq(agentActions.mailboxId, mailboxId));
	return { actions: rows.map(toAction), total: Number(count?.total ?? 0) };
}

/**
 * Restore the message's folder/read/star state from before the call. Only
 * actions flagged undoable can be undone, and each only once. Never sends,
 * never deletes.
 */
export async function undoAction(db: AppDatabase, mailboxId: string, actionId: string): Promise<UndoResult> {
	const [row] = await db.select().from(agentActions).where(and(eq(agentActions.id, actionId), eq(agentActions.mailboxId, mailboxId))).limit(1);
	if (!row) return { ok: false, error: "not_found" };
	if (!row.undoable || !row.beforeState) return { ok: false, error: "not_undoable" };
	if (row.undoneAt) return { ok: false, error: "already_undone" };
	if (!row.messageId) return { ok: false, error: "message_gone" };
	const [message] = await db.select({ id: messages.id }).from(messages).where(and(eq(messages.id, row.messageId), eq(messages.mailboxId, mailboxId))).limit(1);
	if (!message) return { ok: false, error: "message_gone" };
	const before = JSON.parse(row.beforeState) as ActionState;
	await db.update(messages).set({
		...(before.folderId !== undefined ? { folderId: before.folderId } : {}),
		...(before.read !== undefined ? { read: before.read } : {}),
		...(before.starred !== undefined ? { starred: before.starred } : {}),
	}).where(eq(messages.id, row.messageId));
	await db.update(agentActions).set({ undoneAt: new Date() }).where(eq(agentActions.id, actionId));
	const [updated] = await db.select().from(agentActions).where(eq(agentActions.id, actionId)).limit(1);
	return { ok: true, action: toAction(updated) };
}

let lastActionIdTime = 0;

/**
 * created_at keeps whole seconds, so actions recorded in the same second are
 * ordered by id: it starts with the time in milliseconds, one higher than the
 * last when two actions share a millisecond (same pattern as conversation notes).
 */
function newActionId(now: Date): string {
	lastActionIdTime = Math.max(now.getTime(), lastActionIdTime + 1);
	return newId(`act_${lastActionIdTime.toString(36).padStart(9, "0")}`);
}

function toAction(row: typeof agentActions.$inferSelect): AgentAction {
	return {
		id: row.id,
		tool: row.tool,
		messageId: row.messageId,
		subject: row.subject,
		threadKey: row.threadKey,
		beforeState: row.beforeState ? (JSON.parse(row.beforeState) as ActionState) : null,
		afterState: row.afterState ? (JSON.parse(row.afterState) as ActionState) : null,
		undoable: row.undoable,
		undoneAt: row.undoneAt ? row.undoneAt.toISOString() : null,
		createdAt: row.createdAt.toISOString(),
	};
}