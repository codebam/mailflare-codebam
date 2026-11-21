import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dir = mkdtempSync(join(tmpdir(), "mailflare-backups-utils-"));
after(() => rmSync(dir, { recursive: true, force: true }));
const outfile = join(dir, "utils.mjs");
await build({
	entryPoints: [join(root, "src/lib/backups/utils.ts")],
	outfile, bundle: true, platform: "node", format: "esm", logLevel: "silent",
	alias: { "@": join(root, "src") },
});
const utils = await import(pathToFileURL(outfile).href);

test("backup settings id and storage prefix are pinned", () => {
	assert.equal(utils.BACKUP_SETTINGS_ID, "default");
	assert.equal(utils.BACKUP_PREFIX, "backups/database");
});

test("isBackupDue honours the schedule type and value in UTC", () => {
	const tuesday = new Date("2026-11-17T13:45:30Z"); // getUTCDay() 2, getUTCDate() 17
	assert.equal(tuesday.getUTCDay(), 2);
	assert.equal(tuesday.getUTCDate(), 17);

	// Daily always runs, even without a value.
	assert.equal(utils.isBackupDue("daily", null, tuesday), true);
	assert.equal(utils.isBackupDue("daily", 99, tuesday), true);

	// Weekly runs on the matching UTC weekday only.
	assert.equal(utils.isBackupDue("weekly", 2, tuesday), true);
	assert.equal(utils.isBackupDue("weekly", 3, tuesday), false);
	assert.equal(utils.isBackupDue("weekly", null, tuesday), false);

	// Monthly runs on the matching UTC date only.
	assert.equal(utils.isBackupDue("monthly", 17, tuesday), true);
	assert.equal(utils.isBackupDue("monthly", 18, tuesday), false);
	assert.equal(utils.isBackupDue("monthly", null, tuesday), false);
});

test("getUtcDayBounds returns the UTC day ceiling regardless of the time of day", () => {
	const midday = utils.getUtcDayBounds(new Date("2026-11-17T13:45:30.123Z"));
	assert.equal(midday.start, Date.UTC(2026, 10, 17));
	assert.equal(midday.end, Date.UTC(2026, 10, 18));
	assert.equal(midday.end - midday.start, 86_400_000);

	// The bounds follow UTC, not the local calendar, across a year boundary.
	const newYear = utils.getUtcDayBounds(new Date("2026-12-31T23:59:59Z"));
	assert.equal(newYear.start, Date.UTC(2026, 11, 31));
	assert.equal(newYear.end, Date.UTC(2027, 0, 1));
});

test("createBackupFilename uses an ISO sortable timestamp with safe separators", () => {
	assert.equal(utils.createBackupFilename(new Date("2026-11-17T13:45:30.123Z")), "mailflare-2026-11-17T13-45-30-123Z.json");
	assert.equal(utils.createBackupFilename(new Date("2026-01-02T03:04:05.000Z")), "mailflare-2026-01-02T03-04-05-000Z.json");
});

test("mergeLegacyMessageBodies copies only missing body fields and removes the legacy table", () => {
	const document = {
		format: "mailflare-database-backup", version: 2, createdAt: "now",
		tables: {
			messages: [
				{ id: "m1", text_body: "kept" },
				{ id: "m2", text_body: "" },
				{ id: "m3" },
			],
			message_bodies: [
				{ message_id: "m1", text_body: "replaced", html_body: "<b>hi</b>", raw_r2_key: "r1" },
				{ message_id: "m2", html_body: "<i>hi</i>" },
				{ message_id: "m3", text_body: "found" },
				{ message_id: "orphan", text_body: "ignored" },
			],
			accounts: [{ id: "a1" }],
		},
	};
	utils.mergeLegacyMessageBodies(document);
	assert.deepEqual(document.tables.messages, [
		{ id: "m1", text_body: "kept", html_body: "<b>hi</b>", raw_r2_key: "r1" },
		{ id: "m2", text_body: "", html_body: "<i>hi</i>" },
		{ id: "m3", text_body: "found" },
	]);
	assert.equal("message_bodies" in document.tables, false);
	assert.deepEqual(document.tables.accounts, [{ id: "a1" }]);
});

test("mergeLegacyMessageBodies is a no-op without a legacy table and rejects invalid records", () => {
	const already = { tables: { messages: [{ id: "m1" }] } };
	utils.mergeLegacyMessageBodies(already);
	assert.deepEqual(already, { tables: { messages: [{ id: "m1" }] } });

	for (const bad of [{ html_body: "x" }, null, "raw", ["raw"]]) {
		const document = { tables: { messages: [], message_bodies: [bad] } };
		assert.throws(() => utils.mergeLegacyMessageBodies(document), /invalid message_bodies record/);
	}
});
