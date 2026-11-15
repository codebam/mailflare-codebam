import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = mkdtempSync(join(root, "tests", ".tmp-mail-pipeline-"));
after(() => rmSync(outDir, { recursive: true, force: true }));

await build({
	entryPoints: {
		senderPolicy: join(root, "src/lib/sender-policy/service.ts"),
		senderUtils: join(root, "src/lib/sender-policy/sender-policy-utils.ts"),
		eml: join(root, "src/lib/eml-export/service.ts"),
		emlUtils: join(root, "src/lib/eml-export/eml-utils.ts"),
		storage: join(root, "src/lib/storage/service.ts"),
		delivery: join(root, "src/lib/email/delivery-report.ts"),
		catchAll: join(root, "src/lib/catch-all/service.ts"),
		outbound: join(root, "src/lib/rules/outbound.ts"),
		db: join(root, "src/db/index.ts"),
		database: join(root, "server/runtime/sqlite-database.ts"),
		migrate: join(root, "server/runtime/migrate.ts"),
	},
	outdir: outDir,
	outExtension: { ".js": ".mjs" },
	bundle: true,
	platform: "node",
	format: "esm",
	target: "node22",
	tsconfig: join(root, "tsconfig.json"),
	external: ["better-sqlite3", "drizzle-orm", "drizzle-orm/*"],
	logLevel: "silent",
});

const load = (name) => import(pathToFileURL(join(outDir, `${name}.mjs`)).href);
const senderPolicy = await load("senderPolicy");
const senderUtils = await load("senderUtils");
const eml = await load("eml");
const emlUtils = await load("emlUtils");
const storage = await load("storage");
const delivery = await load("delivery");
const catchAll = await load("catchAll");
const outbound = await load("outbound");
const { getDb } = await load("db");
const { SqliteDatabase } = await load("database");
const { applyMigrations } = await load("migrate");

async function createFixture(t) {
	const database = new SqliteDatabase(join(outDir, `${crypto.randomUUID()}.sqlite`));
	t.after(() => database.db.close());
	await applyMigrations(database, join(root, "drizzle/migrations"));
	database.db.exec("PRAGMA foreign_keys = ON");
	database.db.prepare("INSERT INTO users (id, email, name, password_hash, created_at) VALUES ('u1', 'kevin@example.com', 'Kevin', 'x', 0)").run();
	database.db.prepare("INSERT INTO domains (id, user_id, hostname, zone_id, created_at) VALUES ('d1', 'u1', 'example.com', 'z1', 0)").run();
	database.db.prepare("INSERT INTO mailboxes (id, user_id, domain_id, local_part, created_at) VALUES ('mb1', 'u1', 'd1', 'kevin', 0)").run();
	database.db.prepare("INSERT INTO mailboxes (id, user_id, domain_id, local_part, created_at) VALUES ('mb2', 'u1', 'd1', 'other', 0)").run();
	database.db.prepare("INSERT INTO messages (id, user_id, mailbox_id, direction, from_addr, to_addr, subject, status, created_at) VALUES ('m1', 'u1', 'mb1', 'inbound', 'Alice@Vendor.com', 'kevin@example.com', 'Hello', 'received', 100)").run();
	return { db: getDb({ DB: database }), raw: database.db };
}

// ---- sender policy ----

test("sender policy normalizes, upserts, lists and removes", async (t) => {
	const { db } = await createFixture(t);
	assert.equal(senderUtils.normalizeSenderAddress(" Alice <Alice@Vendor.com> "), "alice@vendor.com");
	const entry = await senderPolicy.setSenderPolicy(db, "mb1", "Alice <Alice@Vendor.com>", "block");
	assert.equal(entry.address, "alice@vendor.com");
	assert.equal(await senderPolicy.getSenderPolicy(db, "mb1", "ALICE@VENDOR.COM"), "block");
	await senderPolicy.setSenderPolicy(db, "mb1", "alice@vendor.com", "allow");
	assert.equal((await senderPolicy.listSenderPolicies(db, "mb1")).length, 1);
	assert.equal(await senderPolicy.getSenderPolicy(db, "mb1", "alice@vendor.com"), "allow");
	assert.equal(await senderPolicy.getSenderPolicy(db, "mb2", "alice@vendor.com"), null);
	await assert.rejects(senderPolicy.setSenderPolicy(db, "mb1", "not-an-address", "allow"), /valid sender/);
	await assert.rejects(senderPolicy.setSenderPolicy(db, "mb1", "a@b.com", "maybe"), /allow or block/);
	assert.equal(await senderPolicy.removeSenderPolicy(db, "mb1", "alice@vendor.com"), true);
	assert.equal(await senderPolicy.removeSenderPolicy(db, "mb1", "alice@vendor.com"), false);
});

