import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test, { after } from "node:test";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = mkdtempSync(join(root, "node_modules", "mailflare-follow-up-utils-"));
after(() => rmSync(outDir, { recursive: true, force: true }));
await build({
	entryPoints: [join(root, "src/lib/follow-ups/follow-up-utils.ts")],
	outfile: join(outDir, "follow-up-utils.mjs"),
	bundle: true,
	platform: "node",
	format: "esm",
	logLevel: "silent",
});
const utils = await import(pathToFileURL(join(outDir, "follow-up-utils.mjs")).href);

const DAY = 24 * 60 * 60 * 1000;

test("followUpDueAt adds fixed 24-hour days to the instant", () => {
	const from = new Date("2026-03-07T12:34:56.789Z");
	for (const days of [1, 3, 7, 30]) {
		assert.equal(utils.followUpDueAt(from, days).getTime(), from.getTime() + days * DAY);
	}
});

test("followUpDueAt handles zero, fractional and negative days without mutating the input", () => {
	const from = new Date("2026-03-07T12:00:00.000Z");
	const before = from.getTime();
	assert.equal(utils.followUpDueAt(from, 0).getTime(), before);
	assert.equal(utils.followUpDueAt(from, 1.5).getTime(), before + 1.5 * DAY);
	assert.equal(utils.followUpDueAt(from, -2).getTime(), before - 2 * DAY);
	assert.equal(from.getTime(), before);
});

test("followUpDueAt returns a fresh Date, not a shared or string value", () => {
	const from = new Date(0);
	const due = utils.followUpDueAt(from, 1);
	assert.ok(due instanceof Date);
	assert.notEqual(due, from);
	assert.equal(typeof due.toISOString(), "string");
});
