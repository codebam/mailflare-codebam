import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

// Domain names are canonicalized before Cloudflare zone lookup and validation,
// so pin the exact strings these pure helpers produce from untrusted input.

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = mkdtempSync(join(root, "tests", ".tmp-domain-utils-normalization-"));
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

test("normalizeHostname trims, lowercases, drops trailing dots and punycodes IDNs", () => {
	assert.equal(normalizeHostname("  Example.COM.  "), "example.com");
	assert.equal(normalizeHostname("Example.COM..."), "example.com");
	assert.equal(normalizeHostname("BÜCHER.example"), "xn--bcher-kva.example");
	assert.equal(normalizeHostname(""), "");
});

test("normalizeHostname leaves input the URL parser cannot read trimmed and lowercased", () => {
	for (const value of [" bad host ", "user@example.com", "https://example.com", "example.com:443", "exa#mple.com", "exa?mple.com", "a\\b"]) {
		assert.equal(normalizeHostname(value), value.trim().toLowerCase().replace(/\.+$/, ""), value);
	}
});

test("isValidHostname accepts DNS names but rejects IPs, schemes and malformed labels", () => {
	for (const name of ["example.com", "sub.example.co.uk", "a-b.example.com", "xn--bcher-kva.de"]) {
		assert.equal(isValidHostname(name), true, name);
	}
	for (const name of ["example", "example..com", "example.com.", "-bad.example.com", "bad-.example.com", "bad_example.com", "https://example.com", "user@example.com", "127.0.0.1", "0x7f.1", "", `${"a".repeat(250)}.com`]) {
		assert.equal(isValidHostname(name), false, name);
	}
});

test("getZoneLookupCandidates walks from the full name down to the zone", () => {
	assert.deepEqual(getZoneLookupCandidates("mail.example.com"), ["mail.example.com", "example.com"]);
	assert.deepEqual(getZoneLookupCandidates("a.b.example.com"), ["a.b.example.com", "b.example.com", "example.com"]);
	assert.deepEqual(getZoneLookupCandidates("example.com"), ["example.com"]);
	assert.deepEqual(getZoneLookupCandidates("example"), []);
	assert.deepEqual(getZoneLookupCandidates(""), []);
	assert.deepEqual(getZoneLookupCandidates(".example.com."), ["example.com"]);
});

test("isZoneApex matches only the exact zone name", () => {
	assert.equal(isZoneApex("example.com", "example.com"), true);
	assert.equal(isZoneApex("mail.example.com", "example.com"), false);
	assert.equal(isZoneApex("EXAMPLE.com", "example.com"), false);
});