// ---- EML export ----

test("reconstructedMessage quotes From lines and keeps stored headers", () => {
	const emlText = emlUtils.reconstructedMessage({ sender: "a@b.c", recipient: "d@e.f", cc: "g@h.i", date: "Sat, 15 Nov 2026 12:00:00 GMT", subject: "Hi", message_id: "<x@y>", body: "From here\nnormal line" });
	assert.ok(emlText.startsWith("From: a@b.c\nTo: d@e.f\nCc: g@h.i\n"));
	assert.ok(emlText.includes("Message-ID: <x@y>"));
	assert.ok(emlText.includes("\n>From here\nnormal line\n"));
});

test("exportEmail rebuilds from stored fields and is mailbox-scoped", async (t) => {
	const { db, raw } = await createFixture(t);
	raw.prepare("UPDATE messages SET text_body = 'body text', provider_message_id = '<m1@vendor>' WHERE id = 'm1'").run();
	const result = await eml.exportEmail(db, "mb1", "m1");
	assert.ok(result.eml.includes("From: Alice@Vendor.com"));
	assert.ok(result.eml.includes("Message-ID: <m1@vendor>"));
	assert.ok(result.eml.includes("body text"));
	assert.equal(await eml.exportEmail(db, "mb2", "m1"), null);
	assert.equal(await eml.exportEmail(db, "mb1", "missing"), null);
});

// ---- storage ----

test("storage counts messages and attachment bytes per mailbox", async (t) => {
	const { db, raw } = await createFixture(t);
	raw.prepare("INSERT INTO message_attachments (id, message_id, filename, content_type, size, r2_key, created_at) VALUES ('a1', 'm1', 'f.txt', 'text/plain', 1234, 'k1', 0)").run();
	raw.prepare("INSERT INTO message_attachments (id, message_id, filename, content_type, size, r2_key, created_at) VALUES ('a2', 'm1', 'g.pdf', 'application/pdf', 5000, 'k2', 0)").run();
	const stats = await storage.getMailboxStorage(db, "mb1");
	assert.equal(stats.messages, 1);
	assert.deepEqual(stats.attachments, { count: 2, bytes: 6234 });
	assert.deepEqual((await storage.getMailboxStorage(db, "mb2")).attachments, { count: 0, bytes: 0 });
});

// ---- delivery reports ----

const encode = (text) => new TextEncoder().encode(text).buffer;
const dsnParsed = ({ action = "failed", originalId = "<sent-1@example.com>", subject = "Original subject", recipient = "rcpt@dest.com" } = {}) => ({
	subject: "Returned mail", text: null, html: null, messageId: "<dsn@mailer>", fromAddr: "MAILER-DAEMON@example.com",
	toAddr: "kevin@example.com", ccAddr: null, bccAddr: null, replyTo: null, inReplyTo: null, references: [], date: new Date(),
	attachments: [
		{ filename: "details", type: "message/delivery-status", content: encode(`Reporting-MTA: dns; example.com\n\nFinal-Recipient: rfc822; ${recipient}\nAction: ${action}\nStatus: 5.1.1\nDiagnostic-Code: smtp; 550 no such user\n`) },
		{ filename: "headers", type: "text/rfc822-headers", content: encode(`Message-ID: ${originalId}\nSubject: ${subject}\n`) },
	],
});

