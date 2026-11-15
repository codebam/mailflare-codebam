import { and, eq } from "drizzle-orm";
import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { getDb } from "@/db";
import { messages } from "@/db/schema";
import { getMailboxAccessLevel } from "@/lib/mailboxes/access";
import { applyRule, createRule, deleteRule, listRules, previewRule, reorderRules, updateRule } from "@/lib/rules/service";
import { RuleValidationError } from "@/lib/rules/engine";
import { createTemplate, deleteTemplate, listTemplates, updateTemplate } from "@/lib/templates/service";
import { createSavedSearch, deleteSavedSearch, listSavedSearches, updateSavedSearch } from "@/lib/saved-searches/service";
import { muteThread, unmuteThread } from "@/lib/mute/service";
import { listActions, undoAction } from "@/lib/agent-actions/service";
import { listItems, updateItem } from "@/lib/items/service";
import { getDigest } from "@/lib/digest/service";
import type { McpPrincipal } from "./types";

function output(value: unknown, isError = false) {
	return { content: [{ type: "text" as const, text: JSON.stringify(value) }], isError };
}

function audit(principal: McpPrincipal, tool: string, mailboxId?: string) {
	console.info(JSON.stringify({ audit: "mcp", tool, userId: principal.user.id, mailboxId }));
}

const errorMessage = (error: unknown, fallback: string) => (error instanceof Error ? error.message : fallback);

/**
 * Organize tools ported from agentic-inbox: deterministic rules (with preview
 * and retroactive apply), composer templates, saved searches and thread mute.
 * Reads need mcp:read, writes mcp:organize; every call is mailbox-scoped.
 */
