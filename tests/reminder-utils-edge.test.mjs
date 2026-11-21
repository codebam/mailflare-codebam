import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const directory = mkdtempSync(join(root, "node_modules", "mailflare-reminder-edge-test-"));
after(() => rmSync(directory, { recursive: true, force: true }));
await build({
	stdin: {
		contents: `
			export { REMINDER_MINUTE_OPTIONS, MAX_REMINDER_MINUTES, normalizeReminderMinutes, formatReminderBody } from "./src/lib/calendar/reminder-utils.ts";
		`,
		resolveDir: root,
		sourcefile: "reminder-utils-edge-test-entry.ts",
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

test("MAX_REMINDER_MINUTES is the top offered offset and the last valid input", () => {
	assert.equal(m.MAX_REMINDER_MINUTES, 10080);
	assert.equal(m.REMINDER_MINUTE_OPTIONS.at(-1), m.MAX_REMINDER_MINUTES);
	assert.equal(m.normalizeReminderMinutes(m.MAX_REMINDER_MINUTES - 1), m.MAX_REMINDER_MINUTES - 1);
	assert.equal(m.normalizeReminderMinutes(m.MAX_REMINDER_MINUTES), m.MAX_REMINDER_MINUTES);
});

test("normalize rejects out-of-range and non-finite numbers", () => {
	for (const bad of [-10080, 1e9, Infinity, -Infinity, m.MAX_REMINDER_MINUTES + 100]) {
		assert.equal(m.normalizeReminderMinutes(bad), null, String(bad));
	}
});

test("normalize rejects strings and other non-number inputs", () => {
	for (const bad of ["0", "10080", "", " 5 ", true, false, {}, []]) {
		assert.equal(m.normalizeReminderMinutes(bad), null, String(bad));
	}
});

test("normalize rejects fractional minutes", () => {
	for (const bad of [0.5, 2.5, 10080.5, -0.5]) assert.equal(m.normalizeReminderMinutes(bad), null, String(bad));
});

test("formatReminderBody renders the fixed start in the requested zone", () => {
	const start = new Date("2026-12-31T23:30:00Z");
	assert.equal(m.formatReminderBody(start, "Asia/Tokyo", ""), "Fri, Jan 1, 8:30 AM");
	assert.equal(m.formatReminderBody(start, "America/Los_Angeles", ""), "Thu, Dec 31, 3:30 PM");
	assert.equal(m.formatReminderBody(start, "UTC", ""), "Thu, Dec 31, 11:30 PM");
});

test("formatReminderBody trims whitespace-only locations and uses the ISO fallback with a location", () => {
	const start = new Date("2026-12-31T23:30:00Z");
	assert.equal(m.formatReminderBody(start, "Asia/Tokyo", "   "), "Fri, Jan 1, 8:30 AM");
	assert.equal(m.formatReminderBody(start, "Asia/Tokyo", " Tokyo Station "), "Fri, Jan 1, 8:30 AM · Tokyo Station");
	assert.equal(m.formatReminderBody(start, "Not/AZone", " Room 4 "), "2026-12-31T23:30:00.000Z · Room 4");
});
