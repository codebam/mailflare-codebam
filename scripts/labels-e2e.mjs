// Spike E2E: labels vertical slice on the Node runtime (port 3100).
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const require = createRequire("/home/codebam/Documents/git/mailflare/package.json");
const Database = require("better-sqlite3");

const BASE = "http://127.0.0.1:3100";
const ORIGIN = { Origin: BASE };
let cookie = "";
const results = [];
const step = (name, ok, extra = "") => { results.push({ name, ok }); console.log(`${ok ? "PASS" : "FAIL"} ${name}${extra ? " — " + extra : ""}`); if (!ok) process.exitCode = 1; };

async function api(method, path, body, headers = {}) {
	const response = await fetch(BASE + path, {
		method,
		headers: { "Content-Type": "application/json", "Sec-Fetch-Site": "same-origin", ...ORIGIN, ...(cookie ? { Cookie: cookie } : {}), ...headers },
		body: body === undefined ? undefined : JSON.stringify(body),
		redirect: "manual",
	});
	const setCookie = response.headers.get("set-cookie");
	if (setCookie) cookie = setCookie.split(";")[0];
	const text = await response.text();
	let json = null;
	try { json = JSON.parse(text); } catch {}
	return { status: response.status, json, text, headers: response.headers };
}

// 1. Migrations: the Node runtime applies them at start; verify the labels tables exist
const checkDb = new Database("/home/codebam/Documents/git/mailflare/data/mailflare.sqlite", { readonly: true });
const tables = checkDb.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('labels','message_labels')").all().map((row) => row.name);
checkDb.close();
step("migrations applied (labels tables exist)", tables.length === 2, tables.join(","));

// 2. First-run registration (admin + domain + mailbox), then login for the session cookie
const register = await api("POST", "/api/auth/register", {
	domain: "spike.local", username: "sean", password: "spike-password-123", resetEmail: "sean@spike.local", skipDns: true,
});
step("first-run register", [200, 201, 403].includes(register.status), `status=${register.status} ${register.text.slice(0, 200)}`);

const login = await api("POST", "/api/auth/login", { email: "sean@spike.local", password: "spike-password-123" });
step("login", login.status === 200 && !!cookie, `status=${login.status} ${login.text.slice(0, 120)}`);

// 3. Mailbox list
const mailboxes = await api("GET", "/api/mailboxes");
const mailbox = mailboxes.json?.mailboxes?.[0];
step("mailbox created", !!mailbox?.id, JSON.stringify(mailboxes.json)?.slice(0, 200));
const mailboxId = mailbox?.id;

// 4. Seed one inbound message straight into SQLite
const db = new Database("/home/codebam/Documents/git/mailflare/data/mailflare.sqlite");
const user = db.prepare("SELECT id FROM users LIMIT 1").get();
const messageId = "spike-message-1";
db.prepare("INSERT OR REPLACE INTO messages (id, user_id, mailbox_id, direction, from_addr, to_addr, subject, snippet, status, created_at) VALUES (?, ?, ?, 'inbound', 'alice@example.org', ?, 'Spike test', 'Labels slice', 'received', unixepoch())")
	.run(messageId, user.id, mailboxId, `sean@spike.local`);
// Idempotent reruns: clear prior spike labels and keys.
db.exec("DELETE FROM message_labels; DELETE FROM labels; DELETE FROM mcp_key_mailboxes WHERE key_id IN (SELECT id FROM api_keys WHERE name = 'spike'); DELETE FROM api_keys WHERE name = 'spike';");
db.close();
step("seed message", true, messageId);

// 5. Labels API flow
const created = await api("POST", "/api/labels", { mailboxId, name: "Work", color: "#f59e0b" });
step("create label", created.status === 201 && created.json?.label?.name === "Work", `status=${created.status}`);
const labelId = created.json?.label?.id;

const dup = await api("POST", "/api/labels", { mailboxId, name: "work" });
step("case-insensitive duplicate refused", dup.status === 409, `status=${dup.status}`);

const listed = await api("GET", `/api/labels?mailboxId=${mailboxId}`);
step("list labels", listed.status === 200 && listed.json?.labels?.length === 1, `status=${listed.status}`);

const attached = await api("POST", `/api/messages/${messageId}/labels`, { label: "WORK" });
step("attach by name (case-insensitive)", attached.status === 200 && attached.json?.labels?.[0]?.id === labelId, `status=${attached.status}`);

const again = await api("POST", `/api/messages/${messageId}/labels`, { label: labelId });
step("attach idempotent", again.status === 200 && again.json?.labels?.length === 1, `status=${again.status}`);

const onMessage = await api("GET", `/api/messages/${messageId}/labels`);
step("message labels", onMessage.status === 200 && onMessage.json?.labels?.length === 1, `status=${onMessage.status}`);

