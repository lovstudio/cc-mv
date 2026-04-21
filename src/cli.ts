#!/usr/bin/env node
/**
 * cc-mv — move a project folder and migrate its Claude Code state.
 *
 * Three-in-one:
 *   1. mv <FROM> <TO>                  (fs.renameSync, EXDEV → shell `mv`)
 *   2. rewrite session store           (~/.claude/projects/<slug>/*.jsonl cwd)
 *   3. rewrite prompt history + running sessions
 *         (~/.claude/history.jsonl .project, ~/.claude/sessions/*.json .cwd)
 *
 * Subdirectory sessions are handled too: any slug under ~/.claude/projects/
 * that matches <fromSlug> OR begins with <fromSlug>-  corresponds to FROM
 * or a descendant path — all are migrated in one go.
 *
 * Also invoked as `cc-migrate-session` (alias): that entry point skips the
 * actual fs mv and only migrates CC state — backwards-compatible behavior.
 *
 * Session-level granularity:
 *   --session <id> (repeatable) / --grep <pattern> / --pick
 *   restrict migration to specific sessions inside FROM's slug dir (root only;
 *   sub-dirs are ignored in session-level mode). fs mv is disabled in this mode.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as readline from "node:readline";
import { spawnSync } from "node:child_process";

// ---------------------------------------------------------------------------
// Slug rule (reverse-engineered from ~/.claude/projects/)
// ---------------------------------------------------------------------------
// CC replaces every character that is NOT [A-Za-z0-9] with "-".
// This means "/" becomes "-", but so does ".", "@", and every CJK char.
export function pathToSlug(absPath: string): string {
  return absPath.replace(/[^A-Za-z0-9]/g, "-");
}

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------
function expandTilde(p: string): string {
  if (p.startsWith("~/") || p === "~") return path.join(os.homedir(), p.slice(1));
  return p;
}

function normalizeInputPath(p: string): string {
  const abs = path.resolve(expandTilde(p));
  return abs.length > 1 && abs.endsWith("/") ? abs.slice(0, -1) : abs;
}

// ---------------------------------------------------------------------------
// Affected-slug discovery
// ---------------------------------------------------------------------------
// A slug belongs to FROM (or a descendant path) iff:
//   slug === fromSlug                       → FROM itself
//   slug.startsWith(fromSlug + "-")         → a descendant (because any sub
//                                              path FROM/x slugifies to
//                                              fromSlug + "-" + pathToSlug(x))
// Returns one entry per such slug, with the reverse-derived "from path".
// We can't perfectly reverse a slug to a path in general (the slug is lossy),
// but we can read any jsonl inside the slug dir to recover the original cwd.
export interface AffectedSlug {
  slug: string;
  slugDir: string;
  sessionCount: number;
  sizeBytes: number;
  // The original absolute path this slug belongs to, read from the first
  // jsonl that has a cwd field. Null if the slug dir is empty / no cwd.
  originalPath: string | null;
}

export function findAffectedSlugs(projectsDir: string, fromSlug: string): AffectedSlug[] {
  if (!fs.existsSync(projectsDir)) return [];
  const entries = fs.readdirSync(projectsDir, { withFileTypes: true });
  const out: AffectedSlug[] = [];
  for (const ent of entries) {
    if (!ent.isDirectory()) continue;
    const slug = ent.name;
    if (slug !== fromSlug && !slug.startsWith(fromSlug + "-")) continue;
    const slugDir = path.join(projectsDir, slug);
    const info = summarizeSlugDir(slugDir);
    out.push({ slug, slugDir, ...info });
  }
  return out;
}

function summarizeSlugDir(slugDir: string): { sessionCount: number; sizeBytes: number; originalPath: string | null } {
  let sessionCount = 0;
  let sizeBytes = 0;
  let originalPath: string | null = null;
  for (const name of fs.readdirSync(slugDir)) {
    const p = path.join(slugDir, name);
    const st = fs.statSync(p);
    if (st.isFile() && name.endsWith(".jsonl")) {
      sessionCount += 1;
      sizeBytes += st.size;
      if (!originalPath) originalPath = readFirstCwd(p);
    }
  }
  return { sessionCount, sizeBytes, originalPath };
}

function readFirstCwd(jsonlPath: string): string | null {
  const content = fs.readFileSync(jsonlPath, "utf8");
  for (const line of content.split("\n")) {
    if (!line.trim()) continue;
    try {
      const obj = JSON.parse(line);
      if (typeof obj.cwd === "string") return obj.cwd;
    } catch {
      // skip
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Session summary (for listing + picking + grep)
// ---------------------------------------------------------------------------
export interface SessionSummary {
  sessionId: string;      // derived from filename (strip .jsonl)
  file: string;           // absolute path to the .jsonl
  slugDir: string;        // absolute path to the slug dir
  sizeBytes: number;
  mtime: string;          // ISO
  firstUserPrompt: string | null; // trimmed, truncated to 300 chars
  firstTimestamp: string | null;  // ISO of first record
  messageCount: number;
}

/**
 * Extract the first real user prompt (ignore system-reminder wrappers and
 * command-message/command-name/command-args-only entries as best-effort).
 * Returns a trimmed, ≤300-char string or null.
 */
