import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test, { after } from "node:test";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dir = mkdtempSync(join(tmpdir(), "mailflare-import-hints-more-"));
after(() => rmSync(dir, { recursive: true, force: true }));
await build({
	entryPoints: [join(root, "src/lib/import/gmail-takeout-utils.ts")],
	outfile: join(dir, "takeout.mjs"),
	bundle: true,
	platform: "node",
	format: "esm",
	logLevel: "silent",
});
const { parseIgnoredLabels, takeoutDestinationKey } = await import(pathToFileURL(join(dir, "takeout.mjs")).href);

test("takeoutDestinationKey encodes every system section", () => {
	for (const section of ["inbox", "sent", "drafts", "spam", "trash", "archived"]) {
		assert.equal(takeoutDestinationKey({ type: "system", section }), `system:${section}`);
	}
});

test("takeoutDestinationKey keeps folder names verbatim, including separators and spaces", () => {
	assert.equal(takeoutDestinationKey({ type: "folder", name: "Newton/Doped" }), "folder:Newton/Doped");
	assert.equal(takeoutDestinationKey({ type: "folder", name: "Kunden, alt" }), "folder:Kunden, alt");
	assert.notEqual(
		takeoutDestinationKey({ type: "folder", name: "Work" }),
		takeoutDestinationKey({ type: "system", section: "inbox" }),
	);
});

test("parseIgnoredLabels trims entries and drops empty ones", () => {
	assert.deepEqual(parseIgnoredLabels("Save, Later ,Kunden/Alt"), ["Save", "Later", "Kunden/Alt"]);
	assert.deepEqual(parseIgnoredLabels("a,,b,"), ["a", "b"]);
	assert.deepEqual(parseIgnoredLabels("Just one"), ["Just one"]);
});

test("parseIgnoredLabels returns an empty list for blank or empty input", () => {
	assert.deepEqual(parseIgnoredLabels(""), []);
	assert.deepEqual(parseIgnoredLabels("  , ,  "), []);
	assert.deepEqual(parseIgnoredLabels(",,,"), []);
});
