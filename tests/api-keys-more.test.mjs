import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test, { after } from "node:test";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = mkdtempSync(join(root, "node_modules", "api-keys-more-test-"));
after(() => rmSync(outDir, { recursive: true, force: true }));

await build({
	stdin: {
		contents: `
			export { apiKeyLookupPrefix, parseScopes, scopesToJson } from "./src/lib/api-keys.ts";
		`,
		resolveDir: root,
		sourcefile: "api-keys-more-entry.ts",
	},
	outfile: join(outDir, "entry.mjs"),
	bundle: true,
	platform: "node",
	format: "esm",
	target: "node22",
	tsconfig: join(root, "tsconfig.json"),
	alias: { "@": join(root, "src") },
	packages: "external",
	logLevel: "silent",
});

const { apiKeyLookupPrefix, parseScopes, scopesToJson } = await import(pathToFileURL(join(outDir, "entry.mjs")).href);

test("apiKeyLookupPrefix keeps six characters for short app passwords and twelve for long keys", () => {
	const appPassword = "Ab3xY7zQ9mKp2RsT";
	assert.equal(appPassword.length, 16);
	assert.equal(apiKeyLookupPrefix(appPassword), "Ab3xY7");
	assert.equal(apiKeyLookupPrefix("short"), "short");
	assert.equal(apiKeyLookupPrefix("123456"), "123456");
	assert.equal(apiKeyLookupPrefix(""), "");
	assert.equal(apiKeyLookupPrefix("x".repeat(17)), "x".repeat(12));
	const apiKey = `ep_${"a".repeat(40)}`;
	assert.equal(apiKeyLookupPrefix(apiKey), apiKey.slice(0, 12));
});

test("parseScopes returns only string entries and tolerates malformed input", () => {
	assert.deepEqual(parseScopes('["jmap","mcp:read"]'), ["jmap", "mcp:read"]);
	assert.deepEqual(parseScopes('["jmap",1,null,{"a":1},true,"mcp"]'), ["jmap", "mcp"]);
	assert.deepEqual(parseScopes("[]"), []);
	assert.deepEqual(parseScopes('{"scope":"jmap"}'), []);
	assert.deepEqual(parseScopes('"jmap"'), []);
	assert.deepEqual(parseScopes("42"), []);
	assert.deepEqual(parseScopes("null"), []);
	assert.deepEqual(parseScopes(""), []);
	assert.deepEqual(parseScopes("not json"), []);
});

test("scopesToJson round-trips with parseScopes", () => {
	assert.equal(scopesToJson(["jmap"]), '["jmap"]');
	assert.equal(scopesToJson([]), "[]");
	assert.deepEqual(parseScopes(scopesToJson(["jmap", "mcp:read"])), ["jmap", "mcp:read"]);
});