function extractFirstUserPrompt(jsonlPath: string): string | null {
  const content = fs.readFileSync(jsonlPath, "utf8");
  for (const line of content.split("\n")) {
    if (!line.trim()) continue;
    let obj: any;
    try { obj = JSON.parse(line); } catch { continue; }
    if (obj.type !== "user") continue;
    const msg = obj.message;
    if (!msg) continue;
    let text: string | null = null;
    if (typeof msg.content === "string") text = msg.content;
    else if (Array.isArray(msg.content)) {
      const parts: string[] = [];
      for (const c of msg.content) {
        if (c && typeof c === "object" && c.type === "text" && typeof c.text === "string") parts.push(c.text);
      }
      text = parts.join(" ");
    }
    if (!text) continue;
    // strip common CC system-reminder wrappers so the "meat" surfaces
    text = text
      .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "")
      .replace(/<command-message>[\s\S]*?<\/command-message>/g, "")
      .replace(/<command-name>[\s\S]*?<\/command-name>/g, "")
      .replace(/<local-command-stdout>[\s\S]*?<\/local-command-stdout>/g, "")
      .replace(/<command-args>([\s\S]*?)<\/command-args>/g, "$1")
      .trim();
    if (!text) continue;
    if (text.length > 300) text = text.slice(0, 300) + "…";
    return text;
  }
  return null;
}

function readFirstTimestamp(jsonlPath: string): string | null {
  const content = fs.readFileSync(jsonlPath, "utf8");
  for (const line of content.split("\n")) {
    if (!line.trim()) continue;
    try {
      const obj = JSON.parse(line);
      if (typeof obj.timestamp === "string") return obj.timestamp;
    } catch { /* skip */ }
  }
  return null;
}

function countJsonlLines(jsonlPath: string): number {
  const content = fs.readFileSync(jsonlPath, "utf8");
  let n = 0;
  for (const line of content.split("\n")) if (line.trim()) n += 1;
  return n;
}

/**
 * List all sessions in the given slug dir (top-level .jsonl files only).
 * Sorted by mtime desc.
 */
export function listSessions(slugDir: string): SessionSummary[] {
  if (!fs.existsSync(slugDir)) return [];
  const out: SessionSummary[] = [];
  for (const name of fs.readdirSync(slugDir)) {
    if (!name.endsWith(".jsonl")) continue;
    const file = path.join(slugDir, name);
    const st = fs.statSync(file);
    if (!st.isFile()) continue;
    const sessionId = name.replace(/\.jsonl$/, "");
    out.push({
      sessionId,
      file,
      slugDir,
      sizeBytes: st.size,
      mtime: st.mtime.toISOString(),
      firstUserPrompt: extractFirstUserPrompt(file),
      firstTimestamp: readFirstTimestamp(file),
      messageCount: countJsonlLines(file),
    });
  }
  out.sort((a, b) => (b.mtime < a.mtime ? -1 : b.mtime > a.mtime ? 1 : 0));
  return out;
}

// ---------------------------------------------------------------------------
// jsonl rewrite (generic cwd-style prefix rewrite)
// ---------------------------------------------------------------------------
function rewriteJsonlField(content: string, field: string, fromPath: string, toPath: string): { out: string; rewrote: number } {
  const lines = content.split("\n");
  let rewrote = 0;
  const out = lines.map((line) => {
    if (!line.trim()) return line;
    try {
      const obj = JSON.parse(line);
      const val = obj[field];
      if (typeof val === "string") {
        if (val === fromPath) {
          obj[field] = toPath;
          rewrote += 1;
          return JSON.stringify(obj);
        } else if (val.startsWith(fromPath + "/")) {
          obj[field] = toPath + val.slice(fromPath.length);
          rewrote += 1;
          return JSON.stringify(obj);
        }
      }
      return line;
    } catch {
      return line; // preserve malformed
    }
  });
  return { out: out.join("\n"), rewrote };
}

// ---------------------------------------------------------------------------
// Copy with mtime preservation (used when merging into existing dest slug dir)
// ---------------------------------------------------------------------------
function copyFilePreservingTimes(src: string, dst: string): void {
  fs.copyFileSync(src, dst);
  const st = fs.statSync(src);
  fs.utimesSync(dst, st.atime, st.mtime);
}

function copyDirPreservingTimes(src: string, dst: string): void {
  fs.mkdirSync(dst, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dst, entry.name);
    if (entry.isDirectory()) copyDirPreservingTimes(s, d);
    else if (entry.isSymbolicLink()) fs.symlinkSync(fs.readlinkSync(s), d);
    else {
      copyFilePreservingTimes(s, d);
    }
  }
  const st = fs.statSync(src);
  try { fs.utimesSync(dst, st.atime, st.mtime); } catch { /* best-effort */ }
}

