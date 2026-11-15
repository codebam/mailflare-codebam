import { and, eq } from "drizzle-orm";
import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { getDb } from "@/db";
import { messages } from "@/db/schema";
import { getMailboxAccessLevel } from "@/lib/mailboxes/access";
import { listSenderPolicies, removeSenderPolicy, setSenderPolicy } from "@/lib/sender-policy/service";
import { isSenderPolicy } from "@/lib/sender-policy/sender-policy-utils";
import { exportEmail } from "@/lib/eml-export/service";
import { getMailboxStorage } from "@/lib/storage/service";
import type { McpPrincipal } from "./types";

function output(value: unknown, isError = false) {
	return { content: [{ type: "text" as const, text: JSON.stringify(value) }], isError };
}

function audit(principal: McpPrincipal, tool: string, mailboxId?: string) {
	console.info(JSON.stringify({ audit: "mcp", tool, userId: principal.user.id, mailboxId }));
}

/**
 * Mail pipeline tools ported from agentic-inbox: sender allow/block policy,
 * EML export and per-mailbox storage stats. Reads need mcp:read, writes
 * mcp:organize; every call is mailbox-scoped.
 */
export function registerMailMcpTools(server: McpServer, principal: McpPrincipal, env: CloudflareEnv) {
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
		catch (error) { return output({ error: error instanceof Error ? error.message : "Tool failed" }, true); }
	};

	server.registerTool("get_sender_policy", { description: "List the mailbox's sender allow/block entries (address, policy, created_at), ordered by address. Allow trusts a sender (not spam); block files their mail into Spam.", inputSchema: z.object({ mailboxId: z.string() }), annotations: { readOnlyHint: true, openWorldHint: false } }, async ({ mailboxId }) =>
		guard(mailboxId, false, "get_sender_policy", async (db) => ({ entries: await listSenderPolicies(db, mailboxId) })));
	server.registerTool("set_sender_policy", { description: "Record an allow or block decision for the sender of an email: allow moves future mail back to the Inbox and clears its spam markings; block files it into Spam. Nothing is deleted. The sender address is taken from the email.", inputSchema: z.object({ mailboxId: z.string(), emailId: z.string(), action: z.enum(["allow", "block"]) }), annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false } }, async ({ mailboxId, emailId, action }) =>
		guard(mailboxId, true, "set_sender_policy", async (db) => {
			const [row] = await db.select({ fromAddr: messages.fromAddr }).from(messages).where(and(eq(messages.id, emailId), eq(messages.mailboxId, mailboxId))).limit(1);
			if (!row) throw new Error("Email not found");
			if (!isSenderPolicy(action)) throw new Error("action must be allow or block");
			const entry = await setSenderPolicy(db, mailboxId, row.fromAddr, action);
			return { entry };
		}));
	server.registerTool("remove_sender_policy", { description: "Remove one sender allow/block entry by address, so future mail from that sender is classified normally again. Nothing else changes — no mail is moved or deleted.", inputSchema: z.object({ mailboxId: z.string(), address: z.string() }), annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false } }, async ({ mailboxId, address }) =>
		guard(mailboxId, true, "remove_sender_policy", async (db) => {
			const removed = await removeSenderPolicy(db, mailboxId, address);
			if (!removed) throw new Error("Sender policy entry not found");
			return { removed: true };
		}));
	server.registerTool("export_email", { description: "One stored message as a reconstructed RFC 5322 (EML) block under the eml key — rebuilt from the stored fields, never the wire source. Read-only.", inputSchema: z.object({ mailboxId: z.string(), emailId: z.string() }), annotations: { readOnlyHint: true, openWorldHint: false } }, async ({ mailboxId, emailId }) =>
		guard(mailboxId, false, "export_email", async (db) => {
			const result = await exportEmail(db, mailboxId, emailId);
			if (!result) throw new Error("Email not found");
			return { emailId, eml: result.eml };
		}));
	server.registerTool("get_storage", { description: "The mailbox's storage footprint: stored message count and attachment count/bytes. Read-only.", inputSchema: z.object({ mailboxId: z.string() }), annotations: { readOnlyHint: true, openWorldHint: false } }, async ({ mailboxId }) =>
		guard(mailboxId, false, "get_storage", async (db) => getMailboxStorage(db, mailboxId)));
}