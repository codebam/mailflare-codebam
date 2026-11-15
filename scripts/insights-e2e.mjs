// Phase 1 batch 2 E2E: categories, items, digest, action log + undo — REST + MCP.
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
db.exec("DELETE FROM categories; DELETE FROM items; DELETE FROM agent_actions; DELETE FROM mcp_key_mailboxes WHERE key_id IN (SELECT id FROM api_keys WHERE name = 'insights'); DELETE FROM api_keys WHERE name = 'insights';");
db.prepare("UPDATE messages SET read = 0, starred = 0, folder_id = NULL WHERE id = 'spike-message-1'").run();
db.close();

// ---- Categories ----
const category = await api("POST", "/api/categories", { mailboxId, name: "Finance", color: "#22c55e" });
step("create category", category.status === 201 && category.json?.category?.name === "Finance", `status=${category.status}`);
const categoryId = category.json?.category?.id;
const dupCategory = await api("POST", "/api/categories", { mailboxId, name: "finance" });
step("category duplicate refused", dupCategory.status === 409, `status=${dupCategory.status}`);
const categories = await api("GET", `/api/categories?mailboxId=${mailboxId}`);
step("list categories", categories.status === 200 && categories.json?.categories?.length === 1, `status=${categories.status}`);

// ---- Items ----
const item = await api("POST", "/api/items", { mailboxId, title: "Pay the invoice", kind: "deadline", dueAt: "2026-11-14T12:00:00Z", messageId: "spike-message-1" });
step("create item", item.status === 201 && item.json?.item?.kind === "deadline", `status=${item.status} ${item.text.slice(0, 100)}`);
const itemId = item.json?.item?.id;
const overdue = await api("GET", `/api/items?mailboxId=${mailboxId}&due=overdue`);
step("list overdue items", overdue.status === 200 && overdue.json?.items?.some((i) => i.id === itemId), `status=${overdue.status}`);
const done = await api("PATCH", `/api/items/${itemId}`, { mailboxId, status: "done" });
step("mark item done", done.status === 200 && done.json?.item?.status === "done", `status=${done.status}`);

// ---- Digest ----
const digest = await api("GET", `/api/digest?mailboxId=${mailboxId}`);
step("digest", digest.status === 200 && typeof digest.json?.arrivals === "number" && Array.isArray(digest.json?.recent), `status=${digest.status} arrivals=${digest.json?.arrivals}`);

// ---- Action log + undo (seed one recorded action, undo it via MCP) ----
const db2 = new Database("/home/codebam/Documents/git/mailflare/data/mailflare.sqlite");
db2.prepare("INSERT INTO agent_actions (id, mailbox_id, tool, message_id, subject, before_state, after_state, undoable, created_at) VALUES ('act_e2e_1', ?, 'star_email', 'spike-message-1', 'Spike test', ?, ?, 1, unixepoch())")
	.run(mailboxId, JSON.stringify({ read: false, starred: false, folderId: null }), JSON.stringify({ starred: true }));
db2.prepare("UPDATE messages SET starred = 1 WHERE id = 'spike-message-1'").run();
db2.close();
const actions = await api("GET", `/api/agent-actions?mailboxId=${mailboxId}`);
step("list agent actions", actions.status === 200 && actions.json?.total === 1 && actions.json?.actions?.[0]?.id === "act_e2e_1", `status=${actions.status}`);

// ---- MCP ----
const keyResponse = await api("POST", "/api/agent/mcp-keys", { name: "insights", mailboxIds: [mailboxId], scopes: ["mcp:read", "mcp:organize"] });
step("create MCP key", keyResponse.status === 200 && !!keyResponse.json?.key, `status=${keyResponse.status}`);
const mcpKey = keyResponse.json?.key;
let mcpSession = "";
async function mcp(method, params, id) {
	const response = await fetch(BASE + "/mcp", {
		method: "POST",
		headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", Authorization: `Bearer ${mcpKey}`, ...(mcpSession ? { "mcp-session-id": mcpSession } : {}) },
		body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
		signal: AbortSignal.timeout(15000),
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
const call = async (name, args, id) => {
	const response = await mcp("tools/call", { name, arguments: args }, id);
	const content = response?.result?.content?.[0]?.text;
	return { isError: response?.result?.isError, body: content ? JSON.parse(content) : null };
};
await mcp("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "insights-e2e", version: "0" } }, 1);
await fetch(BASE + "/mcp", { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", Authorization: `Bearer ${mcpKey}`, ...(mcpSession ? { "mcp-session-id": mcpSession } : {}) }, body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) });

const tools = await mcp("tools/list", {}, 2);
const toolNames = (tools?.result?.tools ?? []).map((tool) => tool.name);
const expected = ["list_agent_actions", "undo_action", "list_items", "update_item", "get_digest"];
step("MCP exposes insights tools", expected.every((name) => toolNames.includes(name)), `missing: ${expected.filter((name) => !toolNames.includes(name)).join(",") || "none"}`);

const mcpUndo = await call("undo_action", { mailboxId, actionId: "act_e2e_1" }, 3);
step("MCP undo_action restores state", !mcpUndo.isError && !!mcpUndo.body?.action?.undoneAt, JSON.stringify(mcpUndo.body)?.slice(0, 120));
const db3 = new Database("/home/codebam/Documents/git/mailflare/data/mailflare.sqlite", { readonly: true });
const starred = db3.prepare("SELECT starred FROM messages WHERE id = 'spike-message-1'").get().starred;
db3.close();
step("undo restored starred=0", starred === 0, `starred=${starred}`);
const mcpUndoAgain = await call("undo_action", { mailboxId, actionId: "act_e2e_1" }, 4);
step("MCP undo once only", mcpUndoAgain.isError === true && /already undone/.test(mcpUndoAgain.body?.error ?? ""), JSON.stringify(mcpUndoAgain.body)?.slice(0, 100));

const mcpItems = await call("list_items", { mailboxId, status: "done" }, 5);
step("MCP list_items", !mcpItems.isError && mcpItems.body?.items?.some((i) => i.id === itemId), JSON.stringify(mcpItems.body)?.slice(0, 120));
const mcpDigest = await call("get_digest", { mailboxId }, 6);
step("MCP get_digest", !mcpDigest.isError && typeof mcpDigest.body?.arrivals === "number", JSON.stringify(mcpDigest.body)?.slice(0, 100));

// ---- Cleanup ----
const categoryDeleted = await api("DELETE", `/api/categories/${categoryId}?mailboxId=${mailboxId}`);
step("delete category", categoryDeleted.status === 200, `status=${categoryDeleted.status}`);

const failed = results.filter((result) => !result.ok);
console.log(`\n${results.length - failed.length}/${results.length} steps passed`);
if (failed.length) { console.log("FAILED:", failed.map((f) => f.name).join("; ")); process.exit(1); }
console.log("INSIGHTS E2E OK");