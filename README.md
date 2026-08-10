# @lovstudio/cc-mv

> Move a project folder and migrate all its Claude Code state in one command.

When you `mv /old/project /new/project`, `claude --resume` stops finding your history — CC keys its store by a path-slug, so sessions still sit at `~/.claude/projects/<old-slug>/` while CC looks in `<new-slug>/`.

`cc-mv` does the move **and** migrates the state:

1. `mv FROM TO` on disk (`fs.renameSync` — instant, preserves mtime/perms; falls back to shell `mv` for cross-device)
2. Rewrites `~/.claude/projects/<slug>/*.jsonl` — **including every sub-directory slug**
3. Rewrites `~/.claude/history.jsonl` — the prompt up-arrow recall index
4. Rewrites `~/.claude/sessions/<pid>.json` — running-session records

After it runs, `cd TO && claude --resume` shows the full history.

## Install / Use

Zero install — just run with `npx`:

```bash
npx -y @lovstudio/cc-mv /old/project /new/project
```

It previews the plan and asks for confirmation. Add `--yes` to skip the prompt, or `--dry-run` to see what it would do without writing.

## Options

| Flag | Purpose |
|------|---------|
| `-y`, `--yes` | Skip interactive confirmation |
| `--dry-run` | Print the plan, don't write |
| `--no-mv` | Skip the filesystem mv (only migrate CC state — post-move recovery) |
| `--json` | Machine-readable output (used by the CC skill) |
| `--projects-dir <dir>` | Override `~/.claude/projects` |
| `--session <id>` | **Session-level mode**: migrate only this session id (repeatable) |
| `--grep <pattern>` | **Session-level mode**: migrate sessions whose first user prompt matches the regex (case-insensitive) |
| `--pick` | **Session-level mode**: interactively pick sessions from a numbered list |
| `--list-sessions` | Print session summaries for FROM (id, mtime, size, first user prompt) and exit — use with `--json` for scripting |
| `--delete-source` | Delete migrated source sessions after copy+rewrite (default keeps them as a safety net) |
| `-h`, `--help` | Show help |

## Session-level migration

By default `cc-mv` migrates **everything** under the FROM slug — including all sub-directory sessions. If you only want specific sessions (e.g. you ran many unrelated chats in one dir and only want to move the ones about topic X to a dedicated project), use session-level mode:

```bash
# List sessions + first-prompt summaries (read-only — pick ids from this)
npx -y @lovstudio/cc-mv ~/old --list-sessions

# Migrate specific session ids
npx -y @lovstudio/cc-mv ~/old ~/new --session abc-def-... --session 123-... --yes

# Regex-match on first user prompt
npx -y @lovstudio/cc-mv ~/old ~/new --grep 'command vs skill' --yes

# Interactive picker
npx -y @lovstudio/cc-mv ~/old ~/new --pick
```

In session-level mode:
- `fs mv` is **always disabled** (you're moving a subset of sessions, not the whole project folder). Passing `--mv` is an error.
- Sub-directory slugs are **ignored** (session-level is root-slug-only by design).
- Source sessions are kept by default; pass `--delete-source` to remove them after migration.
- `history.jsonl` is **not** rewritten (your prompt up-arrow history for FROM stays at FROM, since the project wasn't actually moved).

## Examples

```bash
# Move + migrate in one shot
npx -y @lovstudio/cc-mv ~/old-repo ~/new-repo

# Post-move recovery (folder already moved externally — FROM doesn't exist on disk)
npx -y @lovstudio/cc-mv /old /new --no-mv

# Dry-run
npx -y @lovstudio/cc-mv /a /b --dry-run

# Session-level: migrate one specific chat to a new project, delete source
npx -y @lovstudio/cc-mv ~/old ~/new --session <uuid> --delete-source --yes
```

## Sub-directory handling

If you've run CC in sub-directories of the project (`/old/pkg-a`, `/old/pkg-b`, ...), each has its own slug dir. `cc-mv` discovers and migrates them all in one pass.

It works by listing `~/.claude/projects/` and matching any slug where `slug === <fromSlug>` or `slug.startsWith(<fromSlug> + "-")`. That catches FROM and all descendants without traversing your filesystem — fast and exact.

## Backwards-compatible alias

`cc-migrate-session` is also a bin in this package. Same code, but defaults to `--no-mv` (only migrates CC state, doesn't move anything on disk). Use it when the folder has already been moved externally and you just need CC to catch up.

```bash
npx -y @lovstudio/cc-migrate-session /old /new
```

## Safety

- **Copy, don't clobber.** Old slug dirs are never deleted. If anything goes wrong, the old state is still there.
- `cc-mv` refuses if TO already exists on disk — no silent overwrite of the project folder.
- When the destination slug dir already exists, session files are merged (conflicts overwrite); you'll get a warning.
- Malformed jsonl lines are passed through unchanged.

Verify `claude --resume` works at the new location before `rm -rf ~/.claude/projects/<old-slug>*`.

## How it works

CC stores each session at:

```
~/.claude/projects/<slug>/<session-uuid>.jsonl
```

where `<slug>` is the project's absolute path with every non-`[A-Za-z0-9]` character replaced by `-`:

| Path | Slug |
|------|------|
| `/Users/mark/my-project` | `-Users-mark-my-project` |
| `/Users/mark/.claude` | `-Users-mark--claude` (`.` → `-`) |
| `/Users/mark/@手工川` | `-Users-mark-----` (`@` + 3 CJK chars) |

Each jsonl line also embeds `"cwd": "<absolute path>"`. Both the dir name **and** the per-line cwd must be updated — plus the other two indices (`history.jsonl`, `sessions/*.json`) that also carry absolute paths. This tool handles all four places.

## Companion CC skill

The `skill/lov-cc-mv/` dir in this repo is a Claude Code skill. Symlink it:

```bash
ln -s $(pwd)/skill/lov-cc-mv ~/.claude/skills/lov-cc-mv
```

Then when you tell Claude "move this project to /new/path" or "I moved the folder and --resume is gone", CC will auto-invoke this CLI.

## License

MIT
