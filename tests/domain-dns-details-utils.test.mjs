import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const directory = mkdtempSync(join(root, "node_modules", "mailflare-domain-dns-details-test-"));
after(() => rmSync(directory, { recursive: true, force: true }));
await build({
	stdin: {
		contents: `
			export { getDnsRecordLabel } from "./src/app/(admin)/domains/domain-dns-details-utils.ts";
		`,
		resolveDir: root,
		sourcefile: "domain-dns-details-test-entry.ts",
	},
	outfile: join(directory, "entry.mjs"),
	bundle: true,
	platform: "node",
	format: "esm",
	target: "node24",
	tsconfig: join(root, "tsconfig.json"),
	packages: "external",
	logLevel: "silent",
});
const { getDnsRecordLabel } = await import(pathToFileURL(join(directory, "entry.mjs")).href);

test("a complete record shows its type, name, destination and priority", () => {
	assert.equal(getDnsRecordLabel({ type: "MX", name: "example.com", content: "mail.example.com", priority: 10 }), "MX · example.com → mail.example.com (priority 10)");
	assert.equal(getDnsRecordLabel({ type: "MX", name: "example.com", priority: 5 }), "MX · example.com (priority 5)");
});

test("missing fields fall back to Domain, DNS and no destination", () => {
	assert.equal(getDnsRecordLabel({}), "DNS · Domain");
	assert.equal(getDnsRecordLabel({ type: "A", content: "192.0.2.1" }), "A · Domain → 192.0.2.1");
	assert.equal(getDnsRecordLabel({ type: "A", name: "www.example.com" }), "A · www.example.com");
});

test("empty strings fall back, but an explicit priority of zero is shown", () => {
	assert.equal(getDnsRecordLabel({ type: "", name: "", content: "", priority: 0 }), "DNS · Domain (priority 0)");
});
