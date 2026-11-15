import { and, asc, desc, eq, inArray } from "drizzle-orm";
import type { AppDatabase } from "@/db";
import { folders, messageAttachments, messages, rules } from "@/db/schema";
import { newId } from "@/lib/ids";
import {
	MAX_RULE_NAME_LENGTH,
	MAX_RULE_PRIORITY,
	RULE_APPLY_LIMIT_DEFAULT,
	RULE_APPLY_LIMIT_MAX,
	RULE_PREVIEW_MAX_MATCHES,
	RULE_PREVIEW_SCAN_LIMIT,
	RuleValidationError,
	hasActiveActions,
	hasActiveConditions,
	hasLocalRuleActions,
	isRuleEmailAddress,
	localRuleActions,
	matchRule,
	normalizeRuleActions,
	normalizeRuleMatch,
	resolveRuleFolderId,
	ruleNeedsChange,
	runRules,
	type MailRule,
	type RuleApplyResult,
	type RuleDraft,
	type RuleEmail,
	type RulePatch,
	type RulePreviewDraft,
	type RulePreviewMatch,
	type RulePreviewResult,
	type RuleRunResult,
} from "./engine";

export type RuleRow = typeof rules.$inferSelect;

/** Stored row to the engine/API shape (match and actions are JSON columns). */
export function toMailRule(row: RuleRow): MailRule {
	return {
		id: row.id,
		name: row.name,
		enabled: row.enabled,
		priority: row.priority,
		match: normalizeRuleMatch(JSON.parse(row.match)),
		actions: normalizeRuleActions(JSON.parse(row.actions)),
		created_at: row.createdAt.toISOString(),
		fired_count: row.firedCount,
		last_fired_at: row.lastFiredAt ? row.lastFiredAt.toISOString() : null,
	};
}

/** Every rule of the mailbox in evaluation order (priority, then creation, then id). */
export async function listRules(db: AppDatabase, mailboxId: string): Promise<MailRule[]> {
	const rows = await db.select().from(rules).where(eq(rules.mailboxId, mailboxId)).orderBy(asc(rules.priority), asc(rules.createdAt), asc(rules.id));
	return rows.map(toMailRule);
}

export async function getRule(db: AppDatabase, mailboxId: string, ruleId: string): Promise<MailRule | null> {
	const [row] = await db.select().from(rules).where(and(eq(rules.id, ruleId), eq(rules.mailboxId, mailboxId))).limit(1);
	return row ? toMailRule(row) : null;
}

/**
 * Validate and normalize a draft into storable values. `agent` paths may never
 * store outbound actions; folder references resolve to canonical ids against
 * the mailbox's folders (id or display name, case-insensitive).
 */
async function prepareRule(db: AppDatabase, mailboxId: string, draft: RuleDraft, agent: boolean) {
	const name = draft.name.trim();
	if (!name || name.length > MAX_RULE_NAME_LENGTH) throw new RuleValidationError(`Rule name must be 1-${MAX_RULE_NAME_LENGTH} characters`);
	const match = normalizeRuleMatch(draft.match);
	if (!hasActiveConditions(match.conditions)) throw new RuleValidationError("A rule needs at least one match condition, or it never matches");
	const actions = normalizeRuleActions(draft.actions);
	if (!hasActiveActions(actions)) throw new RuleValidationError("A rule needs at least one action");
	if (agent) {
		if (actions.forward_to) throw new RuleValidationError("forward_to is operator-only: rules created through the agent or MCP tools cannot send mail");
		if (actions.auto_reply_text) throw new RuleValidationError("auto_reply_text is operator-only: rules created through the agent or MCP tools cannot send mail");
	}
	if (actions.move_to_folder) {
		const mailboxFolders = await db.select({ id: folders.id, name: folders.name }).from(folders).where(eq(folders.mailboxId, mailboxId));
		const resolved = resolveRuleFolderId(actions.move_to_folder, mailboxFolders);
		if (!resolved) throw new RuleValidationError(`Unknown folder: ${actions.move_to_folder}`);
		actions.move_to_folder = resolved;
	}
	if (actions.forward_to && !isRuleEmailAddress(actions.forward_to)) throw new RuleValidationError("forward_to must be a single email address");
	return { name, match, actions };
}

