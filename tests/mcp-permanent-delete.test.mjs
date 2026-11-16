import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = mkdtempSync(join(root, "tests", ".tmp-mcp-permanent-delete-"));
after(() => rmSync(outDir, { recursive: true, force: true }));

// The real delete_email handler runs against a recording MCP server and a
// migrated SQLite database with foreign keys enforced, exactly as shipped.
await build({
	entryPoints: {
		actions: join(root, "src/lib/mcp/compat-actions.ts"),
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
	plugins: [{
		name: "mcp-mock",
		setup(builder) {
			builder.onResolve({ filter: /^@modelcontextprotocol\/server$/ }, () => ({ path: "mcp", namespace: "mock" }));
			builder.onLoad({ filter: /.*/, namespace: "mock" }, () => ({
				contents: `export class McpServer { constructor() { this.tools = new Map(); } registerTool(name, config, handler) { this.tools.set(name, handler); } }`,
				loader: "js",
			}));
		},
	}],
});

const load = (name) => import(pathToFileURL(join(outDir, `${name}.mjs`)).href);
const { registerCompatActionTools } = await load("actions");
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
	const addMessage = (id, status, threadId = null) => database.db.prepare(
		"INSERT INTO messages (id, user_id, mailbox_id, direction, from_addr, to_addr, subject, status, read, starred, thread_id, created_at) VALUES (?, 'u1', 'mb1', 'inbound', 'a@b.c', 'kevin@example.com', ?, ?, 0, 0, ?, 100)",
	).run(id, `Subject ${id}`, status, threadId);
	const server = { tools: new Map(), registerTool(name, config, handler) { this.tools.set(name, handler); } };
	const env = { DB: database, BUCKET: { delete: async () => {} } };
	registerCompatActionTools(server, { keyId: "k1", user: { id: "u1", role: "user" }, scopes: ["mcp:organize"], mailboxIds: ["mb1"] }, env);
	const call = async (name, args) => {
		const result = await server.tools.get(name)(args);
		return { data: JSON.parse(result.content[0].text), isError: !!result.isError };
	};
	return { raw: database.db, db: getDb({ DB: database }), addMessage, call };
}

test("bulk permanent delete from trash succeeds and keeps a metadata-only log row per message", async (t) => {
	const { raw, addMessage, call } = await createFixture(t);
	addMessage("m1", "trash", "t1");
	addMessage("m2", "trash");
	// The mobile app's bulk delete: one permanent delete_email per selection.
	for (const emailId of ["m1", "m2"]) {
		const result = await call("delete_email", { mailboxId: "mb1", emailId, permanent: true, confirm: true });
		assert.equal(result.isError, false, `permanent delete of ${emailId} must not error: ${JSON.stringify(result.data)}`);
		assert.deepEqual(result.data, { emailId, deleted: true, permanent: true });
	}
	assert.equal(raw.prepare("SELECT count(*) AS n FROM messages WHERE id IN ('m1', 'm2')").get().n, 0);
	const log = raw.prepare("SELECT tool, message_id, subject, thread_key, undoable FROM agent_actions ORDER BY id").all();
	assert.equal(log.length, 2);
	for (const row of log) {
		assert.equal(row.tool, "delete_email");
		assert.equal(row.message_id, null, "ON DELETE SET NULL keeps the log row after the message is gone");
		assert.equal(row.undoable, 0);
	}
	assert.deepEqual(log.map((row) => row.subject), ["Subject m1", "Subject m2"]);
	assert.equal(log[0].thread_key, "t1");
});

test("permanent delete without confirm refuses and deletes nothing", async (t) => {
	const { raw, addMessage, call } = await createFixture(t);
	addMessage("m1", "trash");
	const result = await call("delete_email", { mailboxId: "mb1", emailId: "m1", permanent: true });
	assert.equal(result.isError, true);
	assert.equal(raw.prepare("SELECT count(*) AS n FROM messages WHERE id = 'm1'").get().n, 1);
	assert.equal(raw.prepare("SELECT count(*) AS n FROM agent_actions").get().n, 0);
});

test("soft delete still moves to trash and records the live message reference", async (t) => {
	const { raw, addMessage, call } = await createFixture(t);
	addMessage("m1", "received");
	const result = await call("delete_email", { mailboxId: "mb1", emailId: "m1" });
	assert.equal(result.isError, false);
	assert.deepEqual(result.data, { emailId: "m1", deleted: true, permanent: false });
	assert.equal(raw.prepare("SELECT status FROM messages WHERE id = 'm1'").get().status, "trash");
	const [row] = raw.prepare("SELECT tool, message_id, undoable FROM agent_actions").all();
	assert.equal(row.tool, "delete_email");
	assert.equal(row.message_id, "m1");
	assert.equal(row.undoable, 0);
});
