import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = mkdtempSync(join(root, "tests", ".tmp-password-helpers-"));
after(() => rmSync(outDir, { recursive: true, force: true }));

await build({
	stdin: {
		contents: `
			export { PASSWORDLESS_PASSWORD_HASH, hasPasswordHash, hashPassword, verifyPassword } from "./src/lib/auth/password.ts";
		`,
		resolveDir: root,
		sourcefile: "password-helpers-entry.ts",
	},
	outfile: join(outDir, "entry.mjs"),
	bundle: true,
	platform: "node",
	format: "esm",
	target: "node22",
	tsconfig: join(root, "tsconfig.json"),
	packages: "external",
	logLevel: "silent",
});

const { PASSWORDLESS_PASSWORD_HASH, hasPasswordHash, hashPassword, verifyPassword } =
	await import(pathToFileURL(join(outDir, "entry.mjs")).href);

test("PASSWORDLESS_PASSWORD_HASH is the sentinel passkey-only value", () => {
	assert.equal(PASSWORDLESS_PASSWORD_HASH, "!passkey-only");
});

test("hasPasswordHash accepts real bcrypt hashes", () => {
	assert.equal(hasPasswordHash("$2b$12$abcdefghijklmnopqrstuv"), true);
	assert.equal(hasPasswordHash("$2a$10$abcdefghijklmnopqrstuv"), true);
});

test("hasPasswordHash rejects missing, sentinel and non-bcrypt values", () => {
	for (const value of [null, undefined, "", "!passkey-only", "plaintext", "$1$md5hash", 0, false]) {
		assert.equal(hasPasswordHash(value), false, `expected false for ${String(value)}`);
	}
});

test("verifyPassword rejects the sentinel and missing hashes without throwing", () => {
	assert.equal(verifyPassword("anything", PASSWORDLESS_PASSWORD_HASH), false);
	assert.equal(verifyPassword("anything", null), false);
	assert.equal(verifyPassword("anything", undefined), false);
});

test("a real hash round-trips through hasPasswordHash and verifyPassword", () => {
	const hash = hashPassword("correct horse battery");
	assert.equal(hasPasswordHash(hash), true);
	assert.equal(verifyPassword("correct horse battery", hash), true);
	assert.equal(verifyPassword("wrong", hash), false);
});
