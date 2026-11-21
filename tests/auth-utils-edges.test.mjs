import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const bundleDirectory = mkdtempSync(join(root, "node_modules", "mailflare-auth-edges-"));
after(() => rmSync(bundleDirectory, { recursive: true, force: true }));
await build({
	entryPoints: [join(root, "src/lib/auth/setup-utils.ts")],
	outfile: join(bundleDirectory, "entry.mjs"),
	bundle: true,
	platform: "node",
	format: "esm",
	target: "node24",
	tsconfig: join(root, "tsconfig.json"),
	packages: "external",
	logLevel: "silent",
});
const { isMissingUsersTableError } = await import(pathToFileURL(join(bundleDirectory, "entry.mjs")).href);

test("recognises the missing-users-table wording of each supported database", () => {
	assert.equal(isMissingUsersTableError(new Error("no such table: users")), true);
	assert.equal(isMissingUsersTableError(new Error("SQLITE_ERROR: no such table: users")), true);
	assert.equal(isMissingUsersTableError(new Error('relation "users" does not exist')), true);
	assert.equal(isMissingUsersTableError(new Error("table 'main.users' doesn't exist")), true);
	assert.equal(isMissingUsersTableError(new Error("No Such Table: USERS")), true);
});

test("ignores errors about other tables or unrelated failures", () => {
	assert.equal(isMissingUsersTableError(new Error("no such table: messages")), false);
	assert.equal(isMissingUsersTableError(new Error('relation "messages" does not exist')), false);
	assert.equal(isMissingUsersTableError(new Error("permission denied")), false);
});

test("walks nested causes but stops on a cycle", () => {
	const wrapped = new Error("setup failed");
	wrapped.cause = new Error("inner query failed");
	wrapped.cause.cause = new Error("no such table: users");
	assert.equal(isMissingUsersTableError(wrapped), true);

	const viaPlainObject = new Error("setup failed");
	viaPlainObject.cause = { cause: new Error("no such table: users") };
	assert.equal(isMissingUsersTableError(viaPlainObject), true);

	const cyclic = new Error("outer");
	cyclic.cause = cyclic;
	assert.equal(isMissingUsersTableError(cyclic), false);
});

test("returns false for non-Error values", () => {
	assert.equal(isMissingUsersTableError(null), false);
	assert.equal(isMissingUsersTableError(undefined), false);
	assert.equal(isMissingUsersTableError("no such table: users"), false);
	assert.equal(isMissingUsersTableError({ message: "no such table: users" }), false);
});
