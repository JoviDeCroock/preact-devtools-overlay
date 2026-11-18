/**
 * Where a running dev server leaves its URL and token for the MCP server.
 *
 * Not in the project: Vite serves files under its root (and
 * `node_modules`) to anyone who can reach it, which would hand out the
 * token. One file per Vite root, in the user's cache directory:
 * `~/.cache/preact-devtools-overlay/` (`$XDG_CACHE_HOME`, `%LOCALAPPDATA%`
 * on Windows), readable by the current user only.
 *
 * Node only.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ServerInfo } from "./protocol.js";

/** Overrides the directory, e.g. for tests. */
export const STATE_DIR_ENV = "PREACT_DEVTOOLS_OVERLAY_STATE_DIR";

export function serverInfoDir(env: NodeJS.ProcessEnv = process.env): string {
	if (env[STATE_DIR_ENV]) return path.resolve(env[STATE_DIR_ENV]!);
	const base =
		env.XDG_CACHE_HOME ||
		(process.platform === "win32" && env.LOCALAPPDATA) ||
		path.join(os.homedir(), ".cache");
	return path.join(base, "preact-devtools-overlay");
}

function normalizeRoot(root: string): string {
	const resolved = path.resolve(root);
	return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

/** `server-<hash of the Vite root>.json` */
export function serverInfoPath(root: string, env: NodeJS.ProcessEnv = process.env): string {
	const hash = crypto.createHash("sha256").update(normalizeRoot(root)).digest("hex").slice(0, 16);
	return path.join(serverInfoDir(env), `server-${hash}.json`);
}

/** Writes `server.json`, readable by the current user only. */
export function writeServerInfo(file: string, info: ServerInfo): void {
	fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
	const tmp = `${file}.${process.pid}.tmp`;
	fs.writeFileSync(tmp, JSON.stringify(info, null, 2) + "\n", { mode: 0o600 });
	// `mode` only applies when the file is created.
	fs.chmodSync(tmp, 0o600);
	fs.renameSync(tmp, file);
}

/** Removes `server.json` if it still belongs to the server with `token`. */
export function removeServerInfo(file: string, token: string): void {
	try {
		const info = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<ServerInfo>;
		if (info.token === token) fs.rmSync(file, { force: true });
	} catch {
		// Already gone, or not ours.
	}
}

function alive(pid: unknown): boolean {
	if (typeof pid !== "number") return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		// EPERM: it exists, it just isn't ours.
		return (err as NodeJS.ErrnoException).code === "EPERM";
	}
}

function inside(child: string, parent: string): boolean {
	const rel = path.relative(parent, child);
	return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

/**
 * The info of a running dev server whose root is `start`, else the closest
 * one above it, else the newest one below it (monorepos, where the agent runs
 * from the repository root).
 */
export function findServerInfo(
	start: string,
	env: NodeJS.ProcessEnv = process.env,
): { file: string; info: ServerInfo } | null {
	const dir = serverInfoDir(env);
	let names: string[];
	try {
		names = fs.readdirSync(dir).filter(n => /^server-[0-9a-f]+\.json$/.test(n));
	} catch {
		return null;
	}
	const from = normalizeRoot(start);
	const above: Array<{ file: string; info: ServerInfo; depth: number }> = [];
	const below: Array<{ file: string; info: ServerInfo; mtime: number }> = [];
	for (const name of names) {
		const file = path.join(dir, name);
		let info: ServerInfo;
		let mtime: number;
		try {
			info = JSON.parse(fs.readFileSync(file, "utf8"));
			mtime = fs.statSync(file).mtimeMs;
		} catch {
			continue;
		}
		if (!info || typeof info.token !== "string" || typeof info.root !== "string" || !alive(info.pid)) continue;
		const root = normalizeRoot(info.root);
		if (root === from) return { file, info };
		if (inside(from, root)) above.push({ file, info, depth: root.length });
		else if (inside(root, from)) below.push({ file, info, mtime });
	}
	above.sort((a, b) => b.depth - a.depth);
	below.sort((a, b) => b.mtime - a.mtime);
	const found = above[0] ?? below[0];
	return found ? { file: found.file, info: found.info } : null;
}
