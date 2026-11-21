import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = mkdtempSync(join(tmpdir(), "mailflare-default-translator-"));
after(() => rmSync(outDir, { recursive: true, force: true }));

const outfile = join(outDir, "utils.mjs");
await build({
	entryPoints: [join(root, "src/lib/i18n/utils.ts")],
	outfile,
	bundle: true,
	format: "esm",
	platform: "neutral",
	logLevel: "silent",
});
const { defaultTranslator, createTranslator } = await import(pathToFileURL(outfile).href);

test("the default translator answers in English without a catalog", () => {
	assert.equal(defaultTranslator("navigation.inbox"), "Inbox");
});

test("the default translator interpolates vars and applies English plurals", () => {
	assert.equal(defaultTranslator("contacts.sendEmail", { name: "Sam" }), "Send email to Sam");
	assert.equal(defaultTranslator("thread.attachmentCount", { count: 1 }), "1 attachment");
	assert.equal(defaultTranslator("thread.attachmentCount", { count: 2 }), "2 attachments");
});

test("the default translator falls back to the key when nothing is catalogued", () => {
	assert.equal(defaultTranslator("not.a.real.key"), "not.a.real.key");
});

test("defaultTranslator translates from the bundled English catalog", () => {
	assert.equal(defaultTranslator("navigation.inbox"), "Inbox");
	assert.equal(defaultTranslator("error.updateSelected"), "Unable to update selected messages");
	assert.equal(defaultTranslator("not.a.key"), "not.a.key");
});

test("defaultTranslator selects English CLDR plural variants", () => {
	assert.equal(defaultTranslator("thread.attachmentCount", { count: 1 }), "1 attachment");
	assert.equal(defaultTranslator("thread.attachmentCount", { count: 3 }), "3 attachments");
	assert.equal(defaultTranslator("thread.attachmentCount"), "thread.attachmentCount");
});

test("defaultTranslator is the same helper as an explicit English translator", () => {
	assert.equal(defaultTranslator("navigation.inbox"), createTranslator("en")("navigation.inbox"));
});

test("defaultTranslator resolves English catalog keys without any caller-supplied catalog", () => {
	assert.equal(defaultTranslator("navigation.inbox"), "Inbox");
	assert.equal(defaultTranslator("thread.expand", { label: "all" }), "Expand all");
	assert.equal(defaultTranslator("not.a.catalog.key"), "not.a.catalog.key");
});

test("defaultTranslator selects English CLDR plural variants from count", () => {
	assert.equal(defaultTranslator("thread.attachmentCount", { count: 0 }), "0 attachments");
	assert.equal(defaultTranslator("thread.attachmentCount", { count: 1 }), "1 attachment");
	assert.equal(defaultTranslator("thread.attachmentCount", { count: 2 }), "2 attachments");
	// A key without variants falls back to the bare message rather than a plural suffix.
	assert.equal(defaultTranslator("common.selectedCount", { count: 3 }), "3 selected");
});

test("defaultTranslator renders bundled English without a catalog or fetch", () => {
	assert.equal(defaultTranslator("navigation.inbox"), "Inbox");
	assert.equal(defaultTranslator("thread.attachmentCount.one", { count: 2 }), "2 attachment");
});

test("defaultTranslator selects English plurals and leaves unknown keys visible", () => {
	assert.equal(defaultTranslator("thread.attachmentCount", { count: 1 }), "1 attachment");
	assert.equal(defaultTranslator("thread.attachmentCount", { count: 3 }), "3 attachments");
	assert.equal(defaultTranslator("missingly.key"), "missingly.key");
});
