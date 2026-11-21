import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test, { after } from "node:test";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = mkdtempSync(join(root, "tests", ".tmp-date-utils-"));
after(() => rmSync(outDir, { recursive: true, force: true }));

await build({
	entryPoints: { utils: join(root, "src/lib/time/utils.ts") },
	outdir: outDir,
	outExtension: { ".js": ".mjs" },
	bundle: true,
	platform: "node",
	format: "esm",
	target: "node22",
	alias: { "@": join(root, "src") },
	logLevel: "silent",
});
const {
	normalizeTimeZone, isValidTimeZone, getRequestTimeZone,
	formatUserDateTimeLocal, parseUserDateTimeLocal,
	zonedDateFields, dateFromZonedFields, recentZonedDays,
} = await import(pathToFileURL(join(outDir, "utils.mjs")).href);

test("normalizeTimeZone defaults empty and invalid zones to UTC", () => {
	assert.equal(normalizeTimeZone(), "UTC");
	assert.equal(normalizeTimeZone(null), "UTC");
	assert.equal(normalizeTimeZone(""), "UTC");
	assert.equal(normalizeTimeZone("Not/AZone"), "UTC");
	assert.equal(normalizeTimeZone("America/New_York"), "America/New_York");
	assert.equal(normalizeTimeZone("America/New_York"), "America/New_York"); // cached path
});

test("isValidTimeZone rejects blanks and unknown zones", () => {
	assert.equal(isValidTimeZone("UTC"), true);
	assert.equal(isValidTimeZone("America/New_York"), true);
	assert.equal(isValidTimeZone(""), false);
	assert.equal(isValidTimeZone("Not/AZone"), false);
});

test("getRequestTimeZone prefers explicit zone, then query, then header", () => {
	const header = new Request("https://example.com/", { headers: { "X-Time-Zone": "America/Chicago" } });
	assert.equal(getRequestTimeZone(header), "America/Chicago");
	const query = new Request("https://example.com/?timeZone=Asia/Tokyo", { headers: { "X-Time-Zone": "America/Chicago" } });
	assert.equal(getRequestTimeZone(query), "Asia/Tokyo");
	assert.equal(getRequestTimeZone(query, "Europe/Paris"), "Europe/Paris");
	const bare = new Request("https://example.com/");
	assert.equal(getRequestTimeZone(bare), "UTC");
	const bad = new Request("https://example.com/?timeZone=Not/AZone");
	assert.equal(getRequestTimeZone(bad), "UTC");
});

test("local datetime formatting uses UTC on the server", () => {
	assert.equal(formatUserDateTimeLocal(new Date("2026-11-02T14:30:00Z")), "2026-11-02T14:30");
	assert.equal(formatUserDateTimeLocal(new Date("2026-01-05T00:00:00Z")), "2026-01-05T00:00");
});

test("parseUserDateTimeLocal accepts only canonical minute strings", () => {
	const parsed = parseUserDateTimeLocal("2026-11-02T14:30");
	assert.ok(parsed);
	assert.equal(parsed.toISOString(), "2026-11-02T14:30:00.000Z");
	for (const bad of ["", "2026-11-02", "2026-11-02 14:30", "2026-11-02T14:30:00", "2026-13-02T14:30", "2026-02-30T10:00", "2026-11-02T25:00", "2026-11-02T14:60"]) {
		assert.equal(parseUserDateTimeLocal(bad), null, bad);
	}
});

test("zonedDateFields exposes the wall-clock fields for a zone", () => {
	assert.equal(zonedDateFields(new Date("2026-11-02T14:30:45.123Z"), "UTC").toISOString(), "2026-11-02T14:30:45.123Z");
	assert.equal(zonedDateFields(new Date("2026-11-02T14:30:00Z"), "America/New_York").toISOString().slice(0, 16), "2026-11-02T09:30");
	assert.equal(zonedDateFields(new Date("2026-06-02T14:30:00Z"), "America/New_York").toISOString().slice(0, 16), "2026-06-02T10:30");
});

test("dateFromZonedFields round-trips unambiguous wall times", () => {
	for (const [wall, zone, instant] of [
		["2026-11-02T14:30", "UTC", "2026-11-02T14:30:00.000Z"],
		["2026-11-02T09:30", "America/New_York", "2026-11-02T14:30:00.000Z"],
		["2026-06-02T10:30", "America/New_York", "2026-06-02T14:30:00.000Z"],
	]) {
		const fields = new Date(`${wall}:00.000Z`);
		const result = dateFromZonedFields(fields, zone);
		assert.equal(result.toISOString(), instant, wall);
		assert.equal(zonedDateFields(result, zone).toISOString().slice(0, 16), wall, wall);
	}
});

test("dateFromZonedFields moves forward across a spring gap and picks the earlier fold", () => {
	// 02:30 does not exist on 2026-03-08 in New York; clocks jump to 03:30 EDT.
	const gap = dateFromZonedFields(new Date("2026-03-08T02:30:00.000Z"), "America/New_York");
	assert.equal(gap.toISOString(), "2026-03-08T07:30:00.000Z");
	assert.equal(zonedDateFields(gap, "America/New_York").toISOString().slice(0, 16), "2026-03-08T03:30");
	// 01:30 occurs twice on 2026-11-01; the earlier EDT instant wins.
	const fold = dateFromZonedFields(new Date("2026-11-01T01:30:00.000Z"), "America/New_York");
	assert.equal(fold.toISOString(), "2026-11-01T05:30:00.000Z");
	assert.equal(zonedDateFields(fold, "America/New_York").toISOString().slice(0, 16), "2026-11-01T01:30");
});

test("recentZonedDays returns consecutive local days with abutting UTC ranges", () => {
	const days = recentZonedDays("America/New_York", 3, new Date("2026-11-03T16:00:00Z"));
	assert.equal(days.length, 3);
	assert.deepEqual(days.map((day) => day.date), ["2026-11-01", "2026-11-02", "2026-11-03"]);
	for (let index = 1; index < days.length; index++) {
		assert.equal(days[index - 1].end.getTime(), days[index].start.getTime());
	}
	assert.equal(zonedDateFields(days[2].start, "America/New_York").toISOString().slice(0, 10), "2026-11-03");
	assert.equal(days[2].start.toISOString(), "2026-11-03T05:00:00.000Z"); // EST midnight
});
