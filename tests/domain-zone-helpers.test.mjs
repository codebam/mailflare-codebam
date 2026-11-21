import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

// Cloudflare zones are looked up from the longest candidate down, and DNS setup
// treats the zone apex differently from a record below it.

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const directory = mkdtempSync(join(root, "tests", ".tmp-domain-zone-helpers-"));
after(() => rmSync(directory, { recursive: true, force: true }));

const outfile = join(directory, "utils.mjs");
await build({
	entryPoints: [join(root, "src/lib/domains/utils.ts")],
	outfile,
	bundle: true,
	format: "esm",
	platform: "neutral",
	logLevel: "silent",
});
const { getZoneLookupCandidates, isZoneApex } = await import(pathToFileURL(outfile).href);

test("getZoneLookupCandidates walks from the full host to the registrable domain", () => {
	assert.deepEqual(getZoneLookupCandidates("mail.example.com"), ["mail.example.com", "example.com"]);
	assert.deepEqual(getZoneLookupCandidates("a.b.c.d.com"), ["a.b.c.d.com", "b.c.d.com", "c.d.com", "d.com"]);
});

test("getZoneLookupCandidates yields the host itself for a two-label name", () => {
	assert.deepEqual(getZoneLookupCandidates("example.com"), ["example.com"]);
});

test("getZoneLookupCandidates has nothing to offer a single label or empty input", () => {
	assert.deepEqual(getZoneLookupCandidates("example"), []);
	assert.deepEqual(getZoneLookupCandidates(""), []);
});

test("getZoneLookupCandidates drops empty labels from a dot-bracketed host", () => {
	assert.deepEqual(getZoneLookupCandidates(".example.com."), ["example.com"]);
	assert.deepEqual(getZoneLookupCandidates("a..b.com"), ["a.b.com", "b.com"]);
});

test("isZoneApex matches only an exact zone name", () => {
	assert.equal(isZoneApex("example.com", "example.com"), true);
	assert.equal(isZoneApex("mail.example.com", "example.com"), false);
	assert.equal(isZoneApex("example.co", "example.com"), false);
	assert.equal(isZoneApex("example.com.", "example.com"), false);
});
