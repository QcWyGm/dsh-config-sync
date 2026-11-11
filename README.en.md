# dsh-config-sync

[中文](README.md) | English

A DSH plugin: it adds a **"Config Sync"** row to the sidebar (opening a full-page health-check panel), plus a summary row under **Settings → General**. It only **inspects and prepares commands** — the sync actions themselves never run inside the app.

![panel](docs/panel.png)

The UI is bilingual: it follows the client language (`zh-*` → Chinese, anything else → English), with no settings toggle. Only the generated `.cmd` scripts keep Chinese text, because they are local shell helpers.

## Install

The plugin is a standard DSH bundle; install it into the current profile:

```sh
# Install from this repo's release package (no build needed: host, client and runtime scripts are already inside)
dsh plugin add https://raw.githubusercontent.com/QcWyGm/dsh-config-sync/main/releases/dsh-config-sync-0.3.0.tgz
```

Or search `dsh-config-sync` in the DSH panel under **Plugins → Plugin market** (this repo lists `dsh-plugin` and `deepseek-harness` as package keywords and declares `dsh.bundle.patch`).

After installing, point it at your own config repo (common paths are auto-detected by default). The **Plugin update** card asks for a manifest URL and token only when needed — **this repo is public, so updates work without a token**.

## Contents

| Path | Purpose |
|---|---|
| `index.js` | Host half: `/config-sync/status`, `/prepare`, `/settings`, `/auto`, `/update` routes |
| `client.js` | Browser half: sidebar row, panel, settings summary row |
| `cordis.patch.yml` | Bundle patch layer (`id: config-sync`) |
| `runtime/` | The six post-exit PowerShell scripts plus `fix-session-cwd.mjs`, shipped with the package so scripts can be generated right after install without cloning the config repo first |
| `tools/` | Self-test `selftest.mjs`, client structure check `clientcheck.mjs` |
| `version.json` / `releases/` | Self-update manifest and package |

## Self-update

The **Plugin update** card reads `version.json` (default `https://raw.githubusercontent.com/QcWyGm/dsh-config-sync/main/version.json`, cached for 30 minutes). When a higher version appears: exit DSH → download the tgz → verify sha256 → back up the old directory to `~\.dsh\backups\plugin-<old version>-<time>` → install over it → relaunch.

## Using this repo as a market index source

The root `market-index.json` is a ready-to-use DSH market index (`format: 1`, `source.type: git` with a 40-character commit; installing fetches the package from this repo, no build). Index URL:

```
https://raw.githubusercontent.com/QcWyGm/dsh-config-sync/main/market-index.json
```

In DSH go to **Plugins → Plugin market / Discover → Manage index sources → Add index source**, paste the URL above, and "Config Sync" shows up in the list; installing pulls this repo at that commit.

Release flow: change code → pack `releases/dsh-config-sync-<version>.tgz` → update `version`/`sha256` in `version.json` → replace `version` and `commit` of the entry in `market-index.json` → push. The index only references a commit, so older versions stay installable.

`capture` has to read `cordis.patch.yml` while DSH holds that file, so it would capture a half-written state; and after `apply` writes, DSH writes over it again on exit. Hence the fixed boundary: decide what to run and write the command now, double-click after DSH exits.

The full explanation of the sync mechanism, directory layout, moving to another machine and troubleshooting lives in the config repo's root `README.md`; this document covers the plugin itself.

## Where the entries hang

| Entry | slot | Notes |
|---|---|---|
| Sidebar row | `sidebar.panellist` (`id: config-sync`) | Same column as "Plugins / Automation / Skills / Memory", double-arrow icon |
| Opened panel | `main` (`key: config-sync`) | The host binds both by id/key, so the two registers must be done in one **nested inject** (injecting only `main` makes the `sidebar.panellist` register a no-op) |
| Settings summary row | `settings.general.item` | One four-state chip row plus an expandable body (repo, remote, key) |

Click-to-switch on the sidebar row is handled by the host; the contract is copied from `dshmarket` / `dsh-mnemon`.

## The three scripts generated in one click

"Generate push / pull / restore" can write all three at once, or one of them. File names, buttons and the script text are Chinese by design.

