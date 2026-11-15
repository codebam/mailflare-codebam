import { and, eq, inArray, sql } from "drizzle-orm";
import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { getDb } from "@/db";
import { domains, folders, followUps, mailboxes, messageAttachments, messages, outboundJobs } from "@/db/schema";
import { newId } from "@/lib/ids";
import { sendEmail } from "@/lib/email/send";
import { runEmailTool } from "@/lib/agent/tools";
import { getUnsubscribeUrlFromRawR2Key } from "@/lib/email/unsubscribe";
import { parseRemoteImageUrl } from "@/lib/remote-images/fetch";
import { answerInvite } from "@/lib/calendar/invite-answer";
import { cleanDraftBody } from "@/lib/ai/verify-draft";
import { recordAction } from "@/lib/agent-actions/service";
import { audit, compatDb, denied, errorMessage, ownMessage, output, parseWhen, recordMutation, resolveFolder, threadKeyOf, type CompatDb } from "./compat-shared";
import type { McpPrincipal } from "./types";

const MAX_SEND_ATTACHMENTS = 5;
const MAX_SEND_ATTACHMENT_BYTES = 5 * 1024 * 1024;

type SendAttachment = { filename: string; mimetype: string; content_base64: string };

function decodeAttachments(attachments: SendAttachment[] | undefined) {
	if (!attachments?.length) return [];
	if (attachments.length > MAX_SEND_ATTACHMENTS) throw new Error(`At most ${MAX_SEND_ATTACHMENTS} attachments`);
	const decoded = attachments.map((attachment) => {
		const bytes = Uint8Array.from(atob(attachment.content_base64), (char) => char.charCodeAt(0));
		return { filename: attachment.filename, type: attachment.mimetype, content: bytes.buffer as ArrayBuffer };
	});
	const total = decoded.reduce((sum, attachment) => sum + attachment.content.byteLength, 0);
	if (total > MAX_SEND_ATTACHMENT_BYTES) throw new Error("Attachments exceed 5 MB in total");
	return decoded;
}

async function mailboxAddress(db: CompatDb, mailboxId: string): Promise<string> {
	const [mailbox] = await db.select({ localPart: mailboxes.localPart, hostname: domains.hostname }).from(mailboxes).innerJoin(domains, eq(mailboxes.domainId, domains.id)).where(eq(mailboxes.id, mailboxId)).limit(1);
	if (!mailbox) throw new Error("Mailbox not found");
	return `${mailbox.localPart}@${mailbox.hostname}`;
}

/** Delete stored blobs for messages being permanently removed; best-effort. */
async function deleteMessageBlobs(env: CloudflareEnv, db: CompatDb, messageIds: string[]) {
	if (messageIds.length === 0) return;
	const rows = await db.select({ id: messages.id, rawR2Key: messages.rawR2Key }).from(messages).where(inArray(messages.id, messageIds));
	const attachments = await db.select({ r2Key: messageAttachments.r2Key }).from(messageAttachments).where(inArray(messageAttachments.messageId, messageIds));
	for (const key of [...rows.map((row) => row.rawR2Key), ...attachments.map((row) => row.r2Key)]) {
		if (!key) continue;
		try { await env.BUCKET.delete(key); } catch { /* blob cleanup is best-effort */ }
	}
}

/**
 * Action-side facade: drafts, operator-confirmed sends, and mail management
 * under the agentic-inbox tool names. Mutating calls land in the action log
 * so undo_action can restore folder/read/star state.
 */
