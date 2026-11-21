import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

// Domain names come from user input and Cloudflare zone lookups; pin the canonicalisation,
// validity, and zone-candidate helpers that keep both paths in agreement. The owner-id helper
// in this module is already covered by domain-list-owners.test.mjs.

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = mkdtempSync(join(root, "tests", ".tmp-domain-name-helpers-"));
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

test("normalizeHostname trims, lowercases, and drops trailing dots", () => {
	assert.equal(normalizeHostname("  EXAMPLE.COM.  "), "example.com");
	assert.equal(normalizeHostname("Example.Com.."), "example.com");
	assert.equal(normalizeHostname("example.com"), "example.com");
});

test("normalizeHostname punycodes internationalised names", () => {
	assert.equal(normalizeHostname("BÜCHER.example"), "xn--bcher-kva.example");
});

test("normalizeHostname returns unparseable input trimmed and lowercased", () => {
	assert.equal(normalizeHostname("   "), "");
	assert.equal(normalizeHostname("not a host"), "not a host");
	assert.equal(normalizeHostname("HTTP://EXAMPLE.COM"), "http://example.com");
	assert.equal(normalizeHostname("user@example.com"), "user@example.com");
});

test("isValidHostname accepts dotted DNS names but not hosts, IPs, or malformed labels", () => {
	for (const valid of ["example.com", "a-b.example.co.uk", "xn--bcher-kva.example"]) {
		assert.equal(isValidHostname(valid), true, valid);
	}
	for (const invalid of [
		"localhost",
		"example.com.",
		"EXAMPLE.com",
		"192.168.0.1",
		"0x7f.1",
		"foo..com",
		"a-.com",
		"-a.com",
		`${"a".repeat(64)}.com`,
		Array(70).fill("abcdefghij").join("."),
	]) {
		assert.equal(isValidHostname(invalid), false, invalid);
	}
});

test("getZoneLookupCandidates walks from the full name to the shortest zone", () => {
	assert.deepEqual(getZoneLookupCandidates("mail.example.co.uk"), ["mail.example.co.uk", "example.co.uk", "co.uk"]);
	assert.deepEqual(getZoneLookupCandidates("example.com"), ["example.com"]);
	assert.deepEqual(getZoneLookupCandidates("example.com."), ["example.com"]);
	assert.deepEqual(getZoneLookupCandidates("a..b.example.com"), ["a.b.example.com", "b.example.com", "example.com"]);
});

test("getZoneLookupCandidates has no candidates for a single label or empty input", () => {
	assert.deepEqual(getZoneLookupCandidates("localhost"), []);
	assert.deepEqual(getZoneLookupCandidates(""), []);
});

test("isZoneApex compares the canonical names exactly", () => {
	assert.equal(isZoneApex("example.com", "example.com"), true);
	assert.equal(isZoneApex("www.example.com", "example.com"), false);
	assert.equal(isZoneApex("EXAMPLE.COM", "example.com"), false);
});
