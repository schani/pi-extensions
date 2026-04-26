import { existsSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";

const require = createRequire(import.meta.url);

function fileUrl(path) {
	return pathToFileURL(path).href;
}

function tryPackageFromRoot(root) {
	if (!root) return undefined;
	const candidate = join(root, "glimpseui", "src", "glimpse.mjs");
	return existsSync(candidate) ? fileUrl(candidate) : undefined;
}

function unique(values) {
	return [...new Set(values.filter(Boolean))];
}

export function resolveGlimpseImport() {
	try {
		const resolved = require.resolve("glimpseui");
		return isAbsolute(resolved) ? fileUrl(resolved) : resolved;
	} catch {}

	try {
		const root = execFileSync(process.platform === "win32" ? "npm.cmd" : "npm", ["root", "-g"], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
		}).trim();
		const resolved = tryPackageFromRoot(root);
		if (resolved) return resolved;
	} catch {}

	const nodePrefix = dirname(dirname(process.execPath));
	const roots = process.platform === "win32"
		? [
			join(nodePrefix, "node_modules"),
			join(dirname(nodePrefix), "node_modules"),
		]
		: [
			join(nodePrefix, "lib", "node_modules"),
			join(dirname(nodePrefix), "lib", "node_modules"),
		];

	for (const root of unique(roots)) {
		const resolved = tryPackageFromRoot(root);
		if (resolved) return resolved;
	}

	return undefined;
}

export async function importGlimpse() {
	const specifier = resolveGlimpseImport();
	if (!specifier) {
		throw new Error("Cannot find module 'glimpseui'. Run `npm install` in this package, or install glimpseui globally with the same Node that runs pi.");
	}
	return import(specifier);
}