test("parseDeliveryReport extracts action, recipient and original id", () => {
	assert.ok(delivery.isDeliveryReport(dsnParsed()));
	const report = delivery.parseDeliveryReport(dsnParsed());
	assert.equal(report.status, "failed");
	assert.equal(report.finalRecipient, "rcpt@dest.com");
	assert.equal(report.originalMessageId, "<sent-1@example.com>");
	assert.ok(report.detail.includes("5.1.1"));
	assert.equal(delivery.parseDeliveryReport(dsnParsed({ action: "delayed" })).status, "delayed");
	assert.equal(delivery.parseDeliveryReport(dsnParsed({ action: "delivered" })).status, "delivered");
	assert.equal(delivery.isDeliveryReport({ attachments: [] }), false);
});

test("applyDeliveryReport matches by provider Message-ID, then bounded fallback", async (t) => {
	const { db, raw } = await createFixture(t);
	const now = Math.floor(Date.now() / 1000);
	raw.prepare("INSERT INTO messages (id, user_id, mailbox_id, direction, from_addr, to_addr, subject, status, provider_message_id, created_at) VALUES ('s1', 'u1', 'mb1', 'outbound', 'kevin@example.com', 'rcpt@dest.com', 'Original subject', 'sent', '<sent-1@example.com>', ?)").run(now - 3600);
	const matched = await delivery.applyDeliveryReport(db, "mb1", dsnParsed());
	assert.ok(matched.matched);
	assert.equal(matched.messageId, "s1");
	assert.equal(raw.prepare("SELECT delivery_status FROM messages WHERE id = 's1'").get().delivery_status, "failed");
	// Fallback: no original id, subject + recipient within the window, exactly one.
	raw.prepare("INSERT INTO messages (id, user_id, mailbox_id, direction, from_addr, to_addr, subject, status, created_at) VALUES ('s2', 'u1', 'mb1', 'outbound', 'kevin@example.com', 'other@dest.com', 'Fallback subject', 'sent', ?)").run(now - 7200);
	const fallback = await delivery.applyDeliveryReport(db, "mb1", dsnParsed({ originalId: "<unknown@x>", subject: "Fallback subject", recipient: "other@dest.com" }));
	assert.ok(fallback.matched);
	assert.equal(fallback.messageId, "s2");
	// Ambiguity is a no-op: two candidates with the same subject + recipient.
	raw.prepare("INSERT INTO messages (id, user_id, mailbox_id, direction, from_addr, to_addr, subject, status, created_at) VALUES ('s3', 'u1', 'mb1', 'outbound', 'kevin@example.com', 'other@dest.com', 'Fallback subject', 'sent', ?)").run(now - 7300);
	const ambiguous = await delivery.applyDeliveryReport(db, "mb1", dsnParsed({ originalId: "<unknown@x>", subject: "Fallback subject", recipient: "other@dest.com" }));
	assert.equal(ambiguous.matched, false);
	// Non-DSN mail is untouched.
	assert.equal((await delivery.applyDeliveryReport(db, "mb1", { attachments: [] })).matched, false);
});

// ---- catch-all ----

test("catch-all provisions mailbox + store rule idempotently", async (t) => {
	const { db, raw } = await createFixture(t);
	const first = await catchAll.ensureCatchAllMailbox(db, "d1");
	assert.ok(first.created);
	assert.equal(first.address, "catch-all@example.com");
	const again = await catchAll.ensureCatchAllMailbox(db, "d1");
	assert.equal(again.created, false);
	assert.equal(again.mailboxId, first.mailboxId);
	assert.equal(raw.prepare("SELECT count(*) AS n FROM routing_rules WHERE scope = 'domain' AND pattern = '*'").get().n, 1);
	assert.equal(raw.prepare("SELECT count(*) AS n FROM mailboxes WHERE local_part = 'catch-all'").get().n, 1);
	await assert.rejects(catchAll.ensureCatchAllMailbox(db, "missing"), /Domain not found/);
});

// ---- rule outbound ----

