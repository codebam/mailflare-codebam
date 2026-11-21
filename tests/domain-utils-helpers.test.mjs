import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

// Cloudflare zone names are canonical (punycode, no trailing dot), so the helpers that
// shape a hostname before a zone lookup are pinned here rather than exercised indirectly.

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = mkdtempSync(join(root, "tests", ".tmp-domain-utils-helpers-"));
after(() => rmSync(outDir, { recursive: true, force: true }));

const outfile = join(outDir, "utils.mjs");
await build({
	entryPoints: [join(root, "src/lib/domains/utils.ts")],
	outfile,
	bundle: true,
	format: "esm",
	platform: "neutral",
	logLevel: "silent",
});
const { normalizeHostname, isValidHostname, getZoneLookupCandidates, isZoneApex } = await import(pathToFileURL(outfile).href);

test("normalizeHostname trims, lowercases and drops trailing dots", () => {
	assert.equal(normalizeHostname("  Example.COM.  "), "example.com");
	assert.equal(normalizeHostname("example.com..."), "example.com");
	assert.equal(normalizeHostname(""), "");
});

test("normalizeHostname punycodes an internationalised name", () => {
	assert.equal(normalizeHostname("BÜCHER.example"), "xn--bcher-kva.example");
});

test("normalizeHostname returns input the URL parser cannot read trimmed and lowercased", () => {
	for (const value of ["bad host", "user@example.com", "https://example.com", "a/b", "a?b", "a#b", "a\\b", "a:b"]) {
		assert.equal(normalizeHostname(`  ${value.toUpperCase()}  `), value);
	}
});

test("isValidHostname accepts ordinary and punycode DNS names", () => {
	for (const value of ["example.com", "www.example.co.uk", "xn--bcher-kva.example", "a-b.example.com"]) {
		assert.equal(isValidHostname(value), true, value);
	}
});

test("isValidHostname rejects single labels, bad labels and numeric TLDs", () => {
	for (const value of [
		"localhost",
		"-bad.example.com",
		"bad-.example.com",
		"a..example.com",
		"EXAMPLE.COM",
		"example.com.",
		"127.0.0.1",
		"0x7f.1",
		"example.123",
		"a b.com",
		`${"a".repeat(64)}.com`,
	]) {
		assert.equal(isValidHostname(value), false, value);
	}
});

test("getZoneLookupCandidates walks from the full host down to the apex", () => {
	assert.deepEqual(getZoneLookupCandidates("a.b.example.com"), ["a.b.example.com", "b.example.com", "example.com"]);
	assert.deepEqual(getZoneLookupCandidates("example.com"), ["example.com"]);
});

test("getZoneLookupCandidates drops empty labels and has no candidates for a single label", () => {
	assert.deepEqual(getZoneLookupCandidates("a..example.com"), ["a.example.com", "example.com"]);
	assert.deepEqual(getZoneLookupCandidates("localhost"), []);
	assert.deepEqual(getZoneLookupCandidates(""), []);
});

test("isZoneApex matches the exact zone name only", () => {
	assert.equal(isZoneApex("example.com", "example.com"), true);
	assert.equal(isZoneApex("www.example.com", "example.com"), false);
	assert.equal(isZoneApex("EXAMPLE.com", "example.com"), false);
});
