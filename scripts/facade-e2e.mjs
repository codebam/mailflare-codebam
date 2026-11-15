// Phase 2 E2E: the agentic-inbox compat facade over MCP.
import { createRequire } from "node:module";
const require = createRequire("/home/codebam/Documents/git/mailflare/package.json");
const Database = require("better-sqlite3");

const BASE = process.env.MAILFLARE_E2E_URL || "http://127.0.0.1:3100";
let cookie = "";
const results = [];
const step = (name, ok, extra = "") => { results.push({ name, ok }); console.log(`${ok ? "PASS" : "FAIL"} ${name}${extra ? " — " + extra : ""}`); if (!ok) process.exitCode = 1; };

async function api(method, path, body) {
	const response = await fetch(BASE + path, {
		method,
		headers: { "Content-Type": "application/json", "Sec-Fetch-Site": "same-origin", Origin: BASE, ...(cookie ? { Cookie: cookie } : {}) },
		body: body === undefined ? undefined : JSON.stringify(body),
		redirect: "manual",
		signal: AbortSignal.timeout(15000),
	});
	const setCookie = response.headers.get("set-cookie");
	if (setCookie) cookie = setCookie.split(";")[0];
	const text = await response.text();
	let json = null;
	try { json = JSON.parse(text); } catch {}
	return { status: response.status, json, text };
}

const login = await api("POST", "/api/auth/login", { email: "sean@spike.local", password: "spike-password-123" });
step("login", login.status === 200, `status=${login.status}`);
const mailboxes = await api("GET", "/api/mailboxes");
const mailboxId = mailboxes.json?.mailboxes?.[0]?.id;
step("mailbox", !!mailboxId);

const db = new Database("/home/codebam/Documents/git/mailflare/data/mailflare.sqlite");
db.exec("DELETE FROM agent_actions; DELETE FROM follow_ups; DELETE FROM folders; DELETE FROM mcp_key_mailboxes WHERE key_id IN (SELECT id FROM api_keys WHERE name = 'facade'); DELETE FROM api_keys WHERE name = 'facade';");
db.prepare("UPDATE messages SET read = 0, starred = 0, folder_id = NULL, status = 'received', snoozed_until = NULL WHERE id = 'spike-message-1'").run();
db.close();

