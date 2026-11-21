import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const directory = mkdtempSync(join(root, "tests", ".tmp-domain-utils-pure-"));
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
const {
	normalizeHostname,
	isValidHostname,
	getZoneLookupCandidates,
	isZoneApex,
	domainListOwnerIds,
} = await import(pathToFileURL(outfile).href);

test("normalizeHostname trims, lowercases and drops trailing dots", () => {
	assert.equal(normalizeHostname("  Example.COM. "), "example.com");
	assert.equal(normalizeHostname("mail.example.com..."), "mail.example.com");
});

test("normalizeHostname punycodes internationalised names", () => {
	assert.equal(normalizeHostname("münchen.de"), "xn--mnchen-3ya.de");
});

test("normalizeHostname returns unreadable input trimmed and lowercased", () => {
	assert.equal(normalizeHostname(""), "");
	assert.equal(normalizeHostname("https://Example.com"), "https://example.com");
	assert.equal(normalizeHostname("a b.example.com"), "a b.example.com");
});

test("isValidHostname accepts dotted names but rejects IPs and single labels", () => {
	assert.equal(isValidHostname("example.com"), true);
	assert.equal(isValidHostname("mail.example.com"), true);
	assert.equal(isValidHostname("xn--mnchen-3ya.de"), true);
	assert.equal(isValidHostname("example"), false);
	assert.equal(isValidHostname("1.2.3.4"), false);
	assert.equal(isValidHostname("0x7f.1"), false);
	assert.equal(isValidHostname("example..com"), false);
	assert.equal(isValidHostname("-bad.example.com"), false);
	assert.equal(isValidHostname("https://example.com"), false);
});

test("getZoneLookupCandidates walks from the full name to the registrable name", () => {
	assert.deepEqual(getZoneLookupCandidates("mail.example.com"), ["mail.example.com", "example.com"]);
	assert.deepEqual(getZoneLookupCandidates("example.com"), ["example.com"]);
	assert.deepEqual(getZoneLookupCandidates("a.b.c.d"), ["a.b.c.d", "b.c.d", "c.d"]);
	assert.deepEqual(getZoneLookupCandidates("example"), []);
	assert.deepEqual(getZoneLookupCandidates(""), []);
});

test("getZoneLookupCandidates ignores empty labels", () => {
	assert.deepEqual(getZoneLookupCandidates(".example.com."), ["example.com"]);
});

test("isZoneApex matches only the exact zone name", () => {
	assert.equal(isZoneApex("example.com", "example.com"), true);
	assert.equal(isZoneApex("mail.example.com", "example.com"), false);
	assert.equal(isZoneApex("example.com.", "example.com"), false);
});

test("normalizeHostname trims, lowercases, drops trailing dots and punycodes (edges)", () => {
	assert.equal(normalizeHostname("  EXAMPLE.COM.  "), "example.com");
	assert.equal(normalizeHostname("example.com.."), "example.com");
	assert.equal(normalizeHostname("MÜNCHEN.de"), "xn--mnchen-3ya.de");
	assert.equal(normalizeHostname(""), "");
});

test("normalizeHostname leaves input the URL parser cannot safely read", () => {
	assert.equal(normalizeHostname("user@example.com"), "user@example.com");
	assert.equal(normalizeHostname("https://example.com"), "https://example.com");
	assert.equal(normalizeHostname("bad host.com"), "bad host.com");
	assert.equal(normalizeHostname("foo/bar"), "foo/bar");
	assert.equal(normalizeHostname("HTTPS://Example.com"), "https://example.com");
	assert.equal(normalizeHostname("0x7f.1"), "127.0.0.1");
});

test("isValidHostname accepts ordinary DNS names but not IPs or malformed labels", () => {
	assert.equal(isValidHostname("example.com"), true);
	assert.equal(isValidHostname("a.b.example.co.uk"), true);
	assert.equal(isValidHostname("xn--mnchen-3ya.de"), true);
	assert.equal(isValidHostname("example.c0m"), true);
	for (const bad of [
		"",
		"example",
		"EXAMPLE.COM",
		"-bad.example.com",
		"bad-.example.com",
		"exa_mple.com",
		"example..com",
		"example.123",
		"1.2.3.4",
		"0x7f.1",
		"127.0.0.1",
		"example.com.",
		`${"a".repeat(64)}.example.com`,
	]) assert.equal(isValidHostname(bad), false, bad);
});

test("isValidHostname enforces the 253-character DNS limit", () => {
	const max = ["a".repeat(63), "b".repeat(63), "c".repeat(63), "d".repeat(61)].join(".");
	assert.equal(max.length, 253);
	assert.equal(isValidHostname(max), true);
	assert.equal(isValidHostname(`${max}d`.slice(0, 254)), false);
});

test("getZoneLookupCandidates walks from the full name to the registrable zone", () => {
	assert.deepEqual(getZoneLookupCandidates("a.b.example.com"), [
		"a.b.example.com",
		"b.example.com",
		"example.com",
	]);
	assert.deepEqual(getZoneLookupCandidates("example.com."), ["example.com"]);
	assert.deepEqual(getZoneLookupCandidates("localhost"), []);
	assert.deepEqual(getZoneLookupCandidates(""), []);
});

test("isZoneApex is an exact, case-sensitive match", () => {
	assert.equal(isZoneApex("example.com", "example.com"), true);
	assert.equal(isZoneApex("www.example.com", "example.com"), false);
	assert.equal(isZoneApex("EXAMPLE.COM", "example.com"), false);
	assert.equal(isZoneApex("example.com", "other.com"), false);
});

test("a manager who created their own domains sees only their own id", () => {
	assert.deepEqual(
		domainListOwnerIds({ id: "usr_self", canManageMailboxes: true, createdByUserId: "usr_self" }),
		["usr_self"],
	);
});
