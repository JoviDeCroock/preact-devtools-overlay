#!/usr/bin/env node
// Re-vendors the upstream devtools sources pinned in `upstream.json` and
// re-applies our local patches on top of them.
//
//   node scripts/sync-upstream.mjs                 # sync everything
//   node scripts/sync-upstream.mjs preact-devtools # sync a single upstream
//   node scripts/sync-upstream.mjs --check         # fail if vendor/ differs from upstream+patches
//   node scripts/sync-upstream.mjs --update-patches # rewrite patches from your edits in vendor/
//
// Patches live in `patches/<name>/*.patch` and are applied in lexical order
// with `git apply`. Paths inside a patch are relative to the vendor dir.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const config = JSON.parse(
	fs.readFileSync(path.join(root, "upstream.json"), "utf8"),
);

const args = process.argv.slice(2);
const check = args.includes("--check");
const updatePatches = args.includes("--update-patches");
if (check && updatePatches) {
	console.error("--check and --update-patches are mutually exclusive");
	process.exit(1);
}
const only = args.filter(a => !a.startsWith("--"));
const names = Object.keys(config).filter(
	k => !k.startsWith("$") && (only.length === 0 || only.includes(k)),
);

if (only.length && names.length !== only.length) {
	console.error(`Unknown upstream(s): ${only.join(", ")}`);
	process.exit(1);
}

const run = (cmd, argv, opts = {}) =>
	execFileSync(cmd, argv, { stdio: "pipe", encoding: "utf8", ...opts });

const isTestFile = file =>
	/\.test\.tsx?$/.test(file) || /(^|\/)__snapshots__(\/|$)/.test(file);

function copyFiltered(src, dest) {
	const stat = fs.statSync(src);
	if (stat.isDirectory()) {
		for (const entry of fs.readdirSync(src)) {
			copyFiltered(path.join(src, entry), path.join(dest, entry));
		}
		return;
	}
	if (isTestFile(src)) return;
	fs.mkdirSync(path.dirname(dest), { recursive: true });
	fs.copyFileSync(src, dest);
}

let failed = false;