test("isMachineGenerated detects auto-submitted, list and bulk mail", () => {
	assert.ok(outbound.isMachineGenerated({ "Auto-Submitted": "auto-replied" }));
	assert.ok(!outbound.isMachineGenerated({ "auto-submitted": "no" }));
	assert.ok(outbound.isMachineGenerated({ "List-Id": "<list.example.com>" }));
	assert.ok(outbound.isMachineGenerated({ Precedence: "bulk" }));
	assert.ok(!outbound.isMachineGenerated({ Precedence: "first-class" }));
	assert.ok(!outbound.isMachineGenerated(undefined));
});

test("executeRuleOutbound sends, dedups per sender, and honors guards", async (t) => {
	const { db } = await createFixture(t);
	const sent = [];
	const fakeSender = async (input) => { sent.push(input); return { messageId: `fake-${sent.length}` }; };
	const context = { mailboxId: "mb1", userId: "u1", mailboxAddress: "kevin@example.com", sender: "alice@vendor.com", subject: "Hello", text: "body", headers: {} };
	const actions = [
		{ kind: "forward", rule_id: "r1", rule_name: "F", to: "archive@elsewhere.com" },
		{ kind: "auto_reply", rule_id: "r2", rule_name: "A", text: "Out of office" },
	];
	const reports = await outbound.executeRuleOutbound(db, {}, context, actions, { sender: fakeSender });
	assert.deepEqual(reports.map((report) => report.status), ["sent", "sent"]);
	assert.equal(sent.length, 2);
	assert.equal(sent[0].subject, "Fwd: Hello");
	assert.equal(sent[1].subject, "Re: Hello");
	assert.equal(sent[1].to, "alice@vendor.com");
	// Second run within 24h: both deduped.
	const again = await outbound.executeRuleOutbound(db, {}, context, actions, { sender: fakeSender });
	assert.deepEqual(again.map((report) => report.status), ["skipped", "skipped"]);
	assert.equal(sent.length, 2);
	// Machine-generated mail: auto-reply skipped, forward still allowed for a new sender.
	const machine = await outbound.executeRuleOutbound(db, {}, { ...context, sender: "bot@vendor.com", headers: { "Auto-Submitted": "auto-generated" } }, actions, { sender: fakeSender });
	assert.deepEqual(machine.map((report) => report.status), ["sent", "skipped"]);
	// Self-sent mail: auto-reply skipped.
	const self = await outbound.executeRuleOutbound(db, {}, { ...context, sender: "kevin@example.com" }, [actions[1]], { sender: fakeSender });
	assert.equal(self[0].status, "skipped");
	// Spam/discard skip applies to everything.
	const skipped = await outbound.executeRuleOutbound(db, {}, { ...context, sender: "new@vendor.com" }, actions, { sender: fakeSender, skip: true });
	assert.deepEqual(skipped.map((report) => report.status), ["skipped", "skipped"]);
	// Invalid forward address is skipped, never sent.
	const bad = await outbound.executeRuleOutbound(db, {}, { ...context, sender: "another@vendor.com" }, [{ kind: "forward", rule_id: "r3", rule_name: "B", to: "not-an-address" }], { sender: fakeSender });
	assert.equal(bad[0].status, "skipped");
});

test("executeRuleOutbound enforces the hourly quota", async (t) => {
	const { db, raw } = await createFixture(t);
	const now = Math.floor(Date.now() / 1000);
	const insert = raw.prepare("INSERT INTO rule_outbound_log (id, mailbox_id, kind, sender, created_at) VALUES (?, 'mb1', 'forward', ?, ?)");
	for (let i = 0; i < 20; i += 1) insert.run(`log-${i}`, `sender-${i}@x.com`, now - 60);
	const sent = [];
	const reports = await outbound.executeRuleOutbound(db, {}, { mailboxId: "mb1", userId: "u1", mailboxAddress: "kevin@example.com", sender: "fresh@x.com", subject: "s", headers: {} }, [{ kind: "forward", rule_id: "r1", rule_name: "F", to: "a@b.com" }], { sender: async (input) => { sent.push(input); return { messageId: "x" }; } });
	assert.equal(reports[0].status, "skipped");
	assert.equal(reports[0].reason, "send quota exhausted");
	assert.equal(sent.length, 0);
});