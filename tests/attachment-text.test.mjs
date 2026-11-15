import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { and, eq } from "drizzle-orm";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = mkdtempSync(join(root, "tests", ".tmp-attachment-text-"));
after(() => rmSync(outDir, { recursive: true, force: true }));

await build({
	entryPoints: {
		extract: join(root, "src/lib/email/attachment-text.ts"),
		conditions: join(root, "src/lib/search/conditions.ts"),
		schema: join(root, "src/db/schema/index.ts"),
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
const extract = await load("extract");
const conditions = await load("conditions");
const { messages } = await load("schema");
const { getDb } = await load("db");
const { SqliteDatabase } = await load("database");
const { applyMigrations } = await load("migrate");

const encode = (text) => new TextEncoder().encode(text).buffer;

async function createFixture(t) {
	const database = new SqliteDatabase(join(outDir, `${crypto.randomUUID()}.sqlite`));
	t.after(() => database.db.close());
	await applyMigrations(database, join(root, "drizzle/migrations"));
	database.db.exec("PRAGMA foreign_keys = ON");
	database.db.prepare("INSERT INTO users (id, email, name, password_hash, created_at) VALUES ('u1', 'kevin@example.com', 'Kevin', 'x', 0)").run();
	database.db.prepare("INSERT INTO domains (id, user_id, hostname, zone_id, created_at) VALUES ('d1', 'u1', 'example.com', 'z1', 0)").run();
	database.db.prepare("INSERT INTO mailboxes (id, user_id, domain_id, local_part, created_at) VALUES ('mb1', 'u1', 'd1', 'kevin', 0)").run();
	database.db.prepare("INSERT INTO messages (id, user_id, mailbox_id, direction, from_addr, to_addr, subject, status, created_at) VALUES ('m1', 'u1', 'mb1', 'inbound', 'a@b.c', 'kevin@example.com', 'Plain subject', 'received', 100)").run();
	database.db.prepare("INSERT INTO message_attachments (id, message_id, filename, content_type, size, r2_key, created_at) VALUES ('a1', 'm1', 'notes.txt', 'text/plain', 10, 'k1', 0)").run();
	return { db: getDb({ DB: database }), raw: database.db };
}

test("extractAttachmentText decodes text-ish files, strips HTML, skips the rest", () => {
	assert.equal(extract.extractAttachmentText("n.txt", "text/plain", encode("hello world")), "hello world");
	assert.equal(extract.extractAttachmentText("d.json", "application/json", encode('{"a":1}')), '{"a":1}');
	assert.equal(extract.extractAttachmentText("p.html", "text/html", encode("<p>Hello <b>world</b></p><script>evil()</script>")), "Hello world");
	assert.equal(extract.extractAttachmentText("code.rs", "application/octet-stream", encode("fn main() {}")), "fn main() {}");
	assert.equal(extract.extractAttachmentText("img.png", "image/png", encode("binary")), null);
	assert.equal(extract.extractAttachmentText("doc.pdf", "application/pdf", encode("pdf")), null);
	assert.equal(extract.extractAttachmentText("empty.txt", "text/plain", encode("")), null);
	assert.equal(extract.extractAttachmentText("big.txt", "text/plain", new ArrayBuffer(extract.MAX_ATTACHMENT_TEXT_INPUT_BYTES + 1)), null);
	assert.equal(extract.extractAttachmentText("long.txt", "text/plain", encode("x".repeat(extract.MAX_ATTACHMENT_TEXT_CHARS + 500))).length, extract.MAX_ATTACHMENT_TEXT_CHARS);
});

test("storeAttachmentTexts writes index-aligned rows and search matches them", async (t) => {
	const { db, raw } = await createFixture(t);
	const stored = [{ id: "a1", messageId: "m1", filename: "notes.txt", type: "text/plain" }];
	const sources = [{ filename: "notes.txt", type: "text/plain", content: encode("the zebrafinch manuscript") }];
	assert.equal(await extract.storeAttachmentTexts(db, stored, sources), 1);
	assert.equal(raw.prepare("SELECT count(*) AS n FROM attachment_texts").get().n, 1);
	// FTS trigger populated the index: a term only in the attachment matches the message.
	const found = await db.select({ id: messages.id }).from(messages).where(and(eq(messages.mailboxId, "mb1"), ...conditions.buildSearchConditions("zebrafinch")));
	assert.deepEqual(found.map((row) => row.id), ["m1"]);
	// A term in neither subject nor attachment matches nothing.
	const absent = await db.select({ id: messages.id }).from(messages).where(and(eq(messages.mailboxId, "mb1"), ...conditions.buildSearchConditions("quokkasaurus")));
	assert.deepEqual(absent, []);
	// Deleting the attachment cascades its text and the FTS row.
	raw.prepare("DELETE FROM message_attachments WHERE id = 'a1'").run();
	assert.equal(raw.prepare("SELECT count(*) AS n FROM attachment_texts").get().n, 0);
	const afterDelete = await db.select({ id: messages.id }).from(messages).where(and(eq(messages.mailboxId, "mb1"), ...conditions.buildSearchConditions("zebrafinch")));
	assert.deepEqual(afterDelete, []);
});

test("field operators still search messages only", async (t) => {
	const { db } = await createFixture(t);
	await extract.storeAttachmentTexts(db, [{ id: "a1", messageId: "m1", filename: "notes.txt", type: "text/plain" }], [{ filename: "notes.txt", type: "text/plain", content: encode("zebrafinch") }]);
	const bySubject = await db.select({ id: messages.id }).from(messages).where(and(eq(messages.mailboxId, "mb1"), ...conditions.buildSearchConditions("subject:Plain")));
	assert.deepEqual(bySubject.map((row) => row.id), ["m1"]);
	const subjectMiss = await db.select({ id: messages.id }).from(messages).where(and(eq(messages.mailboxId, "mb1"), ...conditions.buildSearchConditions("subject:zebrafinch")));
	assert.deepEqual(subjectMiss, []);
});