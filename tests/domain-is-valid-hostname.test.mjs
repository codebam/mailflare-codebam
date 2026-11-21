import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

// A domain must be a hostname, not an IP, or zone lookups and mailbox
// addresses get built from nonsense. Input is normalized before this check.

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = mkdtempSync(join(root, "tests", ".tmp-domain-is-valid-hostname-"));
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
const { isValidHostname } = await import(pathToFileURL(outfile).href);

test("isValidHostname accepts ordinary multi-label names", () => {
	for (const host of ["example.com", "mail.example.co.uk", "xn--bcher-kva.example", "a-b.example"]) {
		assert.equal(isValidHostname(host), true, host);
	}
});

test("isValidHostname rejects single labels, trailing dots and uppercase", () => {
	for (const host of ["localhost", "example.com.", "Example.com", "", "exa mple.com"]) {
		assert.equal(isValidHostname(host), false, host);
	}
});

test("isValidHostname rejects IPs and numeric TLDs, including hex forms", () => {
	for (const host of ["127.0.0.1", "example.123", "0x7f.1", "192.168.0.1"]) {
		assert.equal(isValidHostname(host), false, host);
	}
});

test("isValidHostname rejects malformed and over-long labels", () => {
	for (const host of ["-example.com", "example-.com", "ex..ample.com", `${"a".repeat(64)}.com`]) {
		assert.equal(isValidHostname(host), false, host.slice(0, 20));
	}
});