export function registerOrganizeMcpTools(server: McpServer, principal: McpPrincipal, env: CloudflareEnv) {
	const dbFor = async (mailboxId: string, manage: boolean) => {
		if (!principal.mailboxIds.includes(mailboxId)) return null;
		const db = getDb(env);
		const access = await getMailboxAccessLevel(db, principal.user, mailboxId);
		if (!access?.canRead || (manage && !access.canManage)) return null;
		return db;
	};
	const denied = () => output({ error: "Permission denied" }, true);
	const guard = async (mailboxId: string, manage: boolean, tool: string, run: (db: NonNullable<Awaited<ReturnType<typeof dbFor>>>) => Promise<unknown>) => {
		const scope = manage ? "mcp:organize" : "mcp:read";
		if (!principal.scopes.includes(scope)) return denied();
		const db = await dbFor(mailboxId, manage);
		if (!db) return denied();
		audit(principal, tool, mailboxId);
		try { return output(await run(db)); }
		catch (error) {
			if (error instanceof RuleValidationError) return output({ error: error.message }, true);
			return output({ error: errorMessage(error, "Tool failed") }, true);
		}
	};

	// ---- Rules ----
	const conditionsSchema = z.object({
		from_contains: z.string().optional(),
		to_contains: z.string().optional(),
		subject_contains: z.string().optional(),
		body_contains: z.string().optional(),
		has_attachment: z.boolean().optional(),
		category_equals: z.string().optional(),
	});
	const matchSchema = z.object({ mode: z.enum(["all", "any"]).default("all"), conditions: conditionsSchema });
	const actionsSchema = z.object({
		move_to_folder: z.string().optional(),
		set_category: z.string().optional(),
		mark_read: z.boolean().optional(),
		mark_unread: z.boolean().optional(),
		star: z.boolean().optional(),
		unstar: z.boolean().optional(),
		discard: z.boolean().optional(),
		// Accepted by the schema so the service can refuse them with the
		// operator-only message; agent/MCP rules can never send mail.
		forward_to: z.string().optional(),
		auto_reply_text: z.string().optional(),
	});
	server.registerTool("list_rules", { description: "List the mailbox's deterministic rules in evaluation order, with firing statistics.", inputSchema: z.object({ mailboxId: z.string() }), annotations: { readOnlyHint: true, openWorldHint: false } }, async ({ mailboxId }) =>
		guard(mailboxId, false, "list_rules", async (db) => ({ rules: await listRules(db, mailboxId) })));
	server.registerTool("create_rule", { description: "Create a deterministic rule for incoming mail: move it to a folder, set a category, star/unstar, mark read/unread, or discard it. Rules created here cannot send mail (no forward or auto-reply). Needs at least one match condition and one action.", inputSchema: z.object({ mailboxId: z.string(), name: z.string(), match: matchSchema, actions: actionsSchema, enabled: z.boolean().optional(), priority: z.number().int().optional() }), annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false } }, async ({ mailboxId, ...draft }) =>
		guard(mailboxId, true, "create_rule", async (db) => ({ rule: await createRule(db, mailboxId, draft, { agent: true }) })));
	server.registerTool("update_rule", { description: "Update a rule: rename, reorder, change its conditions or actions, enable or pause it. Omitted fields keep their stored value. Rules edited here cannot send mail.", inputSchema: z.object({ mailboxId: z.string(), ruleId: z.string(), name: z.string().optional(), match: matchSchema.optional(), actions: actionsSchema.optional(), enabled: z.boolean().optional(), priority: z.number().int().optional() }), annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false } }, async ({ mailboxId, ruleId, ...patch }) =>
		guard(mailboxId, true, "update_rule", async (db) => ({ rule: await updateRule(db, mailboxId, ruleId, patch, { agent: true }) })));
	server.registerTool("delete_rule", { description: "Delete one rule by id. Nothing is sent and no mail is changed; the rule's firing statistics go with it.", inputSchema: z.object({ mailboxId: z.string(), ruleId: z.string() }), annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false } }, async ({ mailboxId, ruleId }) =>
		guard(mailboxId, true, "delete_rule", async (db) => {
			const deleted = await deleteRule(db, mailboxId, ruleId);
			if (!deleted) throw new Error("Rule not found");
			return { deleted: true };
		}));
	server.registerTool("preview_rule", { description: "Dry-run a rule draft against the mailbox's stored mail: returns the matching message summaries (up to 200) and how many messages the draft matches, writing nothing and sending nothing.", inputSchema: z.object({ mailboxId: z.string(), name: z.string().optional(), match: matchSchema }), annotations: { readOnlyHint: true, openWorldHint: false } }, async ({ mailboxId, name, match }) =>
		guard(mailboxId, false, "preview_rule", async (db) => previewRule(db, mailboxId, { name, match })));
	server.registerTool("apply_rule", { description: "Retroactively apply a stored rule's folder, category, read and star actions to existing mail, one bounded batch per call (loop while remaining > 0). Strictly local: it never sends, never deletes and never records a rule firing.", inputSchema: z.object({ mailboxId: z.string(), ruleId: z.string(), limit: z.number().int().min(1).max(90).optional() }), annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false } }, async ({ mailboxId, ruleId, limit }) =>
		guard(mailboxId, true, "apply_rule", async (db) => applyRule(db, mailboxId, ruleId, limit)));
	server.registerTool("reorder_rules", { description: "Rewrite rule priorities to follow the given id order (the first id evaluates first). Unknown or repeated ids are ignored; rules missing from the list keep their relative order after the listed ones.", inputSchema: z.object({ mailboxId: z.string(), ruleIds: z.array(z.string().min(1)).min(1).max(200) }), annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false } }, async ({ mailboxId, ruleIds }) =>
		guard(mailboxId, true, "reorder_rules", async (db) => ({ rules: await reorderRules(db, mailboxId, ruleIds) })));

	// ---- Templates ----
	const templateError = (error: string) => {
		throw new Error(error === "name_taken" ? "A template with that name already exists" : error === "limit_reached" ? "This mailbox has reached the template limit (200)" : error === "invalid_name" ? "Template name must be 1-120 characters" : error === "invalid_subject" ? "Subject must be at most 500 characters" : error === "invalid_body" ? "Body must be 1-100000 characters" : "Template not found");
	};
	server.registerTool("list_templates", { description: "List the mailbox's message templates — reusable snippets (name, optional subject, body).", inputSchema: z.object({ mailboxId: z.string() }), annotations: { readOnlyHint: true, openWorldHint: false } }, async ({ mailboxId }) =>
		guard(mailboxId, false, "list_templates", async (db) => ({ templates: await listTemplates(db, mailboxId) })));
	server.registerTool("create_template", { description: "Create one message template — a reusable snippet with a name, an optional subject and a body. Nothing here sends mail.", inputSchema: z.object({ mailboxId: z.string(), name: z.string(), subject: z.string().nullable().optional(), body: z.string() }), annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false } }, async ({ mailboxId, name, subject, body }) =>
		guard(mailboxId, true, "create_template", async (db) => {
			const result = await createTemplate(db, mailboxId, { name, subject, body });
			if (!result.ok) templateError(result.error);
			return { template: result.ok ? result.template : null };
		}));
	server.registerTool("update_template", { description: "Update one template by id: rename it, change its optional subject or rewrite its body. Omitted fields keep their stored value; an explicit null subject clears it.", inputSchema: z.object({ mailboxId: z.string(), templateId: z.string(), name: z.string().optional(), subject: z.string().nullable().optional(), body: z.string().optional() }), annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false } }, async ({ mailboxId, templateId, ...input }) =>
		guard(mailboxId, true, "update_template", async (db) => {
			const result = await updateTemplate(db, mailboxId, templateId, input);
			if (!result.ok) templateError(result.error);
			return { template: result.ok ? result.template : null };
		}));
	server.registerTool("delete_template", { description: "Delete one message template by id. Nothing here sends mail.", inputSchema: z.object({ mailboxId: z.string(), templateId: z.string() }), annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false } }, async ({ mailboxId, templateId }) =>
		guard(mailboxId, true, "delete_template", async (db) => {
			const result = await deleteTemplate(db, mailboxId, templateId);
			if (!result.ok) templateError(result.error);
			return { deleted: true };
		}));

	// ---- Saved searches ----
	const searchError = (error: string) => {
		throw new Error(error === "limit_reached" ? "This mailbox has reached the saved-search limit (50)" : error === "invalid_name" ? "Search name must be 1-120 characters" : error === "invalid_query" ? "Query must be 1-1000 characters" : "Saved search not found");
	};
	server.registerTool("list_saved_searches", { description: "List the mailbox's saved searches — named queries re-run from the sidebar — newest first.", inputSchema: z.object({ mailboxId: z.string() }), annotations: { readOnlyHint: true, openWorldHint: false } }, async ({ mailboxId }) =>
		guard(mailboxId, false, "list_saved_searches", async (db) => ({ searches: await listSavedSearches(db, mailboxId) })));
	server.registerTool("create_saved_search", { description: "Save a named search for a mailbox: a name (up to 120 characters) and a query (up to 1000 characters). Names need not be unique. Nothing is sent.", inputSchema: z.object({ mailboxId: z.string(), name: z.string(), query: z.string() }), annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false } }, async ({ mailboxId, name, query }) =>
		guard(mailboxId, true, "create_saved_search", async (db) => {
			const result = await createSavedSearch(db, mailboxId, { name, query });
			if (!result.ok) searchError(result.error);
			return { search: result.ok ? result.search : null };
		}));
	server.registerTool("update_saved_search", { description: "Update one saved search by id: rename it and/or change its query. Omitted fields keep their stored value.", inputSchema: z.object({ mailboxId: z.string(), searchId: z.string(), name: z.string().optional(), query: z.string().optional() }), annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false } }, async ({ mailboxId, searchId, ...input }) =>
		guard(mailboxId, true, "update_saved_search", async (db) => {
			const result = await updateSavedSearch(db, mailboxId, searchId, input);
			if (!result.ok) searchError(result.error);
			return { search: result.ok ? result.search : null };
		}));
	server.registerTool("delete_saved_search", { description: "Delete one saved search by id. Nothing else is touched and nothing is sent.", inputSchema: z.object({ mailboxId: z.string(), searchId: z.string() }), annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false } }, async ({ mailboxId, searchId }) =>
		guard(mailboxId, true, "delete_saved_search", async (db) => {
			const result = await deleteSavedSearch(db, mailboxId, searchId);
			if (!result.ok) searchError(result.error);
			return { deleted: true };
		}));

	// ---- Thread mute ----
	/** Accept a thread id or any message id of the thread; resolve to the conversation key. */
	const threadKeyFor = async (db: NonNullable<Awaited<ReturnType<typeof dbFor>>>, mailboxId: string, threadId: string) => {
		const [row] = await db.select({ threadId: messages.threadId }).from(messages).where(and(eq(messages.id, threadId), eq(messages.mailboxId, mailboxId))).limit(1);
		return row ? (row.threadId ?? threadId) : threadId;
	};
	server.registerTool("mute_thread", { description: "Mute a thread: new mail in it is skipped by push and webhook notifications. Muting an unknown thread id is allowed and muting twice is idempotent; nothing is deleted.", inputSchema: z.object({ mailboxId: z.string(), threadId: z.string() }), annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false } }, async ({ mailboxId, threadId }) =>
		guard(mailboxId, true, "mute_thread", async (db) => {
			await muteThread(db, mailboxId, await threadKeyFor(db, mailboxId, threadId));
			return { muted: true };
		}));
	server.registerTool("unmute_thread", { description: "Unmute a thread so its new mail notifies again. Unmuting is idempotent; nothing is deleted.", inputSchema: z.object({ mailboxId: z.string(), threadId: z.string() }), annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false } }, async ({ mailboxId, threadId }) =>
		guard(mailboxId, true, "unmute_thread", async (db) => {
			await unmuteThread(db, mailboxId, await threadKeyFor(db, mailboxId, threadId));
			return { muted: false };
		}));

	// ---- Agent action log + undo ----
	server.registerTool("list_agent_actions", { description: "List the most recent mutating tool calls recorded for this mailbox, newest first, with the total number recorded. Metadata only (tool, message id, subject, thread id, folder/read/star state) — never message bodies.", inputSchema: z.object({ mailboxId: z.string(), limit: z.number().int().min(1).max(200).optional() }), annotations: { readOnlyHint: true, openWorldHint: false } }, async ({ mailboxId, limit }) =>
		guard(mailboxId, false, "list_agent_actions", async (db) => listActions(db, mailboxId, limit)));
	server.registerTool("undo_action", { description: "Undo one recorded mutating tool call by its action id: restores the message's read state, star state and folder from the state recorded before the call. It never sends and never deletes mail; only actions flagged undoable (move, star, mark read) can be undone, and each action can be undone once.", inputSchema: z.object({ mailboxId: z.string(), actionId: z.string() }), annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false } }, async ({ mailboxId, actionId }) =>
		guard(mailboxId, true, "undo_action", async (db) => {
			const result = await undoAction(db, mailboxId, actionId);
			if (!result.ok) {
				throw new Error(result.error === "not_found" ? "Action not found" : result.error === "not_undoable" ? "This action cannot be undone" : result.error === "already_undone" ? "This action was already undone" : "The message no longer exists");
			}
			return { action: result.action };
		}));

	// ---- Items (tasks and deadlines) ----
	server.registerTool("list_items", { description: "List the tasks and deadlines extracted from this mailbox's mail — one entry per concrete task or deadline, with its source message id, kind (task | deadline), title, details, due date and status (open | done | dismissed).", inputSchema: z.object({ mailboxId: z.string(), status: z.enum(["open", "done", "dismissed"]).optional(), due: z.enum(["overdue", "today", "upcoming", "none"]).optional() }), annotations: { readOnlyHint: true, openWorldHint: false } }, async ({ mailboxId, status, due }) =>
		guard(mailboxId, false, "list_items", async (db) => ({ items: await listItems(db, mailboxId, { status, due }) })));
	server.registerTool("update_item", { description: "Move a task or deadline extracted from this mailbox's mail to a new state: open, done or dismissed. Answers the stored item. Nothing is sent.", inputSchema: z.object({ mailboxId: z.string(), itemId: z.string(), status: z.enum(["open", "done", "dismissed"]) }), annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false } }, async ({ mailboxId, itemId, status }) =>
		guard(mailboxId, true, "update_item", async (db) => {
			const result = await updateItem(db, mailboxId, itemId, { status });
			if (!result.ok) throw new Error(result.error === "not_found" ? "Item not found" : "Invalid item update");
			return { item: result.item };
		}));

	// ---- Digest ----
	server.registerTool("get_digest", { description: "The mailbox's morning brief for the trailing 24 hours: arrivals, what still needs a reply, the category breakdown, fired reminders and the items due. Read-only — nothing is stored or sent.", inputSchema: z.object({ mailboxId: z.string() }), annotations: { readOnlyHint: true, openWorldHint: false } }, async ({ mailboxId }) =>
		guard(mailboxId, false, "get_digest", async (db) => getDigest(db, mailboxId)));
}