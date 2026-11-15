import { and, count, eq, gte } from "drizzle-orm";
import type { AppDatabase } from "@/db";
import { ruleOutboundLog } from "@/db/schema";
import { sendEmail } from "@/lib/email/send";
import { newId } from "@/lib/ids";
import { isRuleEmailAddress, type RuleOutboundAction } from "./engine";

/**
 * Outbound rule actions (forward_to / auto_reply_text), ported from
 * agentic-inbox's rule-outbound. runRules only reports the work; this module
 * decides whether it may happen and performs the send. Guard rails live here
 * so no caller can forget them:
 *   - never for spam or discarded mail (the pipeline passes skip),
 *   - auto-replies suppressed for machine-generated mail, self-sent mail,
 *     and when this mailbox already auto-replied to that sender within 24h;
 *     forwards get the mirror per-sender 24h guard,
 *   - a mailbox send quota (20/hour, 100/day) over rule-driven sends,
 *   - operator-authored content is sent verbatim (no AI rewriting).
 */

export type RuleOutboundContext = {
	mailboxId: string;
	userId: string;
	/** The mailbox's own address, used as the envelope sender. */
	mailboxAddress: string;
	/** Lower-cased bare address the inbound message came from. */
	sender: string;
	subject: string;
	text?: string | null;
	html?: string | null;
	headers?: Record<string, string>;
};

export type RuleOutboundReport = {
	kind: RuleOutboundAction["kind"];
	ruleId: string;
	status: "sent" | "skipped" | "failed";
	reason?: string;
	to?: string;
};

/** Anything that can deliver one message; tests inject a fake. */
export type RuleOutboundSender = (input: {
	userId: string;
	from: string;
	to: string;
	subject: string;
	text?: string;
	html?: string;
	mailboxId: string;
}) => Promise<{ messageId: string }>;

/** Auto-Submitted (other than "no"), List-Id, or bulk/junk/list Precedence. */
export function isMachineGenerated(headers: Record<string, string> | undefined): boolean {
	if (!headers) return false;
	const lower: Record<string, string> = {};
	for (const [key, value] of Object.entries(headers)) lower[key.toLowerCase()] = value;
	const autoSubmitted = lower["auto-submitted"];
	if (autoSubmitted && !/^no\b/i.test(autoSubmitted.trim())) return true;
	if (lower["list-id"]) return true;
	const precedence = (lower["precedence"] ?? "").trim().toLowerCase();
	return precedence === "bulk" || precedence === "junk" || precedence === "list";
}

async function sentRecently(db: AppDatabase, mailboxId: string, kind: "forward" | "auto_reply", sender: string, withinMs: number): Promise<boolean> {
	const [row] = await db
		.select({ value: count() })
		.from(ruleOutboundLog)
		.where(and(eq(ruleOutboundLog.mailboxId, mailboxId), eq(ruleOutboundLog.kind, kind), eq(ruleOutboundLog.sender, sender), gte(ruleOutboundLog.createdAt, new Date(Date.now() - withinMs))));
	return Number(row?.value ?? 0) > 0;
}

async function quotaExhausted(db: AppDatabase, mailboxId: string): Promise<boolean> {
	const hour = await db.select({ value: count() }).from(ruleOutboundLog).where(and(eq(ruleOutboundLog.mailboxId, mailboxId), gte(ruleOutboundLog.createdAt, new Date(Date.now() - 3_600_000))));
	if (Number(hour[0]?.value ?? 0) >= 20) return true;
	const day = await db.select({ value: count() }).from(ruleOutboundLog).where(and(eq(ruleOutboundLog.mailboxId, mailboxId), gte(ruleOutboundLog.createdAt, new Date(Date.now() - 86_400_000))));
	return Number(day[0]?.value ?? 0) >= 100;
}

/**
 * Execute the reported outbound actions. `env` is passed to the default
 * sender; `skip` reports the pipeline's spam/discard decision explicitly.
 */
export async function executeRuleOutbound(
	db: AppDatabase,
	env: unknown,
	context: RuleOutboundContext,
	actions: RuleOutboundAction[],
	opts: { skip?: boolean; sender?: RuleOutboundSender } = {},
): Promise<RuleOutboundReport[]> {
	const reports: RuleOutboundReport[] = [];
	const sender = opts.sender ?? (async (input) => {
		const result = await sendEmail(env as never, input as never);
		return { messageId: result.messageId };
	});
	for (const action of actions) {
		const base = { kind: action.kind, ruleId: action.rule_id };
		if (opts.skip) {
			reports.push({ ...base, status: "skipped", reason: "spam or discarded" });
			continue;
		}
		if (await quotaExhausted(db, context.mailboxId)) {
			reports.push({ ...base, status: "skipped", reason: "send quota exhausted" });
			continue;
		}
		try {
			if (action.kind === "forward") {
				if (!action.to || !isRuleEmailAddress(action.to)) {
					reports.push({ ...base, status: "skipped", reason: "invalid forward address" });
					continue;
				}
				if (await sentRecently(db, context.mailboxId, "forward", context.sender, 86_400_000)) {
					reports.push({ ...base, status: "skipped", reason: "already forwarded this sender's mail within 24h" });
					continue;
				}
				await sender({
					userId: context.userId,
					from: context.mailboxAddress,
					to: action.to,
					subject: `Fwd: ${context.subject}`,
					text: context.text ?? undefined,
					html: context.html ?? undefined,
					mailboxId: context.mailboxId,
				});
				await db.insert(ruleOutboundLog).values({ id: newId("rout"), mailboxId: context.mailboxId, kind: "forward", sender: context.sender });
				reports.push({ ...base, status: "sent", to: action.to });
			} else {
				if (isMachineGenerated(context.headers)) {
					reports.push({ ...base, status: "skipped", reason: "machine-generated mail" });
					continue;
				}
				if (context.sender === context.mailboxAddress.toLowerCase()) {
					reports.push({ ...base, status: "skipped", reason: "self-sent mail" });
					continue;
				}
				if (await sentRecently(db, context.mailboxId, "auto_reply", context.sender, 86_400_000)) {
					reports.push({ ...base, status: "skipped", reason: "already auto-replied to this sender within 24h" });
					continue;
				}
				await sender({
					userId: context.userId,
					from: context.mailboxAddress,
					to: context.sender,
					subject: `Re: ${context.subject}`,
					text: action.text ?? "",
					mailboxId: context.mailboxId,
				});
				await db.insert(ruleOutboundLog).values({ id: newId("rout"), mailboxId: context.mailboxId, kind: "auto_reply", sender: context.sender });
				reports.push({ ...base, status: "sent", to: context.sender });
			}
		} catch (error) {
			reports.push({ ...base, status: "failed", reason: error instanceof Error ? error.message.slice(0, 200) : "send failed" });
		}
	}
	return reports;
}