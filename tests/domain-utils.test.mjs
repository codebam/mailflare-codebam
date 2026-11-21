import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

// Cloudflare zone names are punycode and carry no trailing dot, so untrusted
// host input is normalised before any zone lookup or validity check.

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = mkdtempSync(join(root, "tests", ".tmp-domain-utils-"));
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

test("normalizeHostname trims, lowercases, drops trailing dots and punycodes", () => {
	for (const [input, expected] of [
		["  Example.COM.  ", "example.com"],
		["EXAMPLE.COM..", "example.com"],
		["bücher.example", "xn--bcher-kva.example"],
		["xn--bcher-kva.example", "xn--bcher-kva.example"],
	]) {
		assert.equal(normalizeHostname(input), expected, input);
	}
});

test("normalizeHostname returns unreadable input trimmed and lowercased", () => {
	for (const [input, expected] of [
		["bad host", "bad host"],
		["user@example.com", "user@example.com"],
		["http://example.com", "http://example.com"],
		["example.com:443", "example.com:443"],
		["...", ""],
		["", ""],
	]) {
		assert.equal(normalizeHostname(input), expected, input);
	}
});

test("isValidHostname accepts domain names, not IPs, single labels or bad labels", () => {
	for (const host of ["example.com", "a-b.example.co.uk", "sub.example.com"]) {
		assert.equal(isValidHostname(host), true, host);
	}
	for (const host of [
		"-bad.example.com",
		"bad-.example.com",
		"example.123",
		"127.0.0.1",
		"0x7f.1",
		"example",
		"EXAMPLE.COM",
		"example.com.",
	]) {
		assert.equal(isValidHostname(host), false, host);
	}
});

test("getZoneLookupCandidates walks from the full name down to the apex", () => {
	assert.deepEqual(getZoneLookupCandidates("a.b.example.com"), ["a.b.example.com", "b.example.com", "example.com"]);
	assert.deepEqual(getZoneLookupCandidates("example.com"), ["example.com"]);
	assert.deepEqual(getZoneLookupCandidates("example"), []);
});

test("isZoneApex matches an exact zone name only", () => {
	assert.equal(isZoneApex("example.com", "example.com"), true);
	assert.equal(isZoneApex("www.example.com", "example.com"), false);
});
