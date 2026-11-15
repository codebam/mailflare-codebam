import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = mkdtempSync(join(root, "tests", ".tmp-semantic-"));
after(() => rmSync(outDir, { recursive: true, force: true }));

await build({
	entryPoints: {
		semantic: join(root, "src/lib/semantic/service.ts"),
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
const semantic = await load("semantic");
const { getDb } = await load("db");
const { SqliteDatabase } = await load("database");
const { applyMigrations } = await load("migrate");

// Deterministic fake embedder: keyword axes.
const fakeEmbedder = {
	model: "fake-model",
	embed: async (texts) => texts.map((text) => [text.includes("cat") ? 1 : 0, text.includes("dog") ? 1 : 0, 0.1]),
};

async function createFixture(t) {
	const database = new SqliteDatabase(join(outDir, `${crypto.randomUUID()}.sqlite`));
	t.after(() => database.db.close());
	await applyMigrations(database, join(root, "drizzle/migrations"));
	database.db.exec("PRAGMA foreign_keys = ON");
	database.db.prepare("INSERT INTO users (id, email, name, password_hash, created_at) VALUES ('u1', 'kevin@example.com', 'Kevin', 'x', 0)").run();
	database.db.prepare("INSERT INTO domains (id, user_id, hostname, zone_id, created_at) VALUES ('d1', 'u1', 'example.com', 'z1', 0)").run();
	database.db.prepare("INSERT INTO mailboxes (id, user_id, domain_id, local_part, created_at) VALUES ('mb1', 'u1', 'd1', 'kevin', 0)").run();
	database.db.prepare("INSERT INTO mailboxes (id, user_id, domain_id, local_part, created_at) VALUES ('mb2', 'u1', 'd1', 'other', 0)").run();
	const insert = database.db.prepare("INSERT INTO messages (id, user_id, mailbox_id, direction, from_addr, to_addr, subject, text_body, status, created_at) VALUES (?, 'u1', ?, 'inbound', 'a@b.c', 'k@e.c', ?, ?, 'received', ?)");
	insert.run("m1", "mb1", "Cat story", "A story about a cat", 100);
	insert.run("m2", "mb1", "Dog story", "A story about a dog", 200);
	insert.run("m3", "mb1", "Bird story", "A story about a bird", 300);
	insert.run("m4", "mb2", "Other cat", "Another cat elsewhere", 400);
	return { db: getDb({ DB: database }), raw: database.db };
}

test("resolveEmbedder: none, Workers AI, OpenAI-compatible", () => {
	assert.equal(semantic.resolveEmbedder({}), null);
	assert.equal(semantic.resolveEmbedder(null), null);
	const workers = semantic.resolveEmbedder({ AI: { run: async () => ({ data: [[1, 0]] }) } });
	assert.equal(workers.model, semantic.SEMANTIC_EMBEDDING_MODEL);
	const openai = semantic.resolveEmbedder({ AI_BASE_URL: "https://api.example.com/v1/", AI_API_KEY: "k", AI_EMBEDDING_MODEL: "custom-embed" });
	assert.equal(openai.model, "custom-embed");
});

test("cosineSimilarity and embeddingSource bounds", () => {
	assert.equal(semantic.cosineSimilarity([1, 0], [1, 0]), 1);
	assert.equal(semantic.cosineSimilarity([1, 0], [0, 1]), 0);
	assert.equal(semantic.cosineSimilarity([0, 0], [1, 0]), 0);
	assert.equal(semantic.embeddingSource("s", "x".repeat(9000), null).length, semantic.MAX_EMBEDDING_SOURCE_CHARS);
	assert.ok(semantic.embeddingSource("s", null, "<p>html body</p>").includes("html body"));
});

test("reindexBatch is bounded, idempotent and hash-aware", async (t) => {
	const { db, raw } = await createFixture(t);
	const first = await semantic.reindexBatch(db, "mb1", fakeEmbedder, 2);
	assert.equal(first.indexed, 2);
	assert.equal(first.remaining, 1);
	const second = await semantic.reindexBatch(db, "mb1", fakeEmbedder, 2);
	assert.equal(second.indexed, 1);
	assert.equal(second.remaining, 0);
	const third = await semantic.reindexBatch(db, "mb1", fakeEmbedder, 2);
	assert.deepEqual(third, { indexed: 0, remaining: 0 });
	assert.equal(raw.prepare("SELECT count(*) AS n FROM message_embeddings").get().n, 3); // mb2 untouched
	// Changed content is re-embedded.
	raw.prepare("UPDATE messages SET text_body = 'now about a cat' WHERE id = 'm3'").run();
	const fourth = await semantic.reindexBatch(db, "mb1", fakeEmbedder, 5);
	assert.equal(fourth.indexed, 1);
});

test("semanticSearch ranks by meaning and stays mailbox-scoped", async (t) => {
	const { db } = await createFixture(t);
	await semantic.reindexBatch(db, "mb1", fakeEmbedder, 25);
	const results = await semantic.semanticSearch(db, "mb1", "cat", fakeEmbedder, 5);
	assert.equal(results[0].id, "m1");
	assert.ok(results[0].score > results[results.length - 1].score);
	assert.ok(!results.some((result) => result.id === "m4"));
	assert.ok(results[0].snippet.includes("cat"));
	assert.deepEqual(await semantic.semanticSearch(db, "mb1", "   ", fakeEmbedder), []);
});

test("indexMessageBestEffort no-ops without an embedder", async (t) => {
	const { db, raw } = await createFixture(t);
	await semantic.indexMessageBestEffort(db, {}, "mb1", "m1");
	assert.equal(raw.prepare("SELECT count(*) AS n FROM message_embeddings").get().n, 0);
	await semantic.indexMessageBestEffort(db, { AI: { run: async () => ({ data: [[1, 0, 0]] }) } }, "mb1", "m1");
	assert.equal(raw.prepare("SELECT count(*) AS n FROM message_embeddings").get().n, 1);
});