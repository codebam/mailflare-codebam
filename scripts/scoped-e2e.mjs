// Phase 2b E2E: /api/v1/scoped/<tool> with ain1/ain2 tokens (mobile contract).
const BASE = process.env.MAILFLARE_E2E_URL || "http://127.0.0.1:3100";
let cookie = "";
const results = [];
const step = (name, ok, extra = "") => { results.push({ name, ok }); console.log(`${ok ? "PASS" : "FAIL"} ${name}${extra ? " — " + extra : ""}`); if (!ok) process.exitCode = 1; };

async function api(method, path, body, bearer) {
	const response = await fetch(BASE + path, {
		method,
		headers: { "Content-Type": "application/json", "Sec-Fetch-Site": "same-origin", Origin: BASE, ...(cookie ? { Cookie: cookie } : {}), ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}) },
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

// ---- Issue tokens ----
const ain1 = await api("POST", "/api/scoped-tokens", { kind: "mailbox", mailboxId, name: "e2e-phone", scopes: ["read", "draft", "manage"] });
step("issue ain1 mailbox token", ain1.status === 201 && ain1.json?.token?.startsWith("ain1_"), `status=${ain1.status}`);
const mailboxToken = ain1.json?.token;
const ain2 = await api("POST", "/api/scoped-tokens", { kind: "app", name: "e2e-app", scopes: ["read", "manage"] });
step("issue ain2 app token (admin)", ain2.status === 201 && ain2.json?.token?.startsWith("ain2_"), `status=${ain2.status}`);
const appToken = ain2.json?.token;

// ---- Mailbox token calls (mailboxId implicit) ----
const listed = await api("POST", "/api/v1/scoped/list_emails", { folder: "inbox", limit: 5 }, mailboxToken);
step("scoped list_emails without mailboxId", listed.status === 200 && listed.json?.emails?.some((email) => email.id === "spike-message-1"), `status=${listed.status} ${listed.text.slice(0, 100)}`);
const starred = await api("POST", "/api/v1/scoped/star_email", { emailId: "spike-message-1", starred: true }, mailboxToken);
step("scoped star_email", starred.status === 200 && starred.json?.starred === true, `status=${starred.status}`);
const unstarred = await api("POST", "/api/v1/scoped/star_email", { emailId: "spike-message-1", starred: false }, mailboxToken);
step("scoped unstar", unstarred.status === 200, `status=${unstarred.status}`);
const draft = await api("POST", "/api/v1/scoped/create_draft", { to: "x@example.org", subject: "Scoped draft", bodyHtml: "<p>hi</p>" }, mailboxToken);
step("scoped create_draft", draft.status === 200 && !!draft.json?.draftId, `status=${draft.status} ${draft.text.slice(0, 80)}`);
if (draft.json?.draftId) await api("POST", "/api/v1/scoped/discard_draft", { draftId: draft.json.draftId }, mailboxToken);

// ---- Binding and scope enforcement ----
const wrongMailbox = await api("POST", "/api/v1/scoped/list_emails", { mailboxId: "mbx_someone_else" }, mailboxToken);
step("mailbox token cannot name another mailbox", wrongMailbox.status === 403, `status=${wrongMailbox.status}`);
const noSend = await api("POST", "/api/v1/scoped/send_email", { to: "x@example.org", subject: "s", bodyHtml: "b" }, mailboxToken);
step("missing send scope refused", noSend.status === 403 && /send/.test(noSend.json?.error ?? ""), `status=${noSend.status}`);
const allWithMailboxToken = await api("POST", "/api/v1/scoped/list_all_emails", {}, mailboxToken);
step("all-mailbox tool refused for ain1", allWithMailboxToken.status === 403, `status=${allWithMailboxToken.status}`);
const unknownTool = await api("POST", "/api/v1/scoped/not_a_tool", {}, mailboxToken);
step("unknown tool 404", unknownTool.status === 404, `status=${unknownTool.status}`);
const badAuth = await api("POST", "/api/v1/scoped/list_emails", {}, "ain2_invalidinvalidinvalidinvalidinvalidinvalidin");
step("invalid token 401", badAuth.status === 401, `status=${badAuth.status}`);

// ---- App token calls ----
const appMailboxes = await api("POST", "/api/v1/scoped/list_mailboxes", {}, appToken);
step("app token list_mailboxes", appMailboxes.status === 200 && Array.isArray(appMailboxes.json) && appMailboxes.json.some((mailbox) => mailbox.id === mailboxId), `status=${appMailboxes.status} ${appMailboxes.text.slice(0, 80)}`);
const appAll = await api("POST", "/api/v1/scoped/list_all_emails", { limit: 5 }, appToken);
step("app token list_all_emails", appAll.status === 200 && Array.isArray(appAll.json?.emails), `status=${appAll.status}`);
const appSearch = await api("POST", "/api/v1/scoped/search_all_mailboxes", { query: "spike" }, appToken);
step("app token search_all_mailboxes", appSearch.status === 200 && appSearch.json?.emails?.length >= 1, `status=${appSearch.status}`);
const appNoMailbox = await api("POST", "/api/v1/scoped/list_emails", {}, appToken);
step("app token mailbox tool needs mailboxId", appNoMailbox.status === 400, `status=${appNoMailbox.status}`);
const appScoped = await api("POST", "/api/v1/scoped/list_emails", { mailboxId, folder: "inbox" }, appToken);
step("app token with mailboxId", appScoped.status === 200 && Array.isArray(appScoped.json?.emails), `status=${appScoped.status}`);

// ---- Revocation ----
const revoked = await api("DELETE", `/api/scoped-tokens?id=${ain1.json?.id}`);
step("revoke token", revoked.status === 200, `status=${revoked.status}`);
const afterRevoke = await api("POST", "/api/v1/scoped/list_emails", {}, mailboxToken);
step("revoked token 401", afterRevoke.status === 401, `status=${afterRevoke.status}`);
await api("DELETE", `/api/scoped-tokens?id=${ain2.json?.id}`);

const failed = results.filter((result) => !result.ok);
console.log(`\n${results.length - failed.length}/${results.length} steps passed`);
if (failed.length) { console.log("FAILED:", failed.map((f) => f.name).join("; ")); process.exit(1); }
console.log("SCOPED E2E OK");