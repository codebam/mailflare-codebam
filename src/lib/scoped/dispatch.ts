import type { McpServer } from "@modelcontextprotocol/server";
import { getDb } from "@/db";
import { listAccessibleMailboxes } from "@/lib/mailboxes/access";
import { registerOrganizeMcpTools } from "@/lib/mcp/organize-tools";
import { registerMailMcpTools } from "@/lib/mcp/mail-tools";
import { registerCompatMailTools } from "@/lib/mcp/compat-mail";
import { registerCompatActionTools } from "@/lib/mcp/compat-actions";
import type { McpPrincipal } from "@/lib/mcp/types";
import type { VerifiedToken } from "@/lib/scoped-tokens/service";
import type { AccessTokenScope } from "@/lib/scoped-tokens/token-utils";

/**
 * The scoped automation surface: POST /api/v1/scoped/<tool>, ported from
 * agentic-inbox. Dispatches to the SAME handlers the MCP facade registers,
 * captured through a recording server, so the two surfaces cannot drift.
 *
 * Scope map (read/draft/send/manage) follows the old contract; the ported
 * Phase-1 tools join the scope that matches their MCP scope.
 */
export const SCOPED_TOOL_SCOPES: Record<string, AccessTokenScope> = {
	// read
	list_emails: "read", get_email: "read", get_thread: "read", search_emails: "read", get_attachment: "read",
	list_labels: "read", list_templates: "read", list_saved_searches: "read", summarize_thread: "read",
	list_scheduled_sends: "read", get_sender_policy: "read", list_folders: "read", search_contacts: "read",
	list_snoozed: "read", list_items: "read", get_digest: "read", get_storage: "read", list_agent_actions: "read",
	list_rules: "read", preview_rule: "read", semantic_search: "read", get_calendar_invite: "read", export_email: "read",
	// draft
	draft_reply: "draft", create_draft: "draft", update_draft: "draft", discard_draft: "draft",
	// send
	send_email: "send", send_reply: "send", unsubscribe_email: "send", cancel_scheduled_send: "send",
	schedule_send: "send", retry_scheduled_send: "send", respond_to_invite: "send",
	// manage
	mark_email_read: "manage", star_email: "manage", move_email: "manage", delete_email: "manage",
	snooze_email: "manage", unsnooze_email: "manage", set_sender_policy: "manage", add_label: "manage",
	remove_label: "manage", create_label: "manage", update_label: "manage", delete_label: "manage",
	create_template: "manage", update_template: "manage", delete_template: "manage",
	create_saved_search: "manage", update_saved_search: "manage", delete_saved_search: "manage",
	mute_thread: "manage", unmute_thread: "manage", mark_thread_read: "manage", empty_trash: "manage",
	delete_spam_emails: "manage", restore_email: "manage", remove_sender_policy: "manage",
	create_folder: "manage", update_folder: "manage", delete_folder: "manage",
	set_reminder: "manage", clear_reminder: "manage", update_item: "manage", undo_action: "manage",
	create_rule: "manage", update_rule: "manage", delete_rule: "manage", apply_rule: "manage", reorder_rules: "manage",
};

/** App-token-only reads; a mailbox token naming one is refused. */
export const ALL_MAILBOX_TOOLS = new Set(["list_mailboxes", "list_all_emails", "search_all_mailboxes"]);

const SCOPE_TO_MCP: Record<AccessTokenScope, string> = { read: "mcp:read", draft: "mcp:draft", send: "mcp:send", manage: "mcp:organize" };

type CapturedTool = {
	inputSchema: { parse: (args: unknown) => unknown };
	handler: (args: never) => Promise<{ content: Array<{ text: string }>; isError?: boolean }>;
};

/** Record every facade handler under its tool name. */
function captureTools(env: CloudflareEnv, principal: McpPrincipal): Map<string, CapturedTool> {
	const tools = new Map<string, CapturedTool>();
	const server = {
		registerTool: (name: string, meta: { inputSchema: CapturedTool["inputSchema"] }, handler: CapturedTool["handler"]) => {
			tools.set(name, { inputSchema: meta.inputSchema, handler });
		},
	} as unknown as McpServer;
	registerOrganizeMcpTools(server, principal, env);
	registerMailMcpTools(server, principal, env);
	registerCompatMailTools(server, principal, env);
	registerCompatActionTools(server, principal, env);
	// list_mailboxes lives in the native server registration; mirror it here.
	tools.set("list_mailboxes", {
		inputSchema: { parse: () => ({}) },
		handler: async () => {
			const accessible = await listAccessibleMailboxes(getDb(env), principal.user);
			const rows = accessible.filter((row) => principal.mailboxIds.includes(row.id)).map(({ id, localPart, hostname, displayName }) => ({ id, address: `${localPart}@${hostname}`, displayName }));
			return { content: [{ text: JSON.stringify(rows) }] };
		},
	});
	return tools;
}

export type ScopedResult = { status: number; body: unknown };

/**
 * Run one scoped tool call. Mailbox tokens are bound to their mailbox — the
 * body can never name another; app tokens must name the mailbox per call.
 */
export async function dispatchScopedTool(env: CloudflareEnv, verified: VerifiedToken, toolName: string, body: Record<string, unknown>): Promise<ScopedResult> {
	const isAllMailbox = ALL_MAILBOX_TOOLS.has(toolName);
	const required = isAllMailbox ? "read" : SCOPED_TOOL_SCOPES[toolName];
	if (!required) return { status: 404, body: { error: `Unknown tool: ${toolName}` } };
	if (!verified.scopes.includes(required)) return { status: 403, body: { error: `This token lacks the ${required} scope` } };
	if (verified.kind === "mailbox" && isAllMailbox) return { status: 403, body: { error: "All-mailbox tools require an app token" } };

	const args = { ...body };
	if (verified.kind === "mailbox") {
		if (typeof args.mailboxId === "string" && args.mailboxId !== verified.mailboxId) {
			return { status: 403, body: { error: "This token is bound to a different mailbox" } };
		}
		args.mailboxId = verified.mailboxId;
	} else if (!isAllMailbox && (typeof args.mailboxId !== "string" || !args.mailboxId)) {
		return { status: 400, body: { error: "mailboxId is required for app-token calls" } };
	}

	const db = getDb(env);
	let mailboxIds: string[];
	if (verified.kind === "mailbox") {
		mailboxIds = [verified.mailboxId!];
	} else {
		const accessible = await listAccessibleMailboxes(db, verified.user);
		mailboxIds = accessible.map((row) => row.id);
		if (!isAllMailbox && !mailboxIds.includes(args.mailboxId as string)) {
			return { status: 403, body: { error: "Mailbox not found" } };
		}
	}
	const principal: McpPrincipal = {
		keyId: verified.id,
		user: verified.user,
		scopes: verified.scopes.map((scope) => SCOPE_TO_MCP[scope]),
		mailboxIds,
	};
	const tools = captureTools(env, principal);
	const tool = tools.get(toolName);
	if (!tool) return { status: 404, body: { error: `Unknown tool: ${toolName}` } };
	let parsed: unknown;
	try {
		parsed = tool.inputSchema.parse(args);
	} catch (error) {
		return { status: 400, body: { error: error instanceof Error ? error.message : "Invalid tool arguments" } };
	}
	try {
		const result = await tool.handler(parsed as never);
		const text = result.content?.[0]?.text ?? "{}";
		const json = JSON.parse(text) as unknown;
		if (result.isError) return { status: 400, body: json };
		return { status: 200, body: json };
	} catch (error) {
		return { status: 500, body: { error: error instanceof Error ? error.message : "Tool failed" } };
	}
}