for (const name of names) {
	const { repo, ref, dest, patches, copy } = config[name];
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `sync-${name}-`));
	const checkout = path.join(tmp, "src");
	// Always assemble in the temp dir: `git apply` inside our own repo would
	// resolve patch paths against the repo root and silently skip them.
	const out = path.join(tmp, "out");

	console.log(`[${name}] fetching ${repo}@${ref.slice(0, 12)}`);
	fs.mkdirSync(checkout);
	run("git", ["init", "-q"], { cwd: checkout });
	run("git", ["remote", "add", "origin", repo], { cwd: checkout });
	run("git", ["fetch", "-q", "--depth", "1", "origin", ref], { cwd: checkout });
	run("git", ["checkout", "-q", "FETCH_HEAD"], { cwd: checkout });

	fs.rmSync(out, { recursive: true, force: true });
	for (const [from, to] of Object.entries(copy)) {
		copyFiltered(path.join(checkout, from), path.join(out, to));
	}

	const patchDir = path.join(root, patches);
	const patchFiles = fs.existsSync(patchDir)
		? fs
				.readdirSync(patchDir)
				.filter(f => f.endsWith(".patch"))
				.sort()
		: [];

	if (updatePatches) {
		// Diff the pristine upstream tree against the (hand-edited) vendor dir
		// inside a throwaway repo, so new and deleted files are included and
		// paths come out relative to the vendor dir.
		if (patchFiles.length > 1) {
			console.error(
				`[${name}] --update-patches only supports a single patch per upstream, found ${patchFiles.length}`,
			);
			process.exit(1);
		}
		const diffRepo = path.join(tmp, "diff");
		// Ignore the user's git config (diff.noprefix, color.ui, external diff
		// drivers, ...) so the patch format is always what `git apply` expects.
		const gitEnv = {
			...process.env,
			GIT_CEILING_DIRECTORIES: tmp,
			GIT_CONFIG_GLOBAL: os.devNull,
			GIT_CONFIG_NOSYSTEM: "1",
		};
		fs.cpSync(out, diffRepo, { recursive: true });
		run("git", ["init", "-q"], { cwd: diffRepo, env: gitEnv });
		run("git", ["add", "-A"], { cwd: diffRepo, env: gitEnv });
		run(
			"git",
			["-c", "user.name=sync", "-c", "user.email=sync@localhost", "commit", "-q", "-m", "upstream"],
			{ cwd: diffRepo, env: gitEnv },
		);
		for (const entry of fs.readdirSync(diffRepo)) {
			if (entry !== ".git") fs.rmSync(path.join(diffRepo, entry), { recursive: true });
		}
		// Only files git would track (no .DS_Store or other ignored junk).
		const vendorFiles = run(
			"git",
			["ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", dest],
			{ cwd: root },
		)
			.split("\0")
			.filter(Boolean)
			.filter(f => fs.existsSync(path.join(root, f)));
		for (const file of vendorFiles) {
			const rel = path.relative(path.join(root, dest), path.join(root, file));
			if (rel === "UPSTREAM.md") continue;
			fs.mkdirSync(path.dirname(path.join(diffRepo, rel)), { recursive: true });
			fs.copyFileSync(path.join(root, file), path.join(diffRepo, rel));
		}
		run("git", ["add", "-A"], { cwd: diffRepo, env: gitEnv });
		const diff = run(
			"git",
			[
				"diff",
				"--cached",
				"--binary",
				"--no-color",
				"--no-ext-diff",
				"--src-prefix=a/",
				"--dst-prefix=b/",
			],
			{ cwd: diffRepo, env: gitEnv },
		);
		const target = path.join(patchDir, patchFiles[0] ?? "0001-local.patch");
		if (diff.trim() === "") {
			if (patchFiles[0]) fs.rmSync(target);
			console.log(`[${name}] no local changes, removed patch`);
		} else {
			fs.mkdirSync(patchDir, { recursive: true });
			fs.writeFileSync(target, diff);
			console.log(`[${name}] wrote ${path.relative(root, target)}`);
		}
		fs.rmSync(tmp, { recursive: true, force: true });
		continue;
	}

	for (const patch of patchFiles) {
		console.log(`[${name}] applying ${patch}`);
		try {
			run(
				"git",
				["apply", "--verbose", "--whitespace=nowarn", path.join(patchDir, patch)],
				{ cwd: out, env: { ...process.env, GIT_CEILING_DIRECTORIES: tmp } },
			);
		} catch (err) {
			console.error(`[${name}] patch ${patch} failed to apply:\n${err.stderr}`);
			process.exit(1);
		}
	}

	fs.writeFileSync(
		path.join(out, "UPSTREAM.md"),
		`<!-- Generated by scripts/sync-upstream.mjs. Do not edit by hand. -->\n` +
			`# Vendored from ${repo}\n\n` +
			`- ref: \`${ref}\`\n` +
			`- patches: ${patchFiles.length ? patchFiles.map(p => `\`${patches}/${p}\``).join(", ") : "none"}\n\n` +
			`Do not edit files in this directory directly. Change the patches in \`${patches}\`\n` +
			`and run \`pnpm sync-upstream ${name}\` instead.\n`,
	);

	if (!check) {
		const target = path.join(root, dest);
		fs.rmSync(target, { recursive: true, force: true });
		fs.cpSync(out, target, { recursive: true });
	} else {
		try {
			run("git", ["diff", "--no-index", "--stat", out, path.join(root, dest)]);
			console.log(`[${name}] vendor/ is up to date`);
		} catch (err) {
			failed = true;
			console.error(`[${name}] vendor/ is out of sync:\n${err.stdout}`);
		}
	}

	fs.rmSync(tmp, { recursive: true, force: true });
}

if (failed) process.exit(1);