const renamed = await api("PATCH", `/api/labels/${labelId}`, { mailboxId, name: "Work2", color: null });
step("rename + clear color", renamed.status === 200 && renamed.json?.label?.name === "Work2" && renamed.json?.label?.color === null, `status=${renamed.status}`);

const detached = await api("DELETE", `/api/messages/${messageId}/labels`, { label: "Work2" });
step("detach by name", detached.status === 200 && detached.json?.labels?.length === 0, `status=${detached.status}`);

// 6. MCP key with read + organize scopes
const keyResponse = await api("POST", "/api/agent/mcp-keys", { name: "spike", mailboxIds: [mailboxId], scopes: ["mcp:read", "mcp:organize"] });
step("create MCP key", keyResponse.status === 200 && !!keyResponse.json?.key, `status=${keyResponse.status} ${keyResponse.text.slice(0, 120)}`);
const mcpKey = keyResponse.json?.key;

// 7. MCP JSON-RPC: initialize, tools/list, label tool calls
let mcpSession = "";
async function mcp(method, params, id) {
	const response = await fetch(BASE + "/mcp", {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Accept: "application/json, text/event-stream",
			Authorization: `Bearer ${mcpKey}`,
			...(mcpSession ? { "mcp-session-id": mcpSession } : {}),
		},
		body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
	});
	const session = response.headers.get("mcp-session-id");
	if (session) mcpSession = session;
	const text = await response.text();
	if (text.startsWith("event:") || text.includes("data:")) {
		const dataLine = text.split("\n").find((line) => line.startsWith("data:"));
		return dataLine ? JSON.parse(dataLine.slice(5).trim()) : null;
	}
	try { return text ? JSON.parse(text) : null; } catch { return { error: text.slice(0, 200), status: response.status }; }
}

const init = await mcp("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "spike", version: "0" } }, 1);
step("MCP initialize", !!init?.result?.serverInfo, JSON.stringify(init)?.slice(0, 120));
await fetch(BASE + "/mcp", { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", Authorization: `Bearer ${mcpKey}`, ...(mcpSession ? { "mcp-session-id": mcpSession } : {}) }, body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) });

const tools = await mcp("tools/list", {}, 2);
const toolNames = (tools?.result?.tools ?? []).map((tool) => tool.name);
const labelTools = ["list_labels", "create_label", "update_label", "delete_label", "add_label", "remove_label"];
step("MCP exposes all 6 label tools", labelTools.every((name) => toolNames.includes(name)), toolNames.join(","));

const call = async (name, args, id) => {
	const response = await mcp("tools/call", { name, arguments: args }, id);
	const content = response?.result?.content?.[0]?.text;
	return { isError: response?.result?.isError, body: content ? JSON.parse(content) : null };
};

const mcpCreated = await call("create_label", { mailboxId, name: "Via MCP", color: "#22c55e" }, 3);
step("MCP create_label", !mcpCreated.isError && mcpCreated.body?.label?.name === "Via MCP", JSON.stringify(mcpCreated.body)?.slice(0, 120));

const mcpAttached = await call("add_label", { mailboxId, emailId: messageId, label: "via mcp" }, 4);
step("MCP add_label by name", !mcpAttached.isError && mcpAttached.body?.labels?.some((label) => label.name === "Via MCP"), JSON.stringify(mcpAttached.body)?.slice(0, 120));

const mcpListed = await call("list_labels", { mailboxId }, 5);
step("MCP list_labels", !mcpListed.isError && mcpListed.body?.labels?.length === 2, JSON.stringify(mcpListed.body)?.slice(0, 160));

const mcpRemoved = await call("remove_label", { mailboxId, emailId: messageId, label: "Via MCP" }, 6);
step("MCP remove_label", !mcpRemoved.isError && mcpRemoved.body?.labels?.length === 0, JSON.stringify(mcpRemoved.body)?.slice(0, 120));

const mcpDeleted = await call("delete_label", { mailboxId, label: "Via MCP" }, 7);
step("MCP delete_label", !mcpDeleted.isError && mcpDeleted.body?.deleted === true, JSON.stringify(mcpDeleted.body)?.slice(0, 120));

// 8. Cleanup the API-created label
const deleted = await api("DELETE", `/api/labels/${labelId}?mailboxId=${mailboxId}`);
step("API delete label", deleted.status === 200 && deleted.json?.deleted === true, `status=${deleted.status}`);

const failed = results.filter((result) => !result.ok);
console.log(`\n${results.length - failed.length}/${results.length} steps passed`);
if (failed.length) { console.log("FAILED:", failed.map((f) => f.name).join("; ")); process.exit(1); }
console.log("SPIKE E2E OK");