function rmDirRecursive(p: string): void {
  if (!fs.existsSync(p)) return;
  fs.rmSync(p, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// Real fs mv — prefer rename (instant, preserves everything), fall back to
// shell `mv` for cross-device (EXDEV). Shell `mv` also preserves metadata
// better than a manual copy+unlink loop.
// ---------------------------------------------------------------------------
function moveDir(from: string, to: string): { method: "rename" | "shell-mv" } {
  try {
    fs.renameSync(from, to);
    return { method: "rename" };
  } catch (err: any) {
    if (err?.code !== "EXDEV") throw err;
  }
  const res = spawnSync("mv", [from, to], { stdio: "inherit" });
  if (res.status !== 0) throw new Error(`mv exited with status ${res.status}`);
  return { method: "shell-mv" };
}

// ---------------------------------------------------------------------------
// Prompt
// ---------------------------------------------------------------------------
async function prompt(question: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(question, (ans) => { rl.close(); resolve(ans); }));
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
  return `${(n / 1024 / 1024).toFixed(1)}MB`;
}

// ---------------------------------------------------------------------------
// Migration engine — operates on a list of (fromPath, toPath) pairs.
// All rewrites derive from this list: each affected slug dir gets renamed/
// merged, each jsonl line gets its cwd rewritten against the matching pair.
// ---------------------------------------------------------------------------
interface MigrationPair {
  from: string;      // original absolute path (e.g. /Users/mark/old/sub)
  to: string;        // new absolute path     (e.g. /Users/mark/new/sub)
  fromSlug: string;
  toSlug: string;
  fromDir: string;   // projectsDir + fromSlug
  toDir: string;     // projectsDir + toSlug
  sessionCount: number;
  sizeBytes: number;
  // When non-null, only migrate these specific session ids (filenames without
  // .jsonl) from this pair's fromDir. null = migrate everything in the dir.
  sessionFilter: Set<string> | null;
}

interface MigrateResult {
  slugsMigrated: number;
  jsonlFilesWritten: number;
  cwdRewrites: number;
  historyRewrites: number;
  runningSessionRewrites: number;
  firstSessionId: string | null;
  sourceSessionsDeleted: number;
}

function migrateSlugs(pairs: MigrationPair[], deleteSource: boolean): { jsonlFilesWritten: number; cwdRewrites: number; firstSessionId: string | null; sourceSessionsDeleted: number } {
  let jsonlFilesWritten = 0;
  let cwdRewrites = 0;
  let firstSessionId: string | null = null;
  let sourceSessionsDeleted = 0;

  for (const pair of pairs) {
    if (!fs.existsSync(pair.fromDir)) continue;
    fs.mkdirSync(pair.toDir, { recursive: true });
    for (const entry of fs.readdirSync(pair.fromDir, { withFileTypes: true })) {
      const src = path.join(pair.fromDir, entry.name);
      const dst = path.join(pair.toDir, entry.name);

      // session-level filter: restrict to .jsonl files (and their sidecar
      // dirs, where the name matches a selected session id).
      if (pair.sessionFilter) {
        if (entry.isDirectory()) {
          if (!pair.sessionFilter.has(entry.name)) continue;
        } else if (entry.isFile()) {
          if (!entry.name.endsWith(".jsonl")) continue;
          const sid = entry.name.replace(/\.jsonl$/, "");
          if (!pair.sessionFilter.has(sid)) continue;
        } else {
          continue;
        }
      }

      if (entry.isDirectory()) {
        copyDirPreservingTimes(src, dst);
        if (deleteSource) { rmDirRecursive(src); }
        continue;
      }
      if (!entry.isFile()) continue;
      if (entry.name.endsWith(".jsonl")) {
        const content = fs.readFileSync(src, "utf8");
        const { out, rewrote } = rewriteJsonlField(content, "cwd", pair.from, pair.to);
        fs.writeFileSync(dst, out);
        const st = fs.statSync(src);
        fs.utimesSync(dst, st.atime, st.mtime);
        cwdRewrites += rewrote;
        jsonlFilesWritten += 1;
        if (!firstSessionId) firstSessionId = extractSessionId(out);
        if (deleteSource) {
          fs.unlinkSync(src);
          sourceSessionsDeleted += 1;
        }
      } else {
        // non-session files (if any) — only copy at dir-level granularity.
        // In session-level mode we never reach here because the filter above
        // skipped any non-matching files already.
        if (!pair.sessionFilter) {
          copyFilePreservingTimes(src, dst);
          if (deleteSource) fs.unlinkSync(src);
        }
      }
    }
    // If we deleted everything and the source slug dir is now empty, clean up.
    if (deleteSource && fs.existsSync(pair.fromDir)) {
      try {
        const remaining = fs.readdirSync(pair.fromDir);
        if (remaining.length === 0) fs.rmdirSync(pair.fromDir);
      } catch { /* best-effort */ }
    }
  }
  return { jsonlFilesWritten, cwdRewrites, firstSessionId, sourceSessionsDeleted };
}

function extractSessionId(jsonlContent: string): string | null {
  for (const line of jsonlContent.split("\n")) {
    if (!line.trim()) continue;
    try {
      const obj = JSON.parse(line);
      if (typeof obj.sessionId === "string") return obj.sessionId;
    } catch { /* skip */ }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Rewrite ~/.claude/history.jsonl (the prompt-history index: up-arrow recall)
// Field: "project" — absolute path. Rewrite any pair match.
// ---------------------------------------------------------------------------
function rewriteHistoryJsonl(historyPath: string, pairs: MigrationPair[]): number {
  if (!fs.existsSync(historyPath)) return 0;
  const content = fs.readFileSync(historyPath, "utf8");
  let total = 0;
  let current = content;
  // Apply each pair in order. Later pairs can act on earlier-rewritten text
  // without issue because the TO paths are (by construction) not prefixes of
  // any FROM path.
  for (const pair of pairs) {
    const { out, rewrote } = rewriteJsonlField(current, "project", pair.from, pair.to);
    current = out;
    total += rewrote;
  }
  if (total > 0) fs.writeFileSync(historyPath, current);
  return total;
}

// ---------------------------------------------------------------------------
// Rewrite ~/.claude/sessions/<pid>.json (per-pid running-session records)
// Field: "cwd" — absolute path. Most of these are stale (pid long gone).
// In session-level mode, only rewrite records whose sessionId is in the
// filter set (otherwise we'd affect unrelated sessions).
// ---------------------------------------------------------------------------
function rewriteRunningSessions(sessionsDir: string, pairs: MigrationPair[], sessionFilter: Set<string> | null): number {
  if (!fs.existsSync(sessionsDir)) return 0;
  let total = 0;
  for (const name of fs.readdirSync(sessionsDir)) {
    if (!name.endsWith(".json")) continue;
    const p = path.join(sessionsDir, name);
    let obj: any;
    try {
      obj = JSON.parse(fs.readFileSync(p, "utf8"));
    } catch {
      continue;
    }
    if (typeof obj.cwd !== "string") continue;
    if (sessionFilter && (typeof obj.sessionId !== "string" || !sessionFilter.has(obj.sessionId))) continue;
    let changed = false;
    for (const pair of pairs) {
      if (obj.cwd === pair.from) { obj.cwd = pair.to; total += 1; changed = true; break; }
      if (obj.cwd.startsWith(pair.from + "/")) { obj.cwd = pair.to + obj.cwd.slice(pair.from.length); total += 1; changed = true; break; }
    }
    if (changed) fs.writeFileSync(p, JSON.stringify(obj));
  }
  return total;
}

// ---------------------------------------------------------------------------
// Build migration pairs from discovered slugs.
// Root pair is always (from, to). Sub-slugs use the ORIGINAL cwd recovered
// from their jsonl — that's the authoritative FROM path (the slug itself is
// lossy, so we can't reconstruct it).
// ---------------------------------------------------------------------------
function buildPairs(from: string, to: string, affected: AffectedSlug[], projectsDir: string): MigrationPair[] {
  const pairs: MigrationPair[] = [];
  const fromSlug = pathToSlug(from);
  const toSlug = pathToSlug(to);

  // Root pair (always present, even if the root slug dir is empty — we still
  // want to rewrite history.jsonl entries pointing at FROM exactly).
  pairs.push({
    from, to, fromSlug, toSlug,
    fromDir: path.join(projectsDir, fromSlug),
    toDir: path.join(projectsDir, toSlug),
    sessionCount: 0, sizeBytes: 0,
    sessionFilter: null,
  });

  for (const a of affected) {
    if (a.slug === fromSlug) {
      // merge counts into root pair
      pairs[0].sessionCount = a.sessionCount;
      pairs[0].sizeBytes = a.sizeBytes;
      continue;
    }
    const orig = a.originalPath;
    if (!orig) continue;              // empty slug dir or no cwd — skip
    if (orig !== from && !orig.startsWith(from + "/")) continue; // sanity
    const subFrom = orig;
    const subTo = to + subFrom.slice(from.length);
    pairs.push({
      from: subFrom, to: subTo,
      fromSlug: a.slug,
      toSlug: pathToSlug(subTo),
      fromDir: a.slugDir,
      toDir: path.join(projectsDir, pathToSlug(subTo)),
      sessionCount: a.sessionCount,
      sizeBytes: a.sizeBytes,
      sessionFilter: null,
    });
  }
  return pairs;
}

// ---------------------------------------------------------------------------
// Session-level pair construction: only the root pair, restricted to a
// specific set of session ids. Sub-dir sessions are deliberately ignored —
// if the user wants sub-dir sessions, they should omit --session/--grep/--pick.
// ---------------------------------------------------------------------------
function buildSessionPair(
  from: string, to: string, projectsDir: string, sessionIds: string[]
): MigrationPair[] {
  const fromSlug = pathToSlug(from);
  const toSlug = pathToSlug(to);
  const fromDir = path.join(projectsDir, fromSlug);
  const toDir = path.join(projectsDir, toSlug);
  let sessionCount = 0;
  let sizeBytes = 0;
  if (fs.existsSync(fromDir)) {
    for (const sid of sessionIds) {
      const p = path.join(fromDir, sid + ".jsonl");
      if (fs.existsSync(p)) {
        sessionCount += 1;
        sizeBytes += fs.statSync(p).size;
      }
    }
  }
  return [{
    from, to, fromSlug, toSlug, fromDir, toDir,
    sessionCount, sizeBytes,
    sessionFilter: new Set(sessionIds),
  }];
}

// ---------------------------------------------------------------------------
// Interactive picker (stdin tty): present numbered list, user types indices
// like "1,3,5-7". Returns selected session ids.
// ---------------------------------------------------------------------------
async function pickSessionsInteractive(sessions: SessionSummary[]): Promise<string[]> {
  if (sessions.length === 0) return [];
  if (!process.stdin.isTTY) {
    throw new Error("--pick requires an interactive terminal (stdin is not a TTY)");
  }
  console.log("");
  console.log(`Found ${sessions.length} session(s) — pick which to migrate:`);
  console.log("");
  sessions.forEach((s, i) => {
    const prompt = s.firstUserPrompt ? s.firstUserPrompt.replace(/\s+/g, " ").slice(0, 120) : "(no user prompt found)";
    console.log(`  [${String(i + 1).padStart(2, " ")}] ${s.sessionId.slice(0, 8)}…  ${formatBytes(s.sizeBytes).padStart(7, " ")}  ${s.mtime.slice(0, 19).replace("T", " ")}`);
    console.log(`       ${prompt}`);
  });
  console.log("");
  const ans = (await prompt("Select (e.g. '1,3,5-7' or 'all' or empty to abort): ")).trim();
  if (!ans) return [];
  if (/^all$/i.test(ans)) return sessions.map(s => s.sessionId);
  const picked: number[] = [];
  for (const tok of ans.split(",").map(x => x.trim()).filter(Boolean)) {
    const m = tok.match(/^(\d+)-(\d+)$/);
    if (m) {
      const a = parseInt(m[1], 10), b = parseInt(m[2], 10);
      for (let i = Math.min(a, b); i <= Math.max(a, b); i++) picked.push(i);
    } else if (/^\d+$/.test(tok)) {
      picked.push(parseInt(tok, 10));
    }
  }
  const out: string[] = [];
  for (const idx of picked) {
    if (idx >= 1 && idx <= sessions.length) out.push(sessions[idx - 1].sessionId);
  }
  return [...new Set(out)];
}

function filterByGrep(sessions: SessionSummary[], pattern: string): SessionSummary[] {
  const re = new RegExp(pattern, "i");
  return sessions.filter(s => s.firstUserPrompt && re.test(s.firstUserPrompt));
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
interface Args {
  from: string;
  to: string | null;       // can be null when --list-sessions
  yes: boolean;
  dryRun: boolean;
  projectsDir: string;
  json: boolean;
  doFsMv: boolean;
  explicitMvFlag: boolean; // true if user passed --mv explicitly
  sessionIds: string[];
  grep: string | null;
  pick: boolean;
  listSessions: boolean;
  deleteSource: boolean;
}

function parseArgs(argv: string[], defaultDoFsMv: boolean): Args | { help: true } | { error: string } {
  const positional: string[] = [];
  let yes = false;
  let dryRun = false;
  let projectsDir = path.join(os.homedir(), ".claude", "projects");
  let json = false;
  let doFsMv = defaultDoFsMv;
  let explicitMvFlag = false;
  const sessionIds: string[] = [];
  let grep: string | null = null;
  let pick = false;
  let listSessions = false;
  let deleteSource = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-h" || a === "--help") return { help: true };
    else if (a === "-y" || a === "--yes") yes = true;
    else if (a === "--dry-run") dryRun = true;
    else if (a === "--json") json = true;
    else if (a === "--no-mv") doFsMv = false;
    else if (a === "--mv") { doFsMv = true; explicitMvFlag = true; }
    else if (a === "--projects-dir") projectsDir = argv[++i];
    else if (a === "--session") { const v = argv[++i]; if (!v) return { error: "--session requires an argument" }; sessionIds.push(v); }
    else if (a === "--grep") { grep = argv[++i]; if (!grep) return { error: "--grep requires a pattern" }; }
    else if (a === "--pick") pick = true;
    else if (a === "--list-sessions") listSessions = true;
    else if (a === "--delete-source") deleteSource = true;
    else if (a.startsWith("-")) return { error: `Unknown flag: ${a}` };
    else positional.push(a);
  }

  if (listSessions) {
    if (positional.length < 1 || positional.length > 2) return { error: "With --list-sessions: expected <FROM> [<TO>]" };
    return {
      from: normalizeInputPath(positional[0]),
      to: positional[1] ? normalizeInputPath(positional[1]) : null,
      yes, dryRun, projectsDir, json, doFsMv, explicitMvFlag,
      sessionIds, grep, pick, listSessions, deleteSource,
    };
  }

  if (positional.length !== 2) return { error: "Expected exactly 2 positional args: <FROM> <TO>" };
  return {
    from: normalizeInputPath(positional[0]),
    to: normalizeInputPath(positional[1]),
    yes, dryRun, projectsDir, json, doFsMv, explicitMvFlag,
    sessionIds, grep, pick, listSessions, deleteSource,
  };
}

function printHelp(binName: string, defaultDoFsMv: boolean): void {
  if (defaultDoFsMv) {
    console.log(`${binName} — move a project folder and migrate all Claude Code state in one shot

Usage:
  ${binName} <FROM> <TO> [options]
  ${binName} <FROM> [<TO>] --list-sessions [--json]

What it does (directory-level, default):
  1. mv FROM → TO                          (fs.renameSync, falls back to shell mv)
  2. Rewrites ~/.claude/projects/<slug>/    session store (including sub-dirs)
  3. Rewrites ~/.claude/history.jsonl       (prompt up-arrow history)
  4. Rewrites ~/.claude/sessions/*.json     (running-session records)

Session-level granularity (opt-in):
  --session <id>         Migrate only this session id (repeatable)
  --grep <pattern>       Migrate sessions whose first user prompt matches
                         the regex (case-insensitive)
  --pick                 Interactively pick sessions from a numbered list
  --list-sessions        Print session summaries for FROM and exit
  In session-level mode, fs mv is disabled; sub-dir sessions are ignored.

Options:
  -y, --yes              Execute without interactive confirmation
  --dry-run              Print the plan, do not write
  --no-mv                Skip the filesystem mv; only migrate CC state
  --delete-source        Delete migrated source sessions after copy+rewrite
                         (default: keep source as a safety net)
  --projects-dir <dir>   CC projects dir (default: ~/.claude/projects)
  --json                 Machine-readable output (for skill integration)
  -h, --help             Show this help

Examples:
  ${binName} /Users/mark/old-project /Users/mark/new-project
  ${binName} ~/old ~/new --yes
  ${binName} /a /b --dry-run
  ${binName} /old /new --session abc-def-... --session 123-... --yes
  ${binName} /old /new --grep 'command vs skill' --yes
  ${binName} /old --list-sessions --json
`);
  } else {
    console.log(`${binName} — migrate Claude Code sessions (CC-state only; does NOT move files on disk)

Usage:
  ${binName} <FROM> <TO> [options]

This is the backwards-compatible entry point. For a full move + migration,
use  cc-mv  instead (same syntax, also moves the folder on disk).

Session-level granularity (opt-in):
  --session <id>         Migrate only this session id (repeatable)
  --grep <pattern>       Migrate sessions whose first user prompt matches
                         the regex (case-insensitive)
  --pick                 Interactively pick sessions from a numbered list
  --list-sessions        Print session summaries for FROM and exit

Options:
  -y, --yes              Execute without interactive confirmation
  --dry-run              Print the plan, do not write
  --mv                   Also move FROM → TO on disk (equivalent to cc-mv)
  --delete-source        Delete migrated source sessions after copy+rewrite
  --projects-dir <dir>   CC projects dir (default: ~/.claude/projects)
  --json                 Machine-readable output
  -h, --help             Show this help
`);
  }
}

async function main(binName: string, defaultDoFsMv: boolean): Promise<void> {
  const parsed = parseArgs(process.argv.slice(2), defaultDoFsMv);
  if ("help" in parsed) { printHelp(binName, defaultDoFsMv); return; }
  if ("error" in parsed) { console.error(`error: ${parsed.error}\n`); printHelp(binName, defaultDoFsMv); process.exit(2); }

  const {
    from, to, yes, dryRun, projectsDir, json, doFsMv, explicitMvFlag,
    sessionIds: cliSessionIds, grep, pick, listSessions: doList, deleteSource,
  } = parsed;
  const fromSlug = pathToSlug(from);
  const historyPath = path.join(path.dirname(projectsDir), "history.jsonl");
  const sessionsDir = path.join(path.dirname(projectsDir), "sessions");
  const fromDir = path.join(projectsDir, fromSlug);

  // ----- --list-sessions: print summaries for FROM and exit -----
  if (doList) {
    const sessions = listSessions(fromDir);
    if (json) {
      console.log(JSON.stringify({ phase: "list", from, fromSlug, fromDir, sessions }, null, 2));
      return;
    }
    console.log(`From : ${from}`);
    console.log(`       slug dir: ${fromDir}`);
    console.log(`       ${sessions.length} session(s)`);
    console.log("");
    sessions.forEach((s, i) => {
      const p = s.firstUserPrompt ? s.firstUserPrompt.replace(/\s+/g, " ").slice(0, 140) : "(no user prompt found)";
      console.log(`  [${String(i + 1).padStart(2, " ")}] ${s.sessionId}`);
      console.log(`       ${formatBytes(s.sizeBytes)}   ${s.mtime.slice(0, 19).replace("T", " ")}   msgs=${s.messageCount}`);
      console.log(`       ${p}`);
    });
    return;
  }

  // TO must be present for everything below
  if (!to) { console.error("error: TO is required (only --list-sessions may omit it)"); process.exit(2); }

  // ----- Session-level mode detection -----
  const sessionLevel = cliSessionIds.length > 0 || grep !== null || pick;

  if (sessionLevel && explicitMvFlag) {
    console.error("error: session-level migration (--session/--grep/--pick) cannot be combined with --mv");
    process.exit(2);
  }

  // Resolve which sessions to migrate (session-level mode)
  let resolvedSessionIds: string[] = [];
  if (sessionLevel) {
    const all = listSessions(fromDir);
    if (cliSessionIds.length > 0) {
      const known = new Set(all.map(s => s.sessionId));
      for (const id of cliSessionIds) {
        if (!known.has(id)) {
          console.error(`error: session id not found in ${fromDir}: ${id}`);
          process.exit(2);
        }
      }
      resolvedSessionIds.push(...cliSessionIds);
    }
    if (grep !== null) {
      let re: RegExp;
      try { re = new RegExp(grep, "i"); } catch (e: any) { console.error(`error: invalid --grep regex: ${e?.message ?? e}`); process.exit(2); }
      const hits = all.filter(s => s.firstUserPrompt && re.test(s.firstUserPrompt));
      resolvedSessionIds.push(...hits.map(s => s.sessionId));
    }
    if (pick) {
      const picked = await pickSessionsInteractive(all);
      resolvedSessionIds.push(...picked);
    }
    resolvedSessionIds = [...new Set(resolvedSessionIds)];
    if (resolvedSessionIds.length === 0) {
      if (json) console.log(JSON.stringify({ phase: "plan", from, to, fromSlug, toSlug: pathToSlug(to), sessionLevel: true, resolvedSessionIds: [], pairs: [], totalSessions: 0, totalSize: 0 }, null, 2));
      else console.log("No sessions matched the filter. Nothing to migrate.");
      return;
    }
  }

  // ----- Build pairs -----
  const pairs: MigrationPair[] = sessionLevel
    ? buildSessionPair(from, to, projectsDir, resolvedSessionIds)
    : buildPairs(from, to, findAffectedSlugs(projectsDir, fromSlug), projectsDir);

  const effectiveDoFsMv = sessionLevel ? false : doFsMv;
  const toSlug = pathToSlug(to);
  const fromDirExistsOnDisk = fs.existsSync(from);
  const toDirExistsOnDisk = fs.existsSync(to);

  const planJson = {
    from, to, fromSlug, toSlug,
    doFsMv: effectiveDoFsMv,
    sessionLevel,
    resolvedSessionIds: sessionLevel ? resolvedSessionIds : null,
    deleteSource,
    fromDirExistsOnDisk,
    toDirExistsOnDisk,
    pairs: pairs.map(p => ({
      from: p.from, to: p.to, fromSlug: p.fromSlug, toSlug: p.toSlug,
      sessionCount: p.sessionCount, sizeBytes: p.sizeBytes,
      toSlugDirExists: fs.existsSync(p.toDir),
      sessionFilter: p.sessionFilter ? [...p.sessionFilter] : null,
    })),
    totalSessions: pairs.reduce((a, p) => a + p.sessionCount, 0),
    totalSize: pairs.reduce((a, p) => a + p.sizeBytes, 0),
  };

  if (json && (dryRun || planJson.totalSessions === 0)) {
    console.log(JSON.stringify({ phase: "plan", ...planJson }, null, 2));
    if (dryRun) return;
  }

  if (!json) {
    console.log(`From : ${from}`);
    console.log(`       slug: ${fromSlug}`);
    console.log(`To   : ${to}`);
    console.log(`       slug: ${toSlug}`);
    console.log("");
    if (sessionLevel) {
      console.log(`Mode : session-level  (${resolvedSessionIds.length} session(s) selected)`);
      console.log(`       fs mv disabled; sub-dir sessions ignored.`);
      console.log(`       source: ${deleteSource ? "will be deleted after migration" : "preserved (safety net)"}`);
    } else if (effectiveDoFsMv) {
      if (!fromDirExistsOnDisk) {
        console.log(`⚠ FROM does not exist on disk: ${from}`);
        console.log(`  (--no-mv is implied — only CC state will be migrated)`);
      }
      if (toDirExistsOnDisk && fromDirExistsOnDisk) {
        console.log(`✗ TO already exists on disk: ${to}`);
        console.log(`  Refusing to overwrite. Move or remove it first.`);
        process.exit(3);
      }
    }
    if (planJson.totalSessions === 0) {
      console.log(`No CC sessions found for this path or any descendant.`);
      console.log(`(slug dir scanned: ${projectsDir})`);
      if (!effectiveDoFsMv || !fromDirExistsOnDisk) return;
      console.log(`Proceeding with fs mv only.`);
    } else {
      console.log(`Affected slug dirs: ${pairs.filter(p => p.sessionCount > 0).length}`);
      for (const p of pairs) {
        if (p.sessionCount === 0) continue;
        const marker = p.from === from ? "·" : "↳";
        console.log(`  ${marker} ${p.from}`);
        console.log(`       → ${p.to}`);
        console.log(`       ${p.sessionCount} session(s), ${formatBytes(p.sizeBytes)}${fs.existsSync(p.toDir) ? "  (dest slug exists — will merge)" : ""}`);
        if (p.sessionFilter) {
          for (const sid of p.sessionFilter) console.log(`         • ${sid}`);
        }
      }
    }
    console.log("");
  }

  if (dryRun) {
    if (!json) console.log("--dry-run: no changes written.");
    return;
  }

  if (!yes) {
    let q = `Proceed? [Y/n] `;
    if (sessionLevel) {
      q = `Migrate ${resolvedSessionIds.length} session(s)${deleteSource ? " (DELETING source after)" : ""}? [Y/n] `;
    } else {
      const hasSubDirs = pairs.filter(p => p.sessionCount > 0 && p.from !== from).length;
      if (hasSubDirs > 0) {
        q = `Found ${hasSubDirs} sub-dir(s) with CC sessions. Migrate everything? [Y/n] `;
      }
    }
    const ans = (await prompt(q)).trim();
    if (ans && !/^y(es)?$/i.test(ans)) { console.log("Aborted."); return; }
  }

  // Phase 1 — fs mv (skipped in session-level mode or when disabled)
  let fsMvMethod: string | null = null;
  if (effectiveDoFsMv && fromDirExistsOnDisk) {
    if (toDirExistsOnDisk) {
      throw new Error(`TO already exists on disk: ${to}`);
    }
    fs.mkdirSync(path.dirname(to), { recursive: true });
    const { method } = moveDir(from, to);
    fsMvMethod = method;
    if (!json) console.log(`✓ mv ${from} → ${to}  (${method})`);
  }

  // Phase 2 — slug store migration (copy-then-rewrite)
  const slugRes = migrateSlugs(pairs, deleteSource);

  // Phase 3 — history.jsonl (only in directory-level mode; session-level
  // migration doesn't move the whole project so history entries pointing at
  // FROM should NOT be rewritten — they still belong at FROM.)
  const historyRewrites = sessionLevel ? 0 : rewriteHistoryJsonl(historyPath, pairs);

  // Phase 4 — running-session records (filter by sessionId in session-level mode)
  const sessionFilter = sessionLevel ? new Set(resolvedSessionIds) : null;
  const runningSessionRewrites = rewriteRunningSessions(sessionsDir, pairs, sessionFilter);

  const result: MigrateResult = {
    slugsMigrated: pairs.filter(p => p.sessionCount > 0).length,
    jsonlFilesWritten: slugRes.jsonlFilesWritten,
    cwdRewrites: slugRes.cwdRewrites,
    historyRewrites,
    runningSessionRewrites,
    firstSessionId: slugRes.firstSessionId,
    sourceSessionsDeleted: slugRes.sourceSessionsDeleted,
  };

  if (json) {
    console.log(JSON.stringify({
      phase: "done",
      ...planJson,
      fsMvMethod,
      result,
      restartHint: {
        cd: to,
        command: result.firstSessionId ? `claude --resume ${result.firstSessionId}` : `claude --resume`,
      },
    }, null, 2));
    return;
  }

  console.log("");
  console.log(`✓ Migrated ${result.slugsMigrated} slug dir(s), ${result.jsonlFilesWritten} jsonl file(s)`);
  console.log(`✓ Rewrote ${result.cwdRewrites} cwd line(s) in sessions`);
  if (historyRewrites > 0) console.log(`✓ Rewrote ${historyRewrites} entry/entries in history.jsonl`);
  if (runningSessionRewrites > 0) console.log(`✓ Rewrote ${runningSessionRewrites} running-session record(s)`);
  if (result.sourceSessionsDeleted > 0) console.log(`✓ Deleted ${result.sourceSessionsDeleted} source session file(s)`);
  console.log("");
  if (!sessionLevel) {
    console.log(`Old slug dirs are still intact at ${projectsDir}/${fromSlug}* — delete them after verifying --resume works.`);
    console.log("");
  }
  console.log("Next step — restart Claude Code in the new location:");
  console.log(`  cd ${to}`);
  console.log(`  claude --resume${result.firstSessionId ? `   # or: claude --resume ${result.firstSessionId}` : ""}`);
}

// ---------------------------------------------------------------------------
// Entry detection — one bundle, two bins. Default behavior depends on which
// symlink / bin name invoked us.
// ---------------------------------------------------------------------------
const invoked = path.basename(process.argv[1] || "cc-mv");
const defaultDoFsMv = !/cc-migrate-session/.test(invoked);
const binName = defaultDoFsMv ? "cc-mv" : "cc-migrate-session";

main(binName, defaultDoFsMv).catch((err) => {
  console.error(err?.message ?? err);
  process.exit(1);
});
