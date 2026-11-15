// Copyright (c) 2026 Sean Behan
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Export the scoped-automation tool manifest (name, description, JSON Schema,
// annotations) for the MCP stdio bridge in agentic-inbox-codebam. The bridge
// authenticates with an ain1_/ain2_ scoped token, which the /mcp endpoint does
// not accept, so it serves tools/list from this snapshot and dispatches
// tools/call to POST /api/v1/scoped/<tool>. Regenerate whenever the facade's
// tool set or schemas change:
//
//   node scripts/export-mcp-manifest.mjs [out.json]
//
// The capture mirrors src/lib/scoped/dispatch.ts (same four register groups
// plus the list_mailboxes mirror), so the manifest cannot drift from the
// tools the scoped surface actually dispatches.

import { build } from "esbuild";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = process.argv[2] ?? join(root, "mcp-manifest.json");
const tmp = mkdtempSync(join(tmpdir(), "mailflare-manifest-"));

const entry = join(tmp, "entry.ts");
writeFileSync(
	entry,
	`
import { writeFileSync } from "node:fs";
import { z } from "zod";
import { registerOrganizeMcpTools } from "@/lib/mcp/organize-tools";
import { registerMailMcpTools } from "@/lib/mcp/mail-tools";
import { registerCompatMailTools } from "@/lib/mcp/compat-mail";
import { registerCompatActionTools } from "@/lib/mcp/compat-actions";

const captured = [];
const server = {
	registerTool(name, meta) {
		captured.push({ name, description: meta.description ?? "", inputSchema: meta.inputSchema, annotations: meta.annotations ?? {} });
	},
};
// Registration only records static schemas; handlers are never invoked, so a
// dummy principal/env is sufficient (mirrors dispatch.captureTools).
const principal = {
	keyId: "manifest",
	user: { id: "manifest", role: "admin", email: "manifest@local" },
	scopes: ["mcp:read", "mcp:draft", "mcp:send", "mcp:organize", "mcp:request-send", "mcp:calendar-read", "mcp:calendar-write"],
	mailboxIds: [],
};
const env = {};
registerOrganizeMcpTools(server, principal, env);
registerMailMcpTools(server, principal, env);
registerCompatMailTools(server, principal, env);
registerCompatActionTools(server, principal, env);
captured.push({ name: "list_mailboxes", description: "List mailboxes allowed for this token", inputSchema: z.object({}), annotations: { readOnlyHint: true, openWorldHint: false } });

const manifest = [];
for (const tool of captured) {
	let inputSchema;
	try {
		inputSchema = z.toJSONSchema(tool.inputSchema, { io: "input" });
	} catch (error) {
		console.error("schema fallback for", tool.name, ":", error.message);
		inputSchema = { type: "object", additionalProperties: true };
	}
	manifest.push({ name: tool.name, description: tool.description, inputSchema, annotations: tool.annotations });
}
manifest.sort((a, b) => a.name.localeCompare(b.name));
writeFileSync(process.argv[2], JSON.stringify(manifest, null, "\\t") + "\\n");
console.error("exported", manifest.length, "tools");
`,
);

try {
	await build({
		entryPoints: [entry],
		outfile: join(tmp, "entry.mjs"),
		bundle: true,
		platform: "node",
		format: "esm",
		target: "node22",
		tsconfig: join(root, "tsconfig.json"),
		absWorkingDir: root,
		nodePaths: [join(root, "node_modules")],
		external: [
			"next", "better-sqlite3", "nodemailer", "smtp-server", "mailauth", "ws", "react", "react-dom",
			"pg", "postgres", "mysql2", "@libsql/client", "@neondatabase/serverless", "@planetscale/database", "@electric-sql/pglite",
		],
		alias: { "cloudflare:workers": join(root, "server/runtime/cloudflare-workers.ts") },
		banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
		define: { "process.env.MAILFLARE_RUNTIME": '"node"' },
		logLevel: "silent",
	});
	execFileSync(process.execPath, [join(tmp, "entry.mjs"), out], { stdio: "inherit" });
	console.log(`wrote ${out}`);
} finally {
	rmSync(tmp, { recursive: true, force: true });
}