/** Create a rule; omitted priority appends after the last one. */
export async function createRule(db: AppDatabase, mailboxId: string, draft: RuleDraft, opts: { agent?: boolean } = {}): Promise<MailRule> {
	const { name, match, actions } = await prepareRule(db, mailboxId, draft, opts.agent === true);
	let priority = draft.priority;
	if (priority === undefined) {
		const [last] = await db.select({ priority: rules.priority }).from(rules).where(eq(rules.mailboxId, mailboxId)).orderBy(desc(rules.priority)).limit(1);
		priority = last ? Math.min(last.priority + 1, MAX_RULE_PRIORITY) : 0;
	}
	if (!Number.isInteger(priority) || priority < 0 || priority > MAX_RULE_PRIORITY) throw new RuleValidationError(`priority must be an integer between 0 and ${MAX_RULE_PRIORITY}`);
	const id = newId("rule");
	await db.insert(rules).values({
		id,
		mailboxId,
		name,
		enabled: draft.enabled !== false,
		priority,
		match: JSON.stringify(match),
		actions: JSON.stringify(actions),
	});
	const rule = await getRule(db, mailboxId, id);
	if (!rule) throw new Error("The rule was not saved");
	return rule;
}

/** Update a rule; omitted fields keep their stored value. Revalidates the merged rule. */
export async function updateRule(db: AppDatabase, mailboxId: string, ruleId: string, patch: RulePatch, opts: { agent?: boolean } = {}): Promise<MailRule> {
	const existing = await getRule(db, mailboxId, ruleId);
	if (!existing) throw new RuleValidationError("Rule not found");
	const merged: RuleDraft = {
		name: patch.name ?? existing.name,
		enabled: patch.enabled ?? existing.enabled,
		priority: patch.priority ?? existing.priority,
		match: patch.match ?? existing.match,
		actions: patch.actions ?? existing.actions,
	};
	const { name, match, actions } = await prepareRule(db, mailboxId, merged, opts.agent === true);
	const priority = merged.priority ?? existing.priority;
	if (!Number.isInteger(priority) || priority < 0 || priority > MAX_RULE_PRIORITY) throw new RuleValidationError(`priority must be an integer between 0 and ${MAX_RULE_PRIORITY}`);
	await db.update(rules).set({
		name,
		enabled: merged.enabled !== false,
		priority,
		match: JSON.stringify(match),
		actions: JSON.stringify(actions),
		updatedAt: new Date(),
	}).where(and(eq(rules.id, ruleId), eq(rules.mailboxId, mailboxId)));
	const rule = await getRule(db, mailboxId, ruleId);
	if (!rule) throw new Error("The rule was not saved");
	return rule;
}

export async function deleteRule(db: AppDatabase, mailboxId: string, ruleId: string): Promise<boolean> {
	const existing = await getRule(db, mailboxId, ruleId);
	if (!existing) return false;
	await db.delete(rules).where(and(eq(rules.id, ruleId), eq(rules.mailboxId, mailboxId)));
	return true;
}

/**
 * Rewrite priorities to follow `ruleIds` (first id evaluates first). Unknown
 * or repeated ids are ignored; rules missing from the list keep their relative
 * order after the listed ones.
 */
export async function reorderRules(db: AppDatabase, mailboxId: string, ruleIds: string[]): Promise<MailRule[]> {
	const current = await listRules(db, mailboxId);
	const byId = new Map(current.map((rule) => [rule.id, rule]));
	const ordered: MailRule[] = [];
	for (const id of ruleIds) {
		const rule = byId.get(id);
		if (rule && !ordered.includes(rule)) ordered.push(rule);
	}
	for (const rule of current) if (!ordered.includes(rule)) ordered.push(rule);
	for (let index = 0; index < ordered.length; index += 1) {
		if (ordered[index].priority !== index) {
			await db.update(rules).set({ priority: index, updatedAt: new Date() }).where(eq(rules.id, ordered[index].id));
		}
	}
	return listRules(db, mailboxId);
}

/** The stored messages a rule scan looks at: the newest RULE_PREVIEW_SCAN_LIMIT of the mailbox. */
async function scanWindow(db: AppDatabase, mailboxId: string) {
	const rows = await db
		.select({
			id: messages.id,
			fromAddr: messages.fromAddr,
			toAddr: messages.toAddr,
			ccAddr: messages.ccAddr,
			bccAddr: messages.bccAddr,
			subject: messages.subject,
			textBody: messages.textBody,
			htmlBody: messages.htmlBody,
			category: messages.category,
			folderId: messages.folderId,
			read: messages.read,
			starred: messages.starred,
			createdAt: messages.createdAt,
		})
		.from(messages)
		.where(eq(messages.mailboxId, mailboxId))
		.orderBy(desc(messages.createdAt), desc(messages.id))
		.limit(RULE_PREVIEW_SCAN_LIMIT);
	const withAttachment = new Set(
		rows.length
			? (await db.select({ messageId: messageAttachments.messageId }).from(messageAttachments).where(inArray(messageAttachments.messageId, rows.map((row) => row.id)))).map((row) => row.messageId)
			: [],
	);
	return rows.map((row) => ({
		row,
		email: {
			sender: row.fromAddr,
			recipient: row.toAddr,
			cc: row.ccAddr,
			bcc: row.bccAddr,
			subject: row.subject,
			body: row.textBody ?? row.htmlBody,
			category: row.category,
			has_attachment: withAttachment.has(row.id),
		} satisfies RuleEmail,
	}));
}