| Script | What it does | Safety valve |
|---|---|---|
| `同步-推送.cmd` | capture this machine's config after exit and push it | first checks whether `DeepSeek Harness.exe` is still running |
| `同步-拉取.cmd` | pull from the remote after exit and apply locally | same; **states how many commits ahead / uncommitted items first, and requires `y`** — it overwrites local config with the repo version |
| `同步-还原.cmd` | roll the profile back to the snapshot taken before a given apply | same; **runs `-DryRun` to print the plan first, writes only after `y`** |

All three bake in this machine's parameters (repo, AppRoot, `.dsh` location) and can be double-clicked. Pull and restore accept `--yes` to skip confirmation (for automation/remote control); with no confirmation they say plainly "no confirmation (y) received, exited: nothing changed on this machine" instead of exiting silently.

- **Commit note**: optional when generating the push script; passed as `-Message "..."` to `sync.ps1`, and **the timestamp is appended at run time**. Empty means the default `sync: capture <time> @ <machine>`.
- **Which restore snapshot**: if a snapshot exists at generation time it is written into `-BackupDir` explicitly (with time, total count and file count); if not (fresh machine, plugin just installed) it is **left out** and `restore.ps1` picks the newest at run time — otherwise the script would stick to "there was no snapshot when it was generated". If the newest one turns out to be an empty snapshot, it walks back to the first one containing `package.json` and says so.

## Local repo / cloud repo (both configurable, read-only by default, forced when unset)

- Repo test: the directory has both `apply.ps1` and `profile\package.json` (plus `sync.ps1` to actually push/pull).
- Priority: local settings file → plugin config `repoPath` → `DSH_CONFIG_REPO` → auto-detected common locations.
- Cloud: the remote URL comes from `git remote get-url origin` first, falling back to the settings file; the SSH key stores only a **path** and may be empty to let `.ssh\config` decide.
- **Never configured = forced setup**: the card stays in edit mode with no "Cancel", a red line at the top, all three generate buttons disabled, and the host's `prepare` returns 400 (restore is unaffected when only the remote is missing).
- Save order: validate (URLs accept only `git@host:path` / `ssh://` / `https://`; a key that is filled in must exist) → write settings → `set-url` if `origin` exists, `remote add` if not → on git failure roll the settings file back, so the panel never shows A while git uses B.
- A configured path that later goes away: `status` returns `repo.exists=false` with the source still `settings`, and the panel returns to "must be set again" — it will **not** silently switch to another detected repo.
- Stored in `~\.dsh\dsh-config-sync.json`: per machine, never in the repo.

## What the panel shows

**Title row (everything at a glance)**: `Config Sync　[In sync / To push / Problem]　one-line conclusion　　[In sync / Out of sync]　cloud status`. Both badges share one palette — green = in sync, orange = to push, red = problem; the left one only talks about this machine (config completeness, missing dependencies, uncommitted/unpushed state), while the cloud one is **fully automatic**: checked when the panel opens and re-checked every 2 minutes, **no button**.

**"To push" is not just git**: even with a clean `git status`, new sessions/materials may still sit in `~\.dsh` uncaptured. So `sync.ps1` writes `~\.dsh\config-sync-state.json` (`lastSyncAt`/`mode`/`head`) after a successful push/pull, and `status` returns an extra `local` block: it stats `sessions`, `skills`, `.agent-presets`, `mnemon`, the five profile files and registered workspace directories, counting anything whose **mtime is later than `lastSyncAt`** into `local.pending`, which turns the badge orange "To push" with "N files changed since the last sync". mtime only — no content reads, no capture; capped at 20,000 files / 1.5 s; copies and "save as" count too, and a false positive only costs one extra hint.

Body: repo path and source, branch and HEAD, behind/ahead/uncommitted, **local data (last sync time + how many files changed since)**; version contract (local app version ↔ repo `host-contract.json`); Electron version (`<AppRoot>\version`, which is not the app version); bundle total and unresolvable items; dependencies expected/missing; newest snapshot count and file count; remote URL and key source; finally condensed into a few to-do suggestions.

**Last auto-sync result**: if `~\.dsh\auto-sync-result.json` is within 15 minutes, a 5-second toast pops **as soon as the client starts** (`apply()` checks `status` 1.5 s after mount, appends its own overlay to the body, so it shows without opening the panel; success/failure + reason + log path on failure). The line inside the panel shares the same predicate and the same localStorage key, so one result pops only once.