export function registerCompatActionTools(server: McpServer, principal: McpPrincipal, env: CloudflareEnv) {
	const guard = async (mailboxId: string, scope: string, tool: string, run: (db: CompatDb) => Promise<unknown>) => {
		if (!principal.scopes.includes(scope)) return denied();
		const db = await compatDb(env, principal, mailboxId, scope !== "mcp:read");
		if (!db) return denied();
		audit(principal, tool, mailboxId);
		try { return output(await run(db)); }
		catch (error) { return output({ error: errorMessage(error, "Tool failed") }, true); }
	};
	const agentContext = (mailboxId: string) => ({ env, user: principal.user, mailboxId, origin: "mcp" as const });

	// ---- Drafts ----
	server.registerTool("create_draft", { description: "Create a new draft email, or a reply draft when in_reply_to names an email. Saves to Drafts; never sends.", inputSchema: z.object({ mailboxId: z.string(), to: z.string().optional(), subject: z.string(), bodyHtml: z.string(), in_reply_to: z.string().optional(), thread_id: z.string().optional() }), annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false } }, async ({ mailboxId, to, subject, bodyHtml, in_reply_to, thread_id }) =>
		guard(mailboxId, "mcp:draft", "create_draft", async (db) => {
			const body = await cleanDraftBody(env, bodyHtml);
			const result = in_reply_to
				? await runEmailTool(agentContext(mailboxId), "draft_reply", { emailId: in_reply_to, body, replyAll: false })
				: await runEmailTool(agentContext(mailboxId), "draft_email", { to: to ?? "", subject, body });
			const draftId = (result as { draftId: string }).draftId;
			if (thread_id || (to && in_reply_to)) {
				await db.update(messages).set({ ...(thread_id ? { threadId: thread_id } : {}), ...(to && in_reply_to ? { toAddr: to } : {}) }).where(eq(messages.id, draftId));
			}
			if (!in_reply_to && subject) await db.update(messages).set({ subject }).where(eq(messages.id, draftId));
			return result;
		}));

	server.registerTool("draft_reply", { description: "Draft a reply to an email and save it to the Drafts folder. Does NOT send — saves a draft for review.", inputSchema: z.object({ mailboxId: z.string(), originalEmailId: z.string(), to: z.string().optional(), subject: z.string().optional(), bodyHtml: z.string() }), annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false } }, async ({ mailboxId, originalEmailId, to, subject, bodyHtml }) =>
		guard(mailboxId, "mcp:draft", "draft_reply", async (db) => {
			const body = await cleanDraftBody(env, bodyHtml);
			const result = await runEmailTool(agentContext(mailboxId), "draft_reply", { emailId: originalEmailId, body, replyAll: false });
			const draftId = (result as { draftId: string }).draftId;
			if (to || subject) await db.update(messages).set({ ...(to ? { toAddr: to } : {}), ...(subject ? { subject } : {}) }).where(eq(messages.id, draftId));
			return result;
		}));

	server.registerTool("update_draft", { description: "Update an existing draft email's recipient, subject or body. Never sends.", inputSchema: z.object({ mailboxId: z.string(), draftId: z.string(), to: z.string().optional(), subject: z.string().optional(), bodyHtml: z.string().optional() }), annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false } }, async ({ mailboxId, draftId, to, subject, bodyHtml }) =>
		guard(mailboxId, "mcp:draft", "update_draft", async (db) => {
			const row = await ownMessage(db, mailboxId, draftId);
			if (row.status !== "draft") throw new Error("Draft not found");
			const cleanedBody = bodyHtml !== undefined ? await cleanDraftBody(env, bodyHtml) : undefined;
			await db.update(messages).set({
				...(to !== undefined ? { toAddr: to } : {}),
				...(subject !== undefined ? { subject } : {}),
				...(cleanedBody !== undefined ? { htmlBody: cleanedBody, textBody: cleanedBody.replace(/<[^>]+>/g, " ") } : {}),
			}).where(eq(messages.id, draftId));
			return { draftId, status: "updated" };
		}));

	server.registerTool("discard_draft", { description: "Permanently delete a draft email — drafts are not moved to Trash and cannot be restored.", inputSchema: z.object({ mailboxId: z.string(), draftId: z.string() }), annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false } }, async ({ mailboxId, draftId }) =>
		guard(mailboxId, "mcp:draft", "discard_draft", async (db) => {
			const row = await ownMessage(db, mailboxId, draftId);
			if (row.status !== "draft") throw new Error("Draft not found");
			await deleteMessageBlobs(env, db, [draftId]);
			await db.delete(messages).where(eq(messages.id, draftId));
			return { deleted: true };
		}));

	// ---- Sends (operator-confirmed; the harness convention gates these) ----
	server.registerTool("send_email", { description: "Send a new email (not a reply), optionally with cc, bcc and inline attachments (up to 5 files, 5 MB total). Only call after the human operator has explicitly confirmed the exact recipient, subject and body.", inputSchema: z.object({ mailboxId: z.string(), to: z.string(), subject: z.string(), bodyHtml: z.string(), cc: z.union([z.string(), z.array(z.string())]).optional(), bcc: z.union([z.string(), z.array(z.string())]).optional(), attachments: z.array(z.object({ filename: z.string(), mimetype: z.string(), content_base64: z.string() })).optional() }), annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true } }, async ({ mailboxId, to, subject, bodyHtml, cc, bcc, attachments }) =>
		guard(mailboxId, "mcp:send", "send_email", async (db) => {
			const from = await mailboxAddress(db, mailboxId);
			const result = await sendEmail(env, { userId: principal.user.id, mailboxId, from, to, cc, bcc, subject, html: bodyHtml, attachments: decodeAttachments(attachments) });
			return { messageId: result.messageId, status: result.scheduled ? "scheduled" : "sent" };
		}));

	server.registerTool("send_reply", { description: "Send a reply to an email, keeping the thread. Only call after the human operator has explicitly confirmed the exact recipient, subject and body.", inputSchema: z.object({ mailboxId: z.string(), originalEmailId: z.string(), to: z.string(), subject: z.string(), bodyHtml: z.string() }), annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true } }, async ({ mailboxId, originalEmailId, to, subject, bodyHtml }) =>
		guard(mailboxId, "mcp:send", "send_reply", async (db) => {
			const original = await ownMessage(db, mailboxId, originalEmailId);
			const from = await mailboxAddress(db, mailboxId);
			const references = [original.references, original.providerMessageId].filter(Boolean).join(" ");
			const result = await sendEmail(env, { userId: principal.user.id, mailboxId, from, to, subject, html: bodyHtml, inReplyTo: original.providerMessageId, references: references || null, threadId: original.threadId });
			return { messageId: result.messageId, status: result.scheduled ? "scheduled" : "sent" };
		}));

	server.registerTool("schedule_send", { description: "Queue a new email for delivery at a future time (ISO 8601). It can be cancelled before then. Only call after the operator has confirmed the exact recipient, subject, body and send time.", inputSchema: z.object({ mailboxId: z.string(), to: z.string(), subject: z.string(), bodyHtml: z.string(), sendAt: z.string(), cc: z.union([z.string(), z.array(z.string())]).optional(), bcc: z.union([z.string(), z.array(z.string())]).optional() }), annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true } }, async ({ mailboxId, to, subject, bodyHtml, sendAt, cc, bcc }) =>
		guard(mailboxId, "mcp:send", "schedule_send", async (db) => {
			const when = new Date(sendAt);
			if (Number.isNaN(when.getTime()) || when.getTime() <= Date.now()) throw new Error("sendAt must be a future ISO 8601 instant");
			const from = await mailboxAddress(db, mailboxId);
			const result = await sendEmail(env, { userId: principal.user.id, mailboxId, from, to, cc, bcc, subject, html: bodyHtml, scheduledAt: when });
			return { id: result.messageId, status: "pending", sendAt: when.toISOString() };
		}));

	server.registerTool("retry_scheduled_send", { description: "Re-arm a failed scheduled send: it becomes pending and due immediately. Only a failed send can be retried; nothing is deleted.", inputSchema: z.object({ mailboxId: z.string(), scheduledSendId: z.string() }), annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false } }, async ({ mailboxId, scheduledSendId }) =>
		guard(mailboxId, "mcp:send", "retry_scheduled_send", async (db) => {
			const [job] = await db.select().from(outboundJobs).where(and(eq(outboundJobs.messageId, scheduledSendId), eq(outboundJobs.userId, principal.user.id))).limit(1);
			if (!job || job.status !== "failed") throw new Error("No failed scheduled send with that id");
			await db.update(outboundJobs).set({ status: "queued", scheduledAt: new Date(), error: null, updatedAt: new Date() }).where(eq(outboundJobs.id, job.id));
			return { id: scheduledSendId, status: "pending" };
		}));

	server.registerTool("unsubscribe_email", { description: "One-click unsubscribe (RFC 8058) for a mailing-list message, fetched through the SSRF guard. Only call on an explicit operator click. Spam is never unsubscribed.", inputSchema: z.object({ mailboxId: z.string(), emailId: z.string() }), annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true } }, async ({ mailboxId, emailId }) =>
		guard(mailboxId, "mcp:send", "unsubscribe_email", async (db) => {
			const row = await ownMessage(db, mailboxId, emailId);
			if (row.status === "spam") throw new Error("This message can't be unsubscribed");
			const candidate = await getUnsubscribeUrlFromRawR2Key(env, row.rawR2Key);
			const url = candidate?.url ?? null;
			if (url?.startsWith("https://") && candidate?.oneClick && candidate.dkimCoversUnsubscribe) {
				try {
					parseRemoteImageUrl(url);
					const response = await fetch(url, { method: "POST", body: "List-Unsubscribe=One-Click", headers: { "Content-Type": "application/x-www-form-urlencoded" }, signal: AbortSignal.timeout(10_000), redirect: "manual" });
					if (response.ok || (response.status >= 300 && response.status < 400)) return { ok: true, method: "one-click" };
				} catch { /* fall through to manual */ }
			}
			return { ok: false, method: "manual", url: url ?? candidate?.mailto ?? null };
		}));

	// ---- Management ----
	server.registerTool("star_email", { description: "Star or unstar an email.", inputSchema: z.object({ mailboxId: z.string(), emailId: z.string(), starred: z.boolean() }), annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false } }, async ({ mailboxId, emailId, starred }) =>
		guard(mailboxId, "mcp:organize", "star_email", async (db) => {
			const row = await ownMessage(db, mailboxId, emailId);
			await db.update(messages).set({ starred }).where(eq(messages.id, emailId));
			await recordMutation(db, mailboxId, "star_email", row, { starred }, true);
			return { emailId, starred };
		}));

	server.registerTool("mark_email_read", { description: "Mark an email as read or unread.", inputSchema: z.object({ mailboxId: z.string(), emailId: z.string(), read: z.boolean() }), annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false } }, async ({ mailboxId, emailId, read }) =>
		guard(mailboxId, "mcp:organize", "mark_email_read", async (db) => {
			const row = await ownMessage(db, mailboxId, emailId);
			await db.update(messages).set({ read }).where(eq(messages.id, emailId));
			await recordMutation(db, mailboxId, "mark_email_read", row, { read }, true);
			return { emailId, read };
		}));

	server.registerTool("move_email", { description: "Move an email to a different folder: inbox, archive, spam, trash, or a user folder id/name.", inputSchema: z.object({ mailboxId: z.string(), emailId: z.string(), folderId: z.string() }), annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false } }, async ({ mailboxId, emailId, folderId }) =>
		guard(mailboxId, "mcp:organize", "move_email", async (db) => {
			const row = await ownMessage(db, mailboxId, emailId);
			if (row.status === "draft" || row.status === "sent") throw new Error("Cannot move this message");
			const system: Record<string, string> = { inbox: "received", archive: "archived", spam: "spam", trash: "trash" };
			if (system[folderId]) {
				await db.update(messages).set({ status: system[folderId], folderId: null }).where(eq(messages.id, emailId));
				await recordMutation(db, mailboxId, "move_email", row, { folderId: null }, true);
			} else {
				const target = await resolveFolder(db, mailboxId, folderId);
				if (!target) throw new Error(`Unknown folder: ${folderId}`);
				await db.update(messages).set({ folderId: target, status: "received" }).where(eq(messages.id, emailId));
				await recordMutation(db, mailboxId, "move_email", row, { folderId: target }, true);
			}
			return { emailId, folderId };
		}));

	server.registerTool("delete_email", { description: "Delete an email by id. By default it moves to Trash and can be restored; permanent=true removes it for good and requires confirm=true. Only pass permanent after the operator explicitly asks to delete forever.", inputSchema: z.object({ mailboxId: z.string(), emailId: z.string(), permanent: z.boolean().optional(), confirm: z.boolean().optional() }), annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false } }, async ({ mailboxId, emailId, permanent, confirm }) =>
		guard(mailboxId, "mcp:organize", "delete_email", async (db) => {
			const row = await ownMessage(db, mailboxId, emailId);
			if (permanent) {
				if (confirm !== true) throw new Error("Permanent deletion requires confirm=true");
				await deleteMessageBlobs(env, db, [emailId]);
				await db.delete(messages).where(eq(messages.id, emailId));
				await recordAction(db, mailboxId, { tool: "delete_email", messageId: emailId, subject: row.subject, threadKey: threadKeyOf(row), undoable: false });
				return { emailId, deleted: true, permanent: true };
			}
			await db.update(messages).set({ status: "trash" }).where(eq(messages.id, emailId));
			await recordMutation(db, mailboxId, "delete_email", row, { folderId: null }, false);
			return { emailId, deleted: true, permanent: false };
		}));

	server.registerTool("restore_email", { description: "Move a trashed email back to the Inbox. Only a message in Trash can be restored.", inputSchema: z.object({ mailboxId: z.string(), emailId: z.string() }), annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false } }, async ({ mailboxId, emailId }) =>
		guard(mailboxId, "mcp:organize", "restore_email", async (db) => {
			const row = await ownMessage(db, mailboxId, emailId);
			if (row.status !== "trash") throw new Error("Only a message in Trash can be restored");
			await db.update(messages).set({ status: "received", folderId: null }).where(eq(messages.id, emailId));
			await recordMutation(db, mailboxId, "restore_email", row, { folderId: null }, false);
			return { emailId, restored: true };
		}));

	const purgeFolder = (tool: string, status: string, description: string) => {
		server.registerTool(tool, { description, inputSchema: z.object({ mailboxId: z.string(), confirm: z.boolean() }), annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false } }, async ({ mailboxId, confirm }) =>
			guard(mailboxId, "mcp:organize", tool, async (db) => {
				if (confirm !== true) throw new Error("This permanently deletes mail and requires confirm=true");
				const rows = await db.select({ id: messages.id }).from(messages).where(and(eq(messages.mailboxId, mailboxId), eq(messages.status, status)));
				const ids = rows.map((row) => row.id);
				await deleteMessageBlobs(env, db, ids);
				if (ids.length) await db.delete(messages).where(inArray(messages.id, ids));
				return { deleted: ids.length };
			}));
	};
	purgeFolder("empty_trash", "trash", "Permanently delete every email in the Trash folder, including attachments. Irreversible. Only call when the operator explicitly asks to empty the Trash, with confirm=true.");
	purgeFolder("delete_spam_emails", "spam", "Permanently delete every email marked as spam in this mailbox. Irreversible. Only call when the operator explicitly asks to delete spam, with confirm=true.");

	server.registerTool("mark_thread_read", { description: "Mark every message in a thread as read. Nothing is deleted.", inputSchema: z.object({ mailboxId: z.string(), threadId: z.string() }), annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false } }, async ({ mailboxId, threadId }) =>
		guard(mailboxId, "mcp:organize", "mark_thread_read", async (db) => {
			const [anchor] = await db.select().from(messages).where(and(eq(messages.mailboxId, mailboxId), sql`(${messages.threadId} = ${threadId} OR ${messages.id} = ${threadId})`)).limit(1);
			if (!anchor) throw new Error("Thread not found");
			const key = threadKeyOf(anchor);
			await db.update(messages).set({ read: true }).where(and(eq(messages.mailboxId, mailboxId), sql`(${messages.threadId} = ${key} OR ${messages.id} = ${key})`));
			return { threadId: key, read: true };
		}));

	server.registerTool("snooze_email", { description: "Snooze an email until a future time: ISO 8601 or a relative shorthand like 30m, 4h, 3d, 1w. It returns to its folder when the time arrives.", inputSchema: z.object({ mailboxId: z.string(), emailId: z.string(), until: z.string() }), annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false } }, async ({ mailboxId, emailId, until }) =>
		guard(mailboxId, "mcp:organize", "snooze_email", async (db) => {
			const row = await ownMessage(db, mailboxId, emailId);
			const when = parseWhen(until);
			if (!when || when.getTime() <= Date.now()) throw new Error("until must be a future time");
			await db.update(messages).set({ snoozedUntil: when }).where(eq(messages.id, emailId));
			await recordAction(db, mailboxId, { tool: "snooze_email", messageId: row.id, subject: row.subject, threadKey: threadKeyOf(row), undoable: false });
			return { emailId, snoozedUntil: when.toISOString() };
		}));

	server.registerTool("unsnooze_email", { description: "Wake a snoozed email now: it returns to the folder it came from immediately.", inputSchema: z.object({ mailboxId: z.string(), emailId: z.string() }), annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false } }, async ({ mailboxId, emailId }) =>
		guard(mailboxId, "mcp:organize", "unsnooze_email", async (db) => {
			const row = await ownMessage(db, mailboxId, emailId);
			if (!row.snoozedUntil) throw new Error("Email is not snoozed");
			await db.update(messages).set({ snoozedUntil: null }).where(eq(messages.id, emailId));
			return { emailId, awake: true };
		}));

	server.registerTool("set_reminder", { description: "Set a follow-up reminder for an email: ISO 8601 or a relative shorthand like 30m, 4h, 3d, 1w. Nothing is deleted.", inputSchema: z.object({ mailboxId: z.string(), emailId: z.string(), at: z.string() }), annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false } }, async ({ mailboxId, emailId, at }) =>
		guard(mailboxId, "mcp:organize", "set_reminder", async (db) => {
			const row = await ownMessage(db, mailboxId, emailId);
			const when = parseWhen(at);
			if (!when || when.getTime() <= Date.now()) throw new Error("at must be a future time");
			const [existing] = await db.select({ id: followUps.id }).from(followUps).where(eq(followUps.messageId, emailId)).limit(1);
			if (existing) await db.update(followUps).set({ dueAt: when, status: "pending" }).where(eq(followUps.id, existing.id));
			else await db.insert(followUps).values({ id: newId("fup"), messageId: emailId, userId: principal.user.id, dueAt: when, status: "pending" });
			return { emailId, reminderAt: when.toISOString() };
		}));

	server.registerTool("clear_reminder", { description: "Cancel an email's follow-up reminder, pending or already fired. Nothing is deleted.", inputSchema: z.object({ mailboxId: z.string(), emailId: z.string() }), annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false } }, async ({ mailboxId, emailId }) =>
		guard(mailboxId, "mcp:organize", "clear_reminder", async (db) => {
			await ownMessage(db, mailboxId, emailId);
			await db.delete(followUps).where(eq(followUps.messageId, emailId));
			return { emailId, cleared: true };
		}));

	server.registerTool("create_folder", { description: "Create a user folder. A colliding name answers an error. Nothing is moved.", inputSchema: z.object({ mailboxId: z.string(), name: z.string().min(1).max(100) }), annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false } }, async ({ mailboxId, name }) =>
		guard(mailboxId, "mcp:organize", "create_folder", async (db) => {
			const [existing] = await db.select({ id: folders.id }).from(folders).where(and(eq(folders.mailboxId, mailboxId), sql`lower(${folders.name}) = ${name.trim().toLowerCase()}`)).limit(1);
			if (existing) throw new Error("A folder with that name already exists");
			const id = newId("fld");
			await db.insert(folders).values({ id, userId: principal.user.id, mailboxId, name: name.trim() });
			return { id, name: name.trim() };
		}));

	server.registerTool("update_folder", { description: "Rename a folder by id. The id never changes; an unknown id answers an error. Nothing is moved.", inputSchema: z.object({ mailboxId: z.string(), folderId: z.string(), name: z.string().min(1).max(100) }), annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false } }, async ({ mailboxId, folderId, name }) =>
		guard(mailboxId, "mcp:organize", "update_folder", async (db) => {
			const [folder] = await db.select().from(folders).where(and(eq(folders.id, folderId), eq(folders.mailboxId, mailboxId))).limit(1);
			if (!folder) throw new Error("Folder not found");
			await db.update(folders).set({ name: name.trim() }).where(eq(folders.id, folderId));
			return { id: folderId, name: name.trim() };
		}));

	server.registerTool("delete_folder", { description: "Delete a user folder by id. System folders cannot be deleted. Messages in the folder return to the Inbox; nothing is deleted.", inputSchema: z.object({ mailboxId: z.string(), folderId: z.string() }), annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false } }, async ({ mailboxId, folderId }) =>
		guard(mailboxId, "mcp:organize", "delete_folder", async (db) => {
			const [folder] = await db.select().from(folders).where(and(eq(folders.id, folderId), eq(folders.mailboxId, mailboxId))).limit(1);
			if (!folder) throw new Error("Folder not found");
			await db.delete(folders).where(eq(folders.id, folderId));
			return { deleted: true };
		}));

	server.registerTool("respond_to_invite", { description: "Answer one calendar invitation as an iMIP REPLY to the organizer: accepted, declined or tentative. Sends mail to the organizer — only call when the operator asks to answer the invitation.", inputSchema: z.object({ mailboxId: z.string(), emailId: z.string(), response: z.enum(["accepted", "declined", "tentative"]) }), annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true } }, async ({ mailboxId, emailId, response }) =>
		guard(mailboxId, "mcp:organize", "respond_to_invite", async (db) => {
			await ownMessage(db, mailboxId, emailId);
			const result = await answerInvite(env, db, principal.user, emailId, response);
			if (!result.ok) throw new Error(result.error);
			return { emailId, response, eventId: result.eventId, replySent: result.replySent };
		}));
}