import { and, eq } from "drizzle-orm";
import type { AppDatabase } from "@/db";
import { calendarEvents, messages } from "@/db/schema";
import { buildReplyIcs, parseInvite, type InviteResponse } from "@/lib/calendar/invite";
import { findInviteAttachment, MAX_INVITE_BYTES } from "@/lib/calendar/invite-attachment";
import { addExcludedOccurrence, normalizeInviteSender, planInviteAnswer } from "@/lib/calendar/invite-rules";
import { inviteEventId, inviteEventValues, recipientInviteTimeZone, sameInviteSender } from "@/lib/calendar/invite-store";
import { getEmailAddress, splitEmailAddressList } from "@/lib/email/address";
import { getAttachmentForUser, listMessageAttachments } from "@/lib/email/attachments";
import { sendEmail } from "@/lib/email/send";
import type { SessionUser } from "@/lib/auth/types";

/**
 * Answer one calendar invitation (iMIP REPLY), extracted from the invite
 * route so the MCP facade and the HTTP surface share one implementation.
 * Sends mail to the organizer — callers must have operator authorization.
 */
export async function answerInvite(
	env: CloudflareEnv,
	db: AppDatabase,
	user: SessionUser,
	messageId: string,
	response: InviteResponse,
	sendReply = true,
): Promise<{ ok: true; eventId: string | null; replySent: boolean } | { ok: false; error: string; status: number }> {
	const userZone = (await recipientInviteTimeZone(db, user.id)) ?? "UTC";
	const attachments = await listMessageAttachments(env, messageId);
	const candidate = findInviteAttachment(attachments);
	if (!candidate || candidate.size > MAX_INVITE_BYTES) return { ok: false, error: "This message has no readable invitation", status: 404 };
	const attachment = await getAttachmentForUser(env, user, messageId, candidate.id);
	if (!attachment) return { ok: false, error: "This message has no readable invitation", status: 404 };
	let invite;
	try {
		invite = parseInvite(await attachment.object.text(), { timeZone: userZone });
	} catch {
		return { ok: false, error: "This invitation could not be read", status: 422 };
	}
	if (!invite) return { ok: false, error: "This invitation could not be read", status: 422 };
	if (invite.method !== "REQUEST" && invite.method !== "CANCEL" && invite.method !== "PUBLISH") return { ok: false, error: "This message is a reply, not an invitation", status: 400 };
	const [message] = await db.select().from(messages).where(eq(messages.id, messageId)).limit(1);
	if (!message) return { ok: false, error: "Message not found", status: 404 };

	const id = await inviteEventId(user.id, invite.uid);
	const where = and(eq(calendarEvents.id, id), eq(calendarEvents.userId, user.id));
	const [existing] = await db.select().from(calendarEvents).where(where).limit(1);
	const sender = normalizeInviteSender(message.fromAddr);
	if (existing && !sameInviteSender(existing, sender)) return { ok: false, error: "This invitation does not come from the sender of the existing event", status: 409 };
	const plan = planInviteAnswer(invite, response, existing);
	let eventId: string | null = null;
	if (plan.action === "delete") {
		await db.delete(calendarEvents).where(where);
	} else if (plan.action === "exclude" && existing) {
		await db.update(calendarEvents).set({ excludedOccurrences: addExcludedOccurrence(existing.excludedOccurrences, plan.occurrence), inviteSender: existing.inviteSender || sender, updatedAt: new Date() }).where(where);
		eventId = existing.id;
	} else if (plan.action === "none") {
		eventId = existing?.id ?? null;
	} else if (plan.action === "status" && existing) {
		await db.update(calendarEvents).set({ responseStatus: response, inviteSender: existing.inviteSender || sender, timeZone: existing.timeZone ?? userZone, updatedAt: new Date() }).where(where);
		eventId = existing.id;
	} else {
		const values = {
			...inviteEventValues(invite, invite.timeZone ?? userZone, existing?.excludedOccurrences),
			responseStatus: response, inviteMessageId: messageId, inviteSender: sender,
		};
		await db.insert(calendarEvents).values({ id, userId: user.id, mailboxId: message.mailboxId, color: response === "tentative" ? "#7c3aed" : "#2563eb", ...values }).onConflictDoUpdate({ target: calendarEvents.id, set: values });
		eventId = id;
	}

	await db.update(messages).set({ inviteResponse: response }).where(eq(messages.id, messageId));

	let replySent = false;
	const SINGLE_ADDRESS = /^[^\s@<>",;()\\]+@[^\s@<>",;()\\]+$/;
	const replySender = getEmailAddress(message.replyTo || message.fromAddr).trim().toLowerCase();
	const organizer = invite.organizer?.trim().toLowerCase() ?? "";
	const domainOf = (address: string) => address.slice(address.indexOf("@") + 1);
	const replyTo = SINGLE_ADDRESS.test(organizer) && SINGLE_ADDRESS.test(replySender) && domainOf(organizer) === domainOf(replySender) ? organizer : replySender;
	if (!SINGLE_ADDRESS.test(replyTo)) return { ok: true, eventId, replySent: false };
	if (sendReply && invite.method === "REQUEST" && message.mailboxId && replyTo) {
		const candidates = [...splitEmailAddressList(message.toAddr), ...splitEmailAddressList(message.ccAddr ?? "")].map(getEmailAddress).filter(Boolean);
		const verb = { accepted: "Accepted", tentative: "Tentatively accepted", declined: "Declined" }[response];
		const subject = `${verb}: ${invite.title}`.replace(/\s+/g, " ").trim();
		for (const from of candidates) {
			try {
				await sendEmail(env, {
					userId: user.id, mailboxId: message.mailboxId, from, to: [replyTo],
					subject, text: `${from} ${verb.toLowerCase()}: ${invite.title}`,
					inReplyTo: message.providerMessageId, threadId: message.threadId,
					attachments: [{ filename: "reply.ics", type: "text/calendar; method=REPLY; charset=utf-8", content: new TextEncoder().encode(buildReplyIcs(invite, from, response)).buffer as ArrayBuffer }],
				});
				replySent = true;
				break;
			} catch {
				// Try the next candidate identity; a failed reply never fails the answer.
			}
		}
	}
	return { ok: true, eventId, replySent };
}