## Auto sync / auto push (two switches, both off by default)

| Switch | Behaviour |
|---|---|
| Pull on startup | 8 s after start, a read-only `git fetch` comparison; behind > 0 → system confirmation dialog (Yes/No) → "Yes" **exits the whole client family right away** (measured: processes gone within 5 s) → a visible window runs the pull → relaunches automatically |
| Push on exit | **queued when any of three sources hit**: local commits ahead, uncommitted changes, local data newer than the last sync (new sessions etc). Re-checked every 2 minutes after start, no duplicate watcher while queued; pushes only after DSH fully exits, then relaunches |

- The work is done by `runtime\post-exit.ps1 -Phase wait`, which the plugin launches as a **hidden** process to watch for the client exiting; only after it really exits does it start a **visible** `-Phase run` window titled "DSH 配置同步 · 拉取/推送". **No window while queued** — otherwise an empty window would sit in the way from boot to shutdown.
- **Launch pitfalls hit here**: `detached: true` PowerShell exits immediately on Windows (not one log line), so a short-lived PowerShell starts a separate process with `Start-Process -PassThru`; `spawn()` failures are asynchronous (only an `error` event), so the launcher's exit code is awaited and a missing pid fails honestly, logged to `~\.dsh\logs\auto-sync-launch.log`.
- **Waiting for exit cannot rely on pid**: the plugin runs in a child process, so `process.pid` is not the client's main process — pid checks produce "client still running, waiter thinks it exited" and pull mid-run. It matches by process name instead; "closed but processes linger" (measured: 7 processes with `hwnd=0` alive for over a minute) also counts: alive past 60 s with no visible window for 16 s → kill the leftovers, then sync (`auto-sync-wait.log` records it).
- **One sync at a time**: `~\.dsh\auto-sync.lock` records the pid. A startup push and a user-confirmed pull once ran together and rewrote config in parallel; now the later one reads the lock — same kind is reused, a different kind (manual wins) first ends the waiting process that has not started yet, then re-queues.
- **Exit uses the whole process family**: `taskkill /PID <main>` (without `/F`) does nothing for the Electron main process (`This process can only be terminated forcefully`), so it uses `/IM "DeepSeek Harness.exe"` and adds `/F` 3.5 s later.
- **Clear environment variables before relaunching**: clients started through the plugin chain "quit right after start" three times in a row while the same script in a clean shell succeeded — the difference was the inherited `ELECTRON_RUN_AS_NODE` (plus `ELECTRON_NO_ATTACH_CONSOLE`/`NODE_OPTIONS`/`NODE_PATH`); clearing them worked first try. After start it also counts processes and retries up to 3 times, 8 s each.
- **Pull failure rolls back**: `git reset --hard` to the original commit → run `restore.ps1` with the `backups\config-<timestamp>` created just before this apply wrote to disk → the rollback result is logged either way, and an incomplete rollback says "open the log and check".
- **Both pull and push relaunch**: success uses the new config, failure the rolled-back one. A successful relaunch refreshes `lastSyncAt` in `config-sync-state.json`, so files just written by apply are not misread as "to push" by the next startup check.
- Exit codes: `0` done, `2` wait timeout, `3` sync.ps1 missing, `4` relaunch failed, `5` sync failed (pull already tried to roll back).
- "Cancel queue" only drops the plugin's queue record; an already launched external waiter still waits for your exit — end it manually to stop it (the pid is in `auto-sync-wait.log` / the launch log).

## Plugin update (since 0.2.0)

The **Plugin update** card sits after the version contract card and shows the local version, the cloud version and one status line:

| Status | Meaning |
|---|---|
| Green "Up to date" | local version ≥ manifest version |
| Orange "New version x.y.z" | the manifest is higher, with a one-line note and an "Update to x.y.z" button |
| Red "Check failed" | manifest unreadable (network / repo missing / 404), with "Check for updates" to force a re-check |

