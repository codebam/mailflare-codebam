// Phase 1 E2E: rules, templates, saved searches, mute — REST + MCP on the Node runtime.
// Prereq: server on PORT (default 3100) with the spike account from labels-e2e.mjs.
import assert from "node:assert/strict";
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

// Clean prior organize data for idempotent reruns.
const db = new Database("/home/codebam/Documents/git/mailflare/data/mailflare.sqlite");
db.exec("DELETE FROM rules; DELETE FROM mailbox_templates; DELETE FROM saved_searches; DELETE FROM muted_threads; DELETE FROM mcp_key_mailboxes WHERE key_id IN (SELECT id FROM api_keys WHERE name = 'organize'); DELETE FROM api_keys WHERE name = 'organize';");
db.prepare("UPDATE messages SET folder_id = NULL, category = NULL, read = 0, starred = 0 WHERE id = 'spike-message-1'").run();
db.close();

// ---- Rules via REST (operator path) ----
const ruleBody = { mailboxId, name: "Invoices", match: { mode: "all", conditions: { subject_contains: "spike" } }, actions: { move_to_folder: "missing-folder" } };
const badFolder = await api("POST", "/api/rules", ruleBody);
step("rule unknown folder refused", badFolder.status === 400, `status=${badFolder.status}`);

const created = await api("POST", "/api/rules", { ...ruleBody, actions: { star: true, mark_read: true } });
step("create rule", created.status === 201 && created.json?.rule?.name === "Invoices", `status=${created.status} ${created.text.slice(0, 120)}`);
const ruleId = created.json?.rule?.id;

const preview = await api("POST", "/api/rules/preview", { mailboxId, match: { mode: "all", conditions: { subject_contains: "spike" } } });
step("preview matches seeded mail", preview.status === 200 && preview.json?.total === 1, `status=${preview.status} total=${preview.json?.total}`);

const applied = await api("POST", `/api/rules/${ruleId}/apply`, { mailboxId });
step("apply rule retroactively", applied.status === 200 && applied.json?.applied === 1, `status=${applied.status} ${JSON.stringify(applied.json)}`);
const appliedAgain = await api("POST", `/api/rules/${ruleId}/apply`, { mailboxId });
step("apply idempotent", appliedAgain.status === 200 && appliedAgain.json?.applied === 0 && appliedAgain.json?.skipped === 1, JSON.stringify(appliedAgain.json));

const reordered = await api("POST", "/api/rules/reorder", { mailboxId, ruleIds: [ruleId] });
step("reorder", reordered.status === 200 && reordered.json?.rules?.[0]?.id === ruleId, `status=${reordered.status}`);

// ---- Templates via REST ----
const template = await api("POST", "/api/mailbox-templates", { mailboxId, name: "Greeting", subject: "Hello", body: "<p>Hi there</p>" });
step("create template", template.status === 201 && template.json?.template?.name === "Greeting", `status=${template.status}`);
const templateId = template.json?.template?.id;
const templateUpdated = await api("PATCH", `/api/mailbox-templates/${templateId}`, { mailboxId, subject: null });
step("update template clears subject", templateUpdated.status === 200 && templateUpdated.json?.template?.subject === "", `status=${templateUpdated.status}`);

// ---- Saved searches via REST ----
const search = await api("POST", "/api/saved-searches", { mailboxId, name: "Spikes", query: "subject:spike" });
step("create saved search", search.status === 201 && search.json?.search?.query === "subject:spike", `status=${search.status}`);
const searchId = search.json?.search?.id;

// ---- Mute via REST ----
const muted = await api("POST", "/api/threads/mute", { mailboxId, threadId: "spike-message-1" });
step("mute thread by message id", muted.status === 200 && muted.json?.muted === true, `status=${muted.status}`);
const unmuted = await api("DELETE", `/api/threads/mute?mailboxId=${mailboxId}&threadId=spike-message-1`);
step("unmute thread", unmuted.status === 200 && unmuted.json?.muted === false, `status=${unmuted.status}`);