const keyResponse = await api("POST", "/api/agent/mcp-keys", { name: "facade", mailboxIds: [mailboxId], scopes: ["mcp:read", "mcp:draft", "mcp:organize", "mcp:send"] });
step("create MCP key with mcp:send", keyResponse.status === 200 && !!keyResponse.json?.key, `status=${keyResponse.status} ${keyResponse.text.slice(0, 100)}`);
const mcpKey = keyResponse.json?.key;
let mcpSession = "";
async function mcp(method, params, id) {
	const response = await fetch(BASE + "/mcp", {
		method: "POST",
		headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", Authorization: `Bearer ${mcpKey}`, ...(mcpSession ? { "mcp-session-id": mcpSession } : {}) },
		body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
		signal: AbortSignal.timeout(20000),
	});
	const session = response.headers.get("mcp-session-id");
	if (session) mcpSession = session;
	const text = await response.text();
	if (text.includes("data:")) {
		const dataLine = text.split("\n").find((line) => line.startsWith("data:"));
		return dataLine ? JSON.parse(dataLine.slice(5).trim()) : null;
	}
	try { return text ? JSON.parse(text) : null; } catch { return { error: text.slice(0, 200) }; }
}
let callId = 10;
const call = async (name, args) => {
	const response = await mcp("tools/call", { name, arguments: args }, callId++);
	const content = response?.result?.content?.[0]?.text;
	return { isError: response?.result?.isError, body: content ? JSON.parse(content) : null };
};
await mcp("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "facade-e2e", version: "0" } }, 1);
await fetch(BASE + "/mcp", { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", Authorization: `Bearer ${mcpKey}`, ...(mcpSession ? { "mcp-session-id": mcpSession } : {}) }, body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) });

const tools = await mcp("tools/list", {}, 2);
const toolNames = (tools?.result?.tools ?? []).map((tool) => tool.name);
const contract = ["list_emails", "get_email", "get_thread", "search_emails", "get_attachment", "list_all_emails", "search_all_mailboxes", "list_folders", "create_folder", "update_folder", "delete_folder", "search_contacts", "list_snoozed", "list_scheduled_sends", "get_calendar_invite", "summarize_thread", "create_draft", "draft_reply", "update_draft", "discard_draft", "send_email", "send_reply", "schedule_send", "retry_scheduled_send", "unsubscribe_email", "star_email", "mark_email_read", "move_email", "delete_email", "restore_email", "empty_trash", "delete_spam_emails", "mark_thread_read", "snooze_email", "unsnooze_email", "set_reminder", "clear_reminder", "respond_to_invite"];
step(`facade exposes all ${contract.length} contract tools`, contract.every((name) => toolNames.includes(name)), `missing: ${contract.filter((name) => !toolNames.includes(name)).join(",") || "none"}`);
step("native extras kept", ["request_send", "move_emails", "draft_email", "add_conversation_note", "get_scheduled_send", "cancel_scheduled_send"].every((name) => toolNames.includes(name)), `missing: ${["request_send", "move_emails", "draft_email", "add_conversation_note", "get_scheduled_send", "cancel_scheduled_send"].filter((name) => !toolNames.includes(name)).join(",") || "none"}`);

// ---- Reads ----
const listed = await call("list_emails", { mailboxId, folder: "inbox", limit: 10, page: 1 });
step("list_emails contract shape", !listed.isError && Array.isArray(listed.body?.emails) && typeof listed.body?.totalCount === "number" && listed.body.emails.some((email) => email.id === "spike-message-1"), JSON.stringify(listed.body)?.slice(0, 120));
const got = await call("get_email", { mailboxId, emailId: "spike-message-1" });
step("get_email full body", !got.isError && got.body?.subject === "Spike test" && "bodyText" in got.body && Array.isArray(got.body?.attachments), JSON.stringify(got.body)?.slice(0, 100));
const searched = await call("search_emails", { mailboxId, query: "spike", isRead: false });
step("search_emails query+filter", !searched.isError && searched.body?.emails?.some((email) => email.id === "spike-message-1"), JSON.stringify(searched.body)?.slice(0, 100));
const thread = await call("get_thread", { mailboxId, threadId: "spike-message-1" });
step("get_thread by message id", !thread.isError && thread.body?.emails?.length >= 1, JSON.stringify(thread.body)?.slice(0, 80));
const all = await call("list_all_emails", { limit: 5 });
step("list_all_emails", !all.isError && Array.isArray(all.body?.emails), JSON.stringify(all.body)?.slice(0, 80));
const allSearch = await call("search_all_mailboxes", { query: "spike" });
step("search_all_mailboxes", !allSearch.isError && allSearch.body?.emails?.length >= 1, JSON.stringify(allSearch.body)?.slice(0, 80));
const invite = await call("get_calendar_invite", { mailboxId, emailId: "spike-message-1" });
step("get_calendar_invite null contract", !invite.isError && invite.body?.invite === null, JSON.stringify(invite.body)?.slice(0, 60));
const summary = await call("summarize_thread", { mailboxId, threadId: "spike-message-1" });
step("summarize_thread AI-not-configured contract", summary.isError === true && /not configured/i.test(summary.body?.error ?? ""), JSON.stringify(summary.body)?.slice(0, 100));

// ---- Drafts ----
const draft = await call("create_draft", { mailboxId, to: "someone@example.org", subject: "Facade draft", bodyHtml: "<p>hello</p>" });
step("create_draft", !draft.isError && !!draft.body?.draftId, JSON.stringify(draft.body)?.slice(0, 100));
const draftId = draft.body?.draftId;
const updated = await call("update_draft", { mailboxId, draftId, subject: "Facade draft v2" });
step("update_draft", !updated.isError && updated.body?.status === "updated", JSON.stringify(updated.body)?.slice(0, 80));
const discarded = await call("discard_draft", { mailboxId, draftId });
step("discard_draft", !discarded.isError && discarded.body?.deleted === true, JSON.stringify(discarded.body)?.slice(0, 60));

// ---- Manage + undo ----
const starred = await call("star_email", { mailboxId, emailId: "spike-message-1", starred: true });
step("star_email", !starred.isError && starred.body?.starred === true, JSON.stringify(starred.body)?.slice(0, 60));
const actions = await call("list_agent_actions", { mailboxId });
const starAction = actions.body?.actions?.find((action) => action.tool === "star_email");
step("star recorded in action log", !!starAction?.id, JSON.stringify(actions.body)?.slice(0, 100));
const undo = await call("undo_action", { mailboxId, actionId: starAction?.id });
step("undo_action restores star", !undo.isError && !!undo.body?.action?.undoneAt, JSON.stringify(undo.body)?.slice(0, 80));
const db2 = new Database("/home/codebam/Documents/git/mailflare/data/mailflare.sqlite", { readonly: true });
step("star actually restored", db2.prepare("SELECT starred FROM messages WHERE id = 'spike-message-1'").get().starred === 0);
db2.close();

const folder = await call("create_folder", { mailboxId, name: "Facade Folder" });
step("create_folder", !folder.isError && !!folder.body?.id, JSON.stringify(folder.body)?.slice(0, 80));
const moved = await call("move_email", { mailboxId, emailId: "spike-message-1", folderId: "Facade Folder" });
step("move_email by name", !moved.isError, JSON.stringify(moved.body)?.slice(0, 80));
const foldersList = await call("list_folders", { mailboxId });
step("list_folders includes custom", !foldersList.isError && foldersList.body?.folders?.some((f) => f.name === "Facade Folder"), JSON.stringify(foldersList.body)?.slice(0, 120));
const renamedFolder = await call("update_folder", { mailboxId, folderId: folder.body?.id, name: "Renamed Folder" });
step("update_folder", !renamedFolder.isError && renamedFolder.body?.name === "Renamed Folder", JSON.stringify(renamedFolder.body)?.slice(0, 80));
const deletedFolder = await call("delete_folder", { mailboxId, folderId: folder.body?.id });
step("delete_folder", !deletedFolder.isError && deletedFolder.body?.deleted === true, JSON.stringify(deletedFolder.body)?.slice(0, 60));

const snoozed = await call("snooze_email", { mailboxId, emailId: "spike-message-1", until: "2h" });
step("snooze_email shorthand", !snoozed.isError && !!snoozed.body?.snoozedUntil, JSON.stringify(snoozed.body)?.slice(0, 80));
const snoozedList = await call("list_snoozed", { mailboxId });
step("list_snoozed", !snoozedList.isError && snoozedList.body?.emails?.some((email) => email.id === "spike-message-1"), JSON.stringify(snoozedList.body)?.slice(0, 80));
const awake = await call("unsnooze_email", { mailboxId, emailId: "spike-message-1" });
step("unsnooze_email", !awake.isError && awake.body?.awake === true, JSON.stringify(awake.body)?.slice(0, 60));

const reminder = await call("set_reminder", { mailboxId, emailId: "spike-message-1", at: "1d" });
step("set_reminder", !reminder.isError && !!reminder.body?.reminderAt, JSON.stringify(reminder.body)?.slice(0, 80));
const cleared = await call("clear_reminder", { mailboxId, emailId: "spike-message-1" });
step("clear_reminder", !cleared.isError && cleared.body?.cleared === true, JSON.stringify(cleared.body)?.slice(0, 60));

const trashed = await call("delete_email", { mailboxId, emailId: "spike-message-1" });
step("delete_email to trash", !trashed.isError && trashed.body?.permanent === false, JSON.stringify(trashed.body)?.slice(0, 80));
const restored = await call("restore_email", { mailboxId, emailId: "spike-message-1" });
step("restore_email", !restored.isError && restored.body?.restored === true, JSON.stringify(restored.body)?.slice(0, 60));
const permNoConfirm = await call("delete_email", { mailboxId, emailId: "spike-message-1", permanent: true });
step("permanent delete needs confirm", permNoConfirm.isError === true && /confirm/.test(permNoConfirm.body?.error ?? ""), JSON.stringify(permNoConfirm.body)?.slice(0, 80));
const threadRead = await call("mark_thread_read", { mailboxId, threadId: "spike-message-1" });
step("mark_thread_read", !threadRead.isError && threadRead.body?.read === true, JSON.stringify(threadRead.body)?.slice(0, 60));
const contacts = await call("search_contacts", { mailboxId, query: "alice" });
step("search_contacts", !contacts.isError && Array.isArray(contacts.body?.contacts), JSON.stringify(contacts.body)?.slice(0, 80));

// ---- Send wiring (no outbound provider on the dev Node runtime: clean error, never a silent send) ----
const sendAttempt = await call("send_email", { mailboxId, to: "nobody@example.org", subject: "Facade send test", bodyHtml: "<p>test</p>" });
step("send_email fails cleanly without provider", sendAttempt.isError === true && typeof sendAttempt.body?.error === "string", JSON.stringify(sendAttempt.body)?.slice(0, 120));

const failed = results.filter((result) => !result.ok);
console.log(`\n${results.length - failed.length}/${results.length} steps passed`);
if (failed.length) { console.log("FAILED:", failed.map((f) => f.name).join("; ")); process.exit(1); }
console.log("FACADE E2E OK");