- The manifest and package are published in this repo: `version.json` and `releases/dsh-config-sync-<version>.tgz`. Only a few hundred bytes are read, the package is not; cached 30 minutes, checked on mount and every 30 minutes after.
- **Token**: this repo is public, so no token is needed. If `updateManifestUrl` points at a private Gitee mirror instead, fill in a Gitee personal token and both the manifest and the package switch to the API raw endpoint (`/api/v5/repos/<owner>/<repo>/raw/<path>?ref=main&access_token=…`), passing the branch as `ref` rather than in the path. The **Cloud repo** card keeps only the repo URL and SSH key. The token lives only in the local settings file, never in the repo; saving empty means "keep the stored token", and there is a separate "Clear stored token" button.
- Clicking "Update to x.y.z" shows a system confirmation dialog first (Yes to continue), then **exits DSH** → a background script downloads the tgz, compares sha256, backs up the old directory to `~\.dsh\backups\plugin-<old version>-<time>`, installs over it and relaunches. Any failure exits with code 7 and the version stays put.
- The `updateManifestUrl` setting can point at your own manifest (empty means the built-in URL); a relative `tgz` resolves against **the manifest actually read**, so switching addresses cannot build the wrong domain.

## Interfaces and paths

| Interface | Notes |
|---|---|
| `GET /config-sync/status` | health-check JSON (including `repo.source` / `repo.configured` / `remote.configured`, `local.{lastSyncAt,pending,sample}`, `auto.lastResult`) |
| `POST /config-sync/prepare` | `{action:'push'\|'pull'\|'restore'\|'all', message?}`, generates the matching `.cmd`; `all` returns `built: [...]` |
| `POST /config-sync/settings` | `{repoPath?, remoteUrl?, sshKey?, autoPull?, autoPush?, autoRestart?}`: validate → write settings → (touch git only when the URL changed); failure rolls back and returns 400 |
| `POST /config-sync/auto` | `{action:'check'\|'pull-now'\|'push-now'\|'cancel', closeNow?, restart?}`; `check` is a read-only fetch comparison, `pull-now`/`push-now` close the client without `/F` (a normal exit, so config is saved); `auto.pending` in `status` carries `reason` (why it queued) |

Cross-origin requests get 403. The client only `fetch`es these four routes, imports no `@deepseek-ai/dsh-client-*`, and styles with `--dsw-alias-*` tokens only. Every request carries `accept-language`, which the host turns into Chinese or English text (`node:async_hooks` `AsyncLocalStorage`, one language per request).

Paths: the repo follows the priority above; the client root prefers `config.appRoot` and otherwise derives from the plugin's own location (`<AppRoot>\dsh-config-sync-0.1.0`), so moving machines needs no edit; `.dsh` is `config.dshHome` → `%DSH_HOME%` → `~\.dsh`. The sync state file `~\.dsh\config-sync-state.json` is written by `sync.ps1`; the plugin only reads it.

## Pitfalls already closed in the generator

All of them surfaced only by **actually running on a new machine**:

| Pitfall | Handling |
|---|---|
| cmd's `echo` swallows `< > \| & ^ %`, so `echo ... config-<timestamp>` became a redirect and printed nothing | every dynamic line goes through `echoSafe()`: `%`→`%%`, special characters prefixed with `^` |
| after `chcp 65001`, `set /p` cannot read redirected input: automation feeding `y` left `GO` empty, "finished" printed while nothing happened, exit code still 0 | `--yes` skips confirmation + an explicit receipt when there is none |
| a fresh machine has no upstream, `pull --ff-only` says *There is no tracking information…*, PowerShell 5.1 wraps it as NativeCommandError and the script carried on | `sync.ps1` probes upstream first, falls back to `pull --ff-only origin <branch>` then `set-upstream-to`; push uses `-u` |
| `GIT_SSH_COMMAND` without the ssh.exe program → `/usr/bin/sh: - : invalid option` | four branches: use `core.sshCommand` if set; write a full command when `ssh.exe` is found; **unset the variable** when only a key exists; hand it to `.ssh\config` when there is no key |
| with an asar build, AppRoot lookups by path all miss and every bundle is reported missing | `isAppRoot` accepts `app\package.json` **or** `app.asar`; version and bundle existence are read straight out of the asar (PowerShell 5.1 `ConvertFrom-Json` caps at 2 MB, a 5.7 MB header has to be read by entry offset), and anything undecidable is reported as "unknown" |
| plugin directory already present skips deployment, so a newer tgz leaves old code running | `apply.ps1` compares the tgz with the newest deployed file and, when newer, renames to `.bak-<timestamp>` and redeploys |
| "push on exit" was enabled yet nothing happened (no log, no result file) | two causes stacked: ① the queue predicate only looked at `ahead > 0`, which stays 0 until new sessions are captured → count all three sources + re-check every 2 minutes; ② `spawn` faked success (`detached` PowerShell exiting immediately / failures only on the `error` event) → start a separate process with `Start-Process`, await the launcher's exit code, and write `auto-sync-launch.log` |

