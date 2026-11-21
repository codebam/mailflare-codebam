
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test, { after } from "node:test";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const directory = mkdtempSync(join(root, "node_modules", "mailflare-backup-utils-"));
after(() => rmSync(directory, { recursive: true, force: true }));
await build({
	entryPoints: [join(root, "src/lib/backups/utils.ts")],
	outfile: join(directory, "entry.mjs"),
	bundle: true,
	platform: "node",
	format: "esm",
	target: "node24",
	tsconfig: join(root, "tsconfig.json"),
	packages: "external",
	logLevel: "silent",
});
const { isBackupDue } = await import(pathToFileURL(join(directory, "entry.mjs")).href);

// 2026-11-21 is a Saturday (UTC day 6, UTC date 21); the 22nd is a Sunday (day 0).
const saturday = new Date("2026-11-21T00:15:00.000Z");
const sunday = new Date("2026-11-22T23:45:00.000Z");

test("daily schedules are always due, whatever the configured value", () => {
	assert.equal(isBackupDue("daily", null, saturday), true);
	assert.equal(isBackupDue("daily", 6, sunday), true);
	assert.equal(isBackupDue("daily", 0, saturday), true);
});

test("weekly schedules match the UTC weekday, not any other value", () => {
	assert.equal(isBackupDue("weekly", 6, saturday), true);
	assert.equal(isBackupDue("weekly", 0, saturday), false);
	assert.equal(isBackupDue("weekly", 0, sunday), true);
	assert.equal(isBackupDue("weekly", 6, sunday), false);
	assert.equal(isBackupDue("weekly", null, saturday), false);
});

test("monthly schedules match the UTC calendar date", () => {
	const endOfMonth = new Date("2026-01-31T12:00:00.000Z");
	const firstOfMonth = new Date("2026-02-01T00:00:00.000Z");
	assert.equal(isBackupDue("monthly", 31, endOfMonth), true);
	assert.equal(isBackupDue("monthly", 1, endOfMonth), false);
	assert.equal(isBackupDue("monthly", 1, firstOfMonth), true);
	assert.equal(isBackupDue("monthly", 31, firstOfMonth), false);
	assert.equal(isBackupDue("monthly", null, firstOfMonth), false);
});
