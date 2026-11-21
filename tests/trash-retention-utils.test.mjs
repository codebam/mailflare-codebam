import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const directory = mkdtempSync(join(root, "node_modules", "mailflare-trash-retention-test-"));
after(() => rmSync(directory, { recursive: true, force: true }));
await build({
	stdin: {
		contents: `
			export {
				TRASH_RETENTION_OPTIONS, MIN_TRASH_RETENTION_DAYS, MAX_TRASH_RETENTION_DAYS, TRASH_RETENTION_BATCH_SIZE,
				getTrashRetentionCutoff, normalizeTrashRetentionDays, describeTrashRetention,
			} from "./src/lib/email/trash-retention-utils.ts";
		`,
		resolveDir: root,
		sourcefile: "trash-retention-test-entry.ts",
	},
	outfile: join(directory, "entry.mjs"),
	bundle: true,
	platform: "node",
	format: "esm",
	target: "node24",
	tsconfig: join(root, "tsconfig.json"),
	packages: "external",
	logLevel: "silent",
});
const m = await import(pathToFileURL(join(directory, "entry.mjs")).href);

test("exported constants pin the Settings choices and the per-run batch size", () => {
	assert.deepEqual([...m.TRASH_RETENTION_OPTIONS], [7, 14, 30, 60, 90]);
	assert.equal(m.MIN_TRASH_RETENTION_DAYS, 1);
	assert.equal(m.MAX_TRASH_RETENTION_DAYS, 365);
	assert.equal(m.TRASH_RETENTION_BATCH_SIZE, 200);
});

test("cutoff subtracts whole days across month and year boundaries without mutating now", () => {
	const now = new Date("2026-01-10T12:34:56.789Z");
	assert.equal(m.getTrashRetentionCutoff(now, 7).toISOString(), "2026-01-03T12:34:56.789Z");
	assert.equal(m.getTrashRetentionCutoff(now, 14).toISOString(), "2025-12-27T12:34:56.789Z");
	assert.equal(m.getTrashRetentionCutoff(now, 365).toISOString(), "2025-01-10T12:34:56.789Z");
	assert.equal(now.toISOString(), "2026-01-10T12:34:56.789Z");
});

test("normalisation accepts the inclusive bounds and rejects non-finite and non-number values", () => {
	assert.equal(m.normalizeTrashRetentionDays(m.MIN_TRASH_RETENTION_DAYS), 1);
	assert.equal(m.normalizeTrashRetentionDays(m.MAX_TRASH_RETENTION_DAYS), 365);
	for (const days of [2, 29, 31, 364]) assert.equal(m.normalizeTrashRetentionDays(days), days, String(days));
	for (const value of [-0, 0.5, 364.5, 365.5, NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER, 1n, true, false, [], [30], {}]) {
		assert.equal(m.normalizeTrashRetentionDays(value), null, String(value));
	}
});

test("description pluralises day counts and delegates to an injected translator", () => {
	assert.equal(m.describeTrashRetention(0), "Never");
	assert.equal(m.describeTrashRetention(2), "After 2 days");
	assert.equal(m.describeTrashRetention(365), "After 365 days");

	const calls = [];
	const translator = (key, vars) => {
		calls.push([key, vars]);
		return `<${key}:${vars?.count ?? "-"}>`;
	};
	assert.equal(m.describeTrashRetention(7, translator), "<settings.trash.afterDay:7>");
	assert.deepEqual(calls, [["settings.trash.afterDay", { count: 7 }]]);
	calls.length = 0;
	assert.equal(m.describeTrashRetention(null, translator), "<settings.trash.never:->");
	assert.deepEqual(calls, [["settings.trash.never", undefined]]);
});
