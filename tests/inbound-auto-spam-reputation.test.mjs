import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

// A message the spam engine files into Spam must count against the sender, or
// a campaign domain that keeps arriving is only ever "seen" with a clean spam
// count and the filter never learns to penalize it.

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const directory = mkdtempSync(join(root, "node_modules", "mailflare-auto-spam-reputation-"));
after(() => rmSync(directory, { recursive: true, force: true }));
await build({
	stdin: {
		contents: `
			export { SqliteDatabase } from "./server/runtime/sqlite-database.ts";
			export { applyMigrations } from "./server/runtime/migrate.ts";
			export { intakeIncomingMail } from "./src/lib/email/intake.ts";
			export { processInboundMessage } from "./src/lib/email/inbound.ts";
		`,
		resolveDir: root,
		sourcefile: "auto-spam-reputation-entry.ts",
	},
	outfile: join(directory, "entry.mjs"),
	bundle: true,
	platform: "node",
	format: "esm",
	target: "node24",
	tsconfig: join(root, "tsconfig.json"),
	packages: "external",
	alias: { "cloudflare:workers": "./server/runtime/cloudflare-workers.ts" },
	logLevel: "silent",
});
const { SqliteDatabase, applyMigrations, intakeIncomingMail, processInboundMessage } =
	await import(pathToFileURL(join(directory, "entry.mjs")).href);

async function setup(t) {
	const database = new SqliteDatabase(":memory:");
	t.after(() => database.db.close());
	await applyMigrations(database, join(root, "drizzle/migrations"));
	database.db.exec(`
		INSERT INTO users (id, email, password_hash, name, role, is_primary_admin, created_at) VALUES ('admin', 'owner@one.test', 'hash', 'Owner', 'admin', 1, 1);
		INSERT INTO domains (id, user_id, hostname, zone_id, status, created_at) VALUES ('one', 'admin', 'one.test', 'z', 'active', 1);
		INSERT INTO mailboxes (id, user_id, domain_id, local_part, created_at) VALUES ('box', 'admin', 'one', 'me', 1);
	`);
	const objects = new Map();
	const queued = [];
	const env = {
		DB: database,
		BUCKET: {
			put: async (key, value) => { objects.set(key, value); },
			get: async (key) => objects.has(key) ? { arrayBuffer: async () => objects.get(key), text: async () => Buffer.from(objects.get(key)).toString() } : null,
			head: async (key) => objects.has(key) ? {} : null,
			delete: async (key) => { objects.delete(key); },
		},
		INBOUND_QUEUE: { send: async (payload) => { queued.push(payload); } },
	};
	const deliver = async (raw, from, headers = {}) => {
		const before = queued.length;
		const rawBytes = new TextEncoder().encode(raw);
		const result = await intakeIncomingMail(env, { from, to: "me@one.test", raw: rawBytes.buffer, headers }, { forward: async () => true });
		assert.equal(result.action, "store");
		assert.equal(queued.length, before + 1);
		await processInboundMessage(env, queued.at(-1));
		return database.db.prepare("SELECT status, spam_signals FROM messages ORDER BY created_at DESC, rowid DESC LIMIT 1").get();
	};
	return { database, env, deliver };
}

const SPAM_HEADERS = { "Reply-To": "help@other.example" };
const spamMime = (id) => `From: "Promo" <promo@campaign.example>\r
Reply-To: help@other.example\r
To: me@one.test\r
Message-ID: <${id}@campaign.example>\r
MIME-Version: 1.0\r
Content-Type: text/html; charset=utf-8\r
\r
<html><body><p>URGENT VERIFY ACCOUNT PASSWORD. PAY GIFT CARD. NOW NOW NOW.\u200B</p><p><a href="https://10.0.0.1/deal">CLICK NOW</a></p><p><a href="https://xn--bcher-kva.example/">ALSO HERE</a></p></body></html>\r
`;

const benignMime = (id) => `From: "Promo" <promo@campaign.example>\r
To: me@one.test\r
Subject: Lunch tomorrow?\r
Message-ID: <${id}@campaign.example>\r
Content-Type: text/plain; charset=utf-8\r
\r
Are we still on for lunch tomorrow?\r
`;

const reputation = (database, type, key) => database.db.prepare(
	"SELECT messages_seen, spam_count, ham_count FROM spam_reputation WHERE mailbox_id = 'box' AND type = ? AND key = ?",
).get(type, key);

test("mail the spam engine files itself counts as spam reputation for the sender", async (t) => {
	t.mock.method(console, "error", () => {});
	t.mock.method(console, "warn", () => {});
	t.mock.method(console, "info", () => {});
	const { database, deliver } = await setup(t);

	const stored = await deliver(spamMime("s1"), "promo@campaign.example", SPAM_HEADERS);
	assert.equal(stored.status, "spam", `expected the fixture to be classified as spam, got ${stored.spam_signals}`);
	assert.deepEqual({ ...reputation(database, "domain", "campaign.example") }, { messages_seen: 1, spam_count: 1, ham_count: 0 });
	assert.deepEqual({ ...reputation(database, "email", "promo@campaign.example") }, { messages_seen: 1, spam_count: 1, ham_count: 0 });

	// A message the engine leaves in the Inbox still counts as seen, not as spam.
	const benign = await deliver(benignMime("b1"), "promo@campaign.example");
	assert.equal(benign.status, "received");
	assert.deepEqual({ ...reputation(database, "domain", "campaign.example") }, { messages_seen: 2, spam_count: 1, ham_count: 0 });
});

test("a domain the engine keeps filing as spam is penalized on its next message", async (t) => {
	t.mock.method(console, "error", () => {});
	t.mock.method(console, "warn", () => {});
	t.mock.method(console, "info", () => {});
	const { database, deliver } = await setup(t);

	for (const id of ["s1", "s2", "s3"]) {
		const stored = await deliver(spamMime(id), "promo@campaign.example", SPAM_HEADERS);
		assert.equal(stored.status, "spam", `expected ${id} to be classified as spam, got ${stored.spam_signals}`);
	}
	assert.deepEqual({ ...reputation(database, "domain", "campaign.example") }, { messages_seen: 3, spam_count: 3, ham_count: 0 });

	// The next bland message from the same domain carries the learned reputation penalty.
	const benign = await deliver(benignMime("b1"), "promo@campaign.example");
	assert.equal(benign.status, "received");
	const signals = JSON.parse(benign.spam_signals).map((signal) => signal.id);
	assert.ok(
		signals.includes("poor_domain_reputation") || signals.includes("poor_email_reputation"),
		`expected a learned reputation signal, got ${benign.spam_signals}`,
	);
});
