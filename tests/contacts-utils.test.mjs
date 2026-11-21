import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = mkdtempSync(join(tmpdir(), "mailflare-contacts-utils-"));
after(() => rmSync(outDir, { recursive: true, force: true }));

await build({
	entryPoints: [join(root, "src/lib/contacts/utils.ts")],
	outfile: join(outDir, "contacts.mjs"),
	bundle: true,
	platform: "node",
	format: "esm",
	target: "node22",
	logLevel: "silent",
	alias: { "@": join(root, "src") },
	external: ["react", "react-dom", "next", "next/*"],
});
const contacts = await import(pathToFileURL(join(outDir, "contacts.mjs")).href);

test("getContactId trims and lowercases the email but leaves the user id alone", () => {
	assert.equal(contacts.getContactId("u1", "  Ada@Example.COM  "), "u1:ada@example.com");
	assert.equal(contacts.getContactId("u1", "ada@example.com"), "u1:ada@example.com");
	assert.equal(contacts.getContactId("U1", "Ada@Example.com"), "U1:ada@example.com");
});

test("getContactNameFromAddress returns only a genuine display name", () => {
	assert.equal(contacts.getContactNameFromAddress('"Ada Lovelace" <ada@example.com>'), "Ada Lovelace");
	assert.equal(contacts.getContactNameFromAddress("Ada Lovelace <ada@example.com>"), "Ada Lovelace");
	assert.equal(contacts.getContactNameFromAddress('"  Ada  " <ada@example.com>'), "Ada");
	assert.equal(contacts.getContactNameFromAddress("ada@example.com"), null);
	assert.equal(contacts.getContactNameFromAddress("  ada@example.com  "), null);
	assert.equal(contacts.getContactNameFromAddress("ada@example.com <ada@example.com>"), null);
});

test("getDisplayNameForAddress prefers a contact name, then the header name, then the local part", () => {
	assert.equal(contacts.getDisplayNameForAddress("ada@example.com", "  My Contact  "), "My Contact");
	assert.equal(contacts.getDisplayNameForAddress('"Header Name" <ada@example.com>', "Contact Name"), "Contact Name");
	assert.equal(contacts.getDisplayNameForAddress('"Header Name" <ada@example.com>'), "Header Name");
	assert.equal(contacts.getDisplayNameForAddress("ada@example.com"), "ada");
	assert.equal(contacts.getDisplayNameForAddress("ADA@Example.com"), "ada");
	assert.equal(contacts.getDisplayNameForAddress("ada@example.com", "   "), "ada");
	assert.equal(contacts.getDisplayNameForAddress("not-an-address"), "not-an-address");
});
