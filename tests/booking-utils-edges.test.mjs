import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test, { after } from "node:test";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dir = mkdtempSync(join(tmpdir(), "mailflare-booking-utils-"));
after(() => rmSync(dir, { recursive: true, force: true }));
await build({
	entryPoints: { b: join(root, "src/lib/booking/utils.ts") },
	outdir: dir, outExtension: { ".js": ".mjs" }, bundle: true, platform: "node", format: "esm", logLevel: "silent",
	alias: { "@": join(root, "src") },
});
const { parseBookingWeekdays } = await import(pathToFileURL(join(dir, "b.mjs")).href);

test("parseBookingWeekdays keeps a stored list of valid weekday numbers as-is", () => {
	assert.deepEqual(parseBookingWeekdays("[0,1,2,3,4,5,6]"), [0, 1, 2, 3, 4, 5, 6]);
	assert.deepEqual(parseBookingWeekdays("[2]"), [2]);
	assert.deepEqual(parseBookingWeekdays("[]"), []);
});

test("parseBookingWeekdays drops non-integer and out-of-range entries while keeping duplicates", () => {
	assert.deepEqual(parseBookingWeekdays("[0,1.5,2,\"3\",null,6]"), [0, 2, 6]);
	assert.deepEqual(parseBookingWeekdays("[-1,7,0,6,true]"), [0, 6]);
	assert.deepEqual(parseBookingWeekdays("[1,1,3,3]"), [1, 1, 3, 3]);
});

test("parseBookingWeekdays returns an empty list for malformed or non-array values", () => {
	assert.deepEqual(parseBookingWeekdays("not json"), []);
	assert.deepEqual(parseBookingWeekdays("{\"weekdays\":[1,2]}"), []);
	assert.deepEqual(parseBookingWeekdays("null"), []);
	assert.deepEqual(parseBookingWeekdays("\"[1,2]\""), []);
});