/** Dry-run a rule draft against stored mail; never writes anything. */
export async function previewRule(db: AppDatabase, mailboxId: string, draft: RulePreviewDraft): Promise<RulePreviewResult> {
	const match = normalizeRuleMatch(draft.match);
	const probe: MailRule = { id: "preview", name: draft.name ?? "", enabled: true, priority: 0, match, actions: {}, created_at: "" };
	const window = await scanWindow(db, mailboxId);
	const matches: RulePreviewMatch[] = [];
	let total = 0;
	for (const { row, email } of window) {
		if (!matchRule(probe, email)) continue;
		total += 1;
		if (matches.length < RULE_PREVIEW_MAX_MATCHES) {
			matches.push({ id: row.id, subject: row.subject ?? "", sender: row.fromAddr, date: row.createdAt.toISOString(), folder_id: row.folderId ?? "" });
		}
	}
	return { total, scanned: window.length, scan_limit: RULE_PREVIEW_SCAN_LIMIT, limit: RULE_PREVIEW_MAX_MATCHES, matches };
}

/**
 * Retroactively apply a stored rule's LOCAL actions to the newest scan window.
 * Never sends, never deletes, never records a firing; idempotent — messages
 * already in the target state are skipped. Loop while remaining > 0.
 */
export async function applyRule(db: AppDatabase, mailboxId: string, ruleId: string, limit = RULE_APPLY_LIMIT_DEFAULT): Promise<RuleApplyResult> {
	const rule = await getRule(db, mailboxId, ruleId);
	if (!rule) throw new RuleValidationError("Rule not found");
	const local = localRuleActions(rule.actions);
	if (!hasLocalRuleActions(rule.actions)) throw new RuleValidationError("This rule has no actions that can be applied to existing mail");
	const batch = Math.max(1, Math.min(Math.floor(limit), RULE_APPLY_LIMIT_MAX));
	const window = await scanWindow(db, mailboxId);
	let applied = 0;
	let skipped = 0;
	let matched = 0;
	let remaining = 0;
	for (const { row, email } of window) {
		if (!matchRule(rule, email)) continue;
		matched += 1;
		const needsChange = ruleNeedsChange({ folder_id: row.folderId, category: row.category, read: row.read, starred: row.starred }, local);
		if (!needsChange) {
			skipped += 1;
			continue;
		}
		if (applied >= batch) {
			remaining += 1;
			continue;
		}
		await db.update(messages).set({
			...(local.folder !== undefined ? { folderId: local.folder } : {}),
			...(local.category !== undefined ? { category: local.category } : {}),
			...(local.read !== undefined ? { read: local.read } : {}),
			...(local.starred !== undefined ? { starred: local.starred } : {}),
		}).where(eq(messages.id, row.id));
		applied += 1;
	}
	return { rule_id: ruleId, applied, skipped, matched, remaining, scanned: window.length, scan_limit: RULE_PREVIEW_SCAN_LIMIT };
}

/** Count firings after the inbound pipeline ran the rules (never on preview/apply). */
export async function recordRuleFirings(db: AppDatabase, mailboxId: string, ruleIds: string[]): Promise<void> {
	if (ruleIds.length === 0) return;
	const now = new Date();
	for (const id of ruleIds) {
		const [row] = await db.select({ firedCount: rules.firedCount }).from(rules).where(and(eq(rules.id, id), eq(rules.mailboxId, mailboxId))).limit(1);
		if (!row) continue;
		await db.update(rules).set({ firedCount: row.firedCount + 1, lastFiredAt: now }).where(eq(rules.id, id));
	}
}

/**
 * Run the mailbox's enabled rules over an inbound email and apply the local
 * mutation. The caller handles `discarded` (drop before storing) and
 * `outbound` (forward/auto-reply after its own guards).
 */
export async function runInboundRules(db: AppDatabase, mailboxId: string, email: RuleEmail): Promise<RuleRunResult> {
	const stored = await listRules(db, mailboxId);
	const result = runRules(stored, email);
	if (result.appliedRuleIds.length > 0) await recordRuleFirings(db, mailboxId, result.appliedRuleIds);
	return result;
}