// Phase 1c E2E: sender policy, EML export, storage, catch-all — REST + MCP.
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
db.exec("DELETE FROM sender_policies; DELETE FROM mcp_key_mailboxes WHERE key_id IN (SELECT id FROM api_keys WHERE name = 'pipeline'); DELETE FROM api_keys WHERE name = 'pipeline';");
const domainId = db.prepare("SELECT id FROM domains LIMIT 1").get().id;
// Clean prior catch-all artifacts for idempotent reruns.
db.exec("DELETE FROM routing_rules WHERE name = 'Catch-all'; DELETE FROM mailboxes WHERE local_part = 'catch-all';");
db.close();

// ---- Sender policy REST ----
const set = await api("POST", "/api/sender-policy", { mailboxId, address: "Alice <alice@example.org>", policy: "block" });
step("set sender policy (normalized)", set.status === 201 && set.json?.entry?.address === "alice@example.org", `status=${set.status}`);
const list = await api("GET", `/api/sender-policy?mailboxId=${mailboxId}`);
step("list sender policies", list.status === 200 && list.json?.entries?.length === 1, `status=${list.status}`);
const remove = await api("DELETE", `/api/sender-policy?mailboxId=${mailboxId}&address=alice@example.org`);
step("remove sender policy", remove.status === 200, `status=${remove.status}`);

// ---- EML + storage REST ----
const eml = await api("GET", "/api/messages/spike-message-1/eml");
step("EML export", eml.status === 200 && eml.json?.eml?.includes("From: alice@example.org") && eml.json?.eml?.includes("Subject: Spike test"), `status=${eml.status}`);
const storage = await api("GET", `/api/storage?mailboxId=${mailboxId}`);
step("storage stats", storage.status === 200 && storage.json?.messages >= 1 && typeof storage.json?.attachments?.bytes === "number", `status=${storage.status} ${JSON.stringify(storage.json)}`);

// ---- Catch-all REST ----
const catchAll = await api("POST", "/api/catch-all", { domainId });
step("catch-all provisioned", (catchAll.status === 201 || catchAll.status === 200) && catchAll.json?.address === "catch-all@spike.local", `status=${catchAll.status} ${catchAll.text.slice(0, 120)}`);
const catchAllAgain = await api("POST", "/api/catch-all", { domainId });
step("catch-all idempotent", catchAllAgain.status === 200 && catchAllAgain.json?.created === false, `status=${catchAllAgain.status}`);

// ---- MCP ----
const keyResponse = await api("POST", "/api/agent/mcp-keys", { name: "pipeline", mailboxIds: [mailboxId], scopes: ["mcp:read", "mcp:organize"] });
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
await mcp("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "pipeline-e2e", version: "0" } }, 1);
await fetch(BASE + "/mcp", { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", Authorization: `Bearer ${mcpKey}`, ...(mcpSession ? { "mcp-session-id": mcpSession } : {}) }, body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) });

const tools = await mcp("tools/list", {}, 2);
const toolNames = (tools?.result?.tools ?? []).map((tool) => tool.name);
const expected = ["get_sender_policy", "set_sender_policy", "remove_sender_policy", "export_email", "get_storage"];
step("MCP exposes pipeline tools", expected.every((name) => toolNames.includes(name)), `missing: ${expected.filter((name) => !toolNames.includes(name)).join(",") || "none"}`);

const mcpSet = await call("set_sender_policy", { mailboxId, emailId: "spike-message-1", action: "allow" }, 3);
step("MCP set_sender_policy from email", !mcpSet.isError && mcpSet.body?.entry?.address === "alice@example.org" && mcpSet.body?.entry?.policy === "allow", JSON.stringify(mcpSet.body)?.slice(0, 120));
const mcpGet = await call("get_sender_policy", { mailboxId }, 4);
step("MCP get_sender_policy", !mcpGet.isError && mcpGet.body?.entries?.length === 1, JSON.stringify(mcpGet.body)?.slice(0, 120));
const mcpRemove = await call("remove_sender_policy", { mailboxId, address: "alice@example.org" }, 5);
step("MCP remove_sender_policy", !mcpRemove.isError && mcpRemove.body?.removed === true, JSON.stringify(mcpRemove.body)?.slice(0, 80));
const mcpEml = await call("export_email", { mailboxId, emailId: "spike-message-1" }, 6);
step("MCP export_email", !mcpEml.isError && mcpEml.body?.eml?.includes("Subject: Spike test"), JSON.stringify(mcpEml.body)?.slice(0, 80));
const mcpStorage = await call("get_storage", { mailboxId }, 7);
step("MCP get_storage", !mcpStorage.isError && mcpStorage.body?.messages >= 1, JSON.stringify(mcpStorage.body)?.slice(0, 100));
const mcpSemantic = await call("semantic_search", { mailboxId, query: "spike" }, 8);
step("MCP semantic_search not-configured contract", mcpSemantic.isError === true && /not configured/i.test(mcpSemantic.body?.error ?? ""), JSON.stringify(mcpSemantic.body)?.slice(0, 120));
const semanticRest = await api("POST", "/api/semantic/search", { mailboxId, query: "spike" });
step("REST semantic not-configured 503", semanticRest.status === 503 && semanticRest.json?.code === "SEMANTIC_NOT_CONFIGURED", `status=${semanticRest.status}`);

const failed = results.filter((result) => !result.ok);
console.log(`\n${results.length - failed.length}/${results.length} steps passed`);
if (failed.length) { console.log("FAILED:", failed.map((f) => f.name).join("; ")); process.exit(1); }
console.log("PIPELINE E2E OK");