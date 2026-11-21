import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test, { after } from "node:test";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = mkdtempSync(join(root, "tests", ".tmp-string-utils-"));
after(() => rmSync(outDir, { recursive: true, force: true }));

await build({
	entryPoints: { utils: join(root, "src/lib/booking/utils.ts") },
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
	slugifyBookingName, isValidBookingSlug,
	normalizeBookingUsername, bookingUsernameFromEmail,
	parseBookingWeekdays, parseBookingTimeRanges,
} = await import(pathToFileURL(join(outDir, "utils.mjs")).href);

test("slugifyBookingName folds diacritics and collapses separators", () => {
	assert.equal(slugifyBookingName("Hello World!"), "hello-world");
	assert.equal(slugifyBookingName("Café & Bar"), "cafe-bar");
	assert.equal(slugifyBookingName("A  B"), "a-b");
	assert.equal(slugifyBookingName("---"), "");
	assert.equal(slugifyBookingName(""), "");
	assert.equal(slugifyBookingName("  Book Me  "), "book-me");
	const long = slugifyBookingName(`${"a".repeat(79)} b`);
	assert.equal(long.length, 79);
	assert.equal(long, "a".repeat(79));
});

test("isValidBookingSlug enforces lowercase hyphenated form and length", () => {
	assert.equal(isValidBookingSlug("a"), true);
	assert.equal(isValidBookingSlug("abc"), true);
	assert.equal(isValidBookingSlug("a-b"), true);
	assert.equal(isValidBookingSlug(""), false);
	assert.equal(isValidBookingSlug("-a"), false);
	assert.equal(isValidBookingSlug("a-"), false);
	assert.equal(isValidBookingSlug("a--b"), false);
	assert.equal(isValidBookingSlug("A"), false);
	assert.equal(isValidBookingSlug("a_b"), false);
	assert.equal(isValidBookingSlug("a".repeat(80)), true);
	assert.equal(isValidBookingSlug("a".repeat(81)), false);
});

test("normalizeBookingUsername trims, lowercases, and rejects unsafe values", () => {
	assert.equal(normalizeBookingUsername("  User.Name+x  "), "user.name+x");
	assert.equal(normalizeBookingUsername(" User "), "user");
	assert.equal(normalizeBookingUsername("a".repeat(64)), "a".repeat(64));
	assert.equal(normalizeBookingUsername("a".repeat(65)), null);
	for (const bad of ["", "   ", "___", "a b", "user@host", null, undefined, 123]) {
		assert.equal(normalizeBookingUsername(bad), null, String(bad));
	}
});

test("bookingUsernameFromEmail derives a safe username or falls back", () => {
	assert.equal(bookingUsernameFromEmail("John.Doe@example.com"), "john.doe");
	assert.equal(bookingUsernameFromEmail("José García@example.com"), "jose-garcia");
	assert.equal(bookingUsernameFromEmail("!!!@example.com"), "user");
	assert.equal(bookingUsernameFromEmail("big+alias@example.com"), "big+alias");
	const long = bookingUsernameFromEmail(`${"a".repeat(70)}@example.com`);
	assert.equal(long.length, 56);
});

test("parseBookingWeekdays keeps only integer weekdays", () => {
	assert.deepEqual(parseBookingWeekdays("[0,3,6]"), [0, 3, 6]);
	assert.deepEqual(parseBookingWeekdays("[0,9,-1,2.5,3]"), [0, 3]);
	assert.deepEqual(parseBookingWeekdays("[1,1]"), [1, 1]);
	assert.deepEqual(parseBookingWeekdays("not json"), []);
	assert.deepEqual(parseBookingWeekdays("{}"), []);
	assert.deepEqual(parseBookingWeekdays("[]"), []);
});

test("parseBookingTimeRanges accepts valid rows, else uses the fallback", () => {
	const fallback = { startTime: "09:00", endTime: "17:00" };
	const ranges = [{ startTime: "10:00", endTime: "12:00" }];
	assert.deepEqual(parseBookingTimeRanges(JSON.stringify(ranges), fallback), ranges);
	assert.deepEqual(parseBookingTimeRanges("[]", fallback), [fallback]);
	assert.deepEqual(parseBookingTimeRanges("[]"), []);
	assert.deepEqual(parseBookingTimeRanges("not json", fallback), [fallback]);
	assert.deepEqual(parseBookingTimeRanges("not json"), []);
	assert.deepEqual(parseBookingTimeRanges('[{"startTime":"09:00"}]', fallback), [fallback]);
});