Session header `cwd`, empty-snapshot fallback and missing `Get-FileHash` are handled by `apply.ps1` / `restore.ps1` / `dsh-sync-common.ps1` in the config repo; see sections 5 and 10 of its root `README.md`.

## Install and self-check

`apply.ps1` unpacks `local-plugins\dsh-config-sync-0.1.0.tgz` into `<AppRoot>\dsh-config-sync-0.1.0`, adds a `link:` dependency and a `dsh.profile.bundles` entry to `package.json`, and a `config-sync` line to `cordis.patch.yml`.

- `node tools\selftest.mjs <repo path>`: starts the host half with a fake ctx, hits status, generates scripts and asserts the JSON and the files on disk; it backs up any existing `同步-*.cmd` in the repo root and restores them afterwards. **The repo path must be passed explicitly.**
- `node tools\clientcheck.mjs`: runs the client half with a fake `__ModuleLoader__` and a react stand-in, asserting the module loads, all three `apply()` registrations succeed (sidebar row and main with matching id/key), `inject` returns a disposer, and the component renders without throwing when data is empty. It validates the contract and structure; the UI still needs a restart and a look.

## Test log (2026-11-11, isolated environment)

A fake cloud bare repo + fake client root + a standalone `.dsh` holding only `profiles\desktop`; the plugin was installed from tgz and the main machine's directories were never touched.

| Step | Result |
|---|---|
| Install the plugin, open the panel | all three routes registered; with nothing configured `repo.path` is empty rather than silently falling back, and push is blocked with 400 |
| Configure repo / cloud | 200, the path lands in the local `.dsh\dsh-config-sync.json`; no origin → `git remote add` |
| Generate all three scripts | written into the new machine's repo root, `-AppRoot` pointing at that machine's client root, with `--yes` and `y/N` guards |
| First pull | upstream added first → `Already up to date` → backed up 11 files, laid down 436 → `pnpm install` 21 plugins → all 25 bundles resolvable |
| Workspace / sessions | materials land in the fake client root; registry paths expand to machine paths; an empty workspace is created as an empty directory; session directory names match the machine recomputation character for character, and header `cwd` is rewritten by `fix-session-cwd.mjs` |
| Push / restore | pushed to the fake cloud; restore prints a `-DryRun` plan, `--yes` takes a `manual-<timestamp>` safety copy then writes back, and the test marker really disappears |
| Post-exit sync | all five `post-exit.ps1` exit codes (0/2/3/4/5) reproduced |
| Local to-push | real machine: `git status` clean, two sessions in `~\.dsh\sessions` newer than the last sync, badge turns orange "To push", `local.pending = 15` (including the five profile files apply had just rewritten) |
| Confirm → exit + visible window + relaunch | real machine `{"action":"pull-now"}`: `DSH 7→0` in 5 s; +10 s a PowerShell window titled "拉取" appears (no window while queued); after the pull it relaunches `0→4→7` |
| Close → push + visible window + relaunch | real machine with `autoPush` on: queued as a hidden process → after closing, 7 processes with `hwnd=0` would not exit → forced cleanup after 16 s → window "推送" → push succeeds → automatic relaunch |
| Mutual exclusion | the startup push and a manual pull hit together: the latter ended the former's not-yet-started waiting process and re-queued; no parallel run |

**Sync boundary**: workspace materials and sessions travel along, but the **default workspace (`default-workspace`) is not synced** (its directory name is encoded from each machine's `WorkspaceHome`, so the target cannot recognise it and just leaves an empty workspace with "empty history"); `models/`, `*.whl`, `*.safetensors` and any file over 100 MB stay out of the repo either. See sections 4 and 5 of the config repo's root `README.md`.

The six issues found in the previous review round (git identity, cross-machine session directories overwriting each other, hard-coded `origin/main`, the finishing message, duplicated logic, dead code) are **all fixed and verified**; the mapping table is in section 12 of the config repo's root `README.md`.