// ---- MCP key + tools ----
const keyResponse = await api("POST", "/api/agent/mcp-keys", { name: "organize", mailboxIds: [mailboxId], scopes: ["mcp:read", "mcp:organize"] });
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

await mcp("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "organize-e2e", version: "0" } }, 1);
await fetch(BASE + "/mcp", { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", Authorization: `Bearer ${mcpKey}`, ...(mcpSession ? { "mcp-session-id": mcpSession } : {}) }, body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) });

const tools = await mcp("tools/list", {}, 2);
const toolNames = (tools?.result?.tools ?? []).map((tool) => tool.name);
const expected = ["list_rules", "create_rule", "update_rule", "delete_rule", "preview_rule", "apply_rule", "reorder_rules", "list_templates", "create_template", "update_template", "delete_template", "list_saved_searches", "create_saved_search", "update_saved_search", "delete_saved_search", "mute_thread", "unmute_thread"];
step("MCP exposes all 17 organize tools", expected.every((name) => toolNames.includes(name)), `missing: ${expected.filter((name) => !toolNames.includes(name)).join(",") || "none"}`);

const mcpRule = await call("create_rule", { mailboxId, name: "Via MCP", match: { mode: "all", conditions: { from_contains: "alice" } }, actions: { star: true } }, 3);
step("MCP create_rule", !mcpRule.isError && mcpRule.body?.rule?.name === "Via MCP", JSON.stringify(mcpRule.body)?.slice(0, 120));

const mcpOutbound = await call("create_rule", { mailboxId, name: "Sneaky", match: { mode: "all", conditions: { from_contains: "alice" } }, actions: { forward_to: "evil@example.org" } }, 4);
step("MCP rule cannot send", mcpOutbound.isError === true && /operator-only/.test(mcpOutbound.body?.error ?? ""), JSON.stringify(mcpOutbound.body)?.slice(0, 140));

const mcpTemplate = await call("create_template", { mailboxId, name: "MCP snippet", body: "<p>yo</p>" }, 5);
step("MCP create_template", !mcpTemplate.isError && mcpTemplate.body?.template?.name === "MCP snippet", JSON.stringify(mcpTemplate.body)?.slice(0, 120));

const mcpSearch = await call("create_saved_search", { mailboxId, name: "MCP search", query: "from:alice" }, 6);
step("MCP create_saved_search", !mcpSearch.isError && mcpSearch.body?.search?.name === "MCP search", JSON.stringify(mcpSearch.body)?.slice(0, 120));

const mcpMute = await call("mute_thread", { mailboxId, threadId: "spike-message-1" }, 7);
step("MCP mute_thread", !mcpMute.isError && mcpMute.body?.muted === true, JSON.stringify(mcpMute.body)?.slice(0, 80));
const mcpUnmute = await call("unmute_thread", { mailboxId, threadId: "spike-message-1" }, 8);
step("MCP unmute_thread", !mcpUnmute.isError && mcpUnmute.body?.muted === false, JSON.stringify(mcpUnmute.body)?.slice(0, 80));

// ---- Cleanup via REST ----
const ruleDeleted = await api("DELETE", `/api/rules/${ruleId}?mailboxId=${mailboxId}`);
step("delete rule", ruleDeleted.status === 200, `status=${ruleDeleted.status}`);
const templateDeleted = await api("DELETE", `/api/mailbox-templates/${templateId}?mailboxId=${mailboxId}`);
step("delete template", templateDeleted.status === 200, `status=${templateDeleted.status}`);
const searchDeleted = await api("DELETE", `/api/saved-searches/${searchId}?mailboxId=${mailboxId}`);
step("delete saved search", searchDeleted.status === 200, `status=${searchDeleted.status}`);

const failed = results.filter((result) => !result.ok);
console.log(`\n${results.length - failed.length}/${results.length} steps passed`);
if (failed.length) { console.log("FAILED:", failed.map((f) => f.name).join("; ")); process.exit(1); }
console.log("ORGANIZE E2E OK");