import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const directory = mkdtempSync(join(root, "node_modules", "mailflare-account-dates-test-"));
after(() => rmSync(directory, { recursive: true, force: true }));
await build({
	stdin: {
		contents: `
			export { ACCOUNT_RESTORE_DAYS, getAccountPurgeDate, getAccountPurgeCutoff, getAccountStatus } from "./src/lib/accounts/deletion-utils.ts";
		`,
		resolveDir: root,
		sourcefile: "account-deletion-dates-test-entry.ts",
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

test("the restore window is twenty fixed 24-hour days", () => {
	assert.equal(m.ACCOUNT_RESTORE_DAYS, 20);
	const deletedAt = new Date("2026-10-31T12:34:56.789Z");
	assert.equal(m.getAccountPurgeDate(deletedAt).toISOString(), "2026-11-20T12:34:56.789Z");
	assert.equal(deletedAt.getTime(), Date.parse("2026-10-31T12:34:56.789Z"), "getAccountPurgeDate must not mutate its input");
	assert.equal(m.getAccountPurgeCutoff(new Date("2026-10-31T12:34:56.789Z")).toISOString(), "2026-10-11T12:34:56.789Z");
});

test("purge date and cutoff are the same window seen from opposite ends", () => {
	const now = new Date("2026-11-05T08:00:00.000Z");
	const cutoff = m.getAccountPurgeCutoff(now);
	assert.equal(cutoff.getTime(), now.getTime() - m.ACCOUNT_RESTORE_DAYS * 24 * 60 * 60_000);
	assert.equal(m.getAccountPurgeDate(cutoff).getTime(), now.getTime());
	assert.equal(m.getAccountPurgeDate(new Date(0)).getTime(), m.ACCOUNT_RESTORE_DAYS * 24 * 60 * 60_000);
});

test("getAccountStatus reports active, disabled, or pendingDeletion", () => {
	assert.equal(m.getAccountStatus({ disabled: false }), "active");
	assert.equal(m.getAccountStatus({ disabled: false, deletedAt: null }), "active");
	assert.equal(m.getAccountStatus({ disabled: true }), "disabled");
	assert.equal(m.getAccountStatus({ disabled: true, deletedAt: null }), "disabled");
	assert.equal(m.getAccountStatus({ disabled: false, deletedAt: new Date("2026-10-31T12:00:00Z") }), "pendingDeletion");
	assert.equal(m.getAccountStatus({ disabled: false, deletedAt: "2026-10-31T12:00:00Z" }), "pendingDeletion");
});

test("a deletion date wins over the disabled flag, and an empty string is not a deletion", () => {
	assert.equal(m.getAccountStatus({ disabled: true, deletedAt: "2026-10-31T12:00:00Z" }), "pendingDeletion");
	assert.equal(m.getAccountStatus({ disabled: true, deletedAt: new Date("2026-10-31T12:00:00Z") }), "pendingDeletion");
	assert.equal(m.getAccountStatus({ disabled: false, deletedAt: "" }), "active");
});
