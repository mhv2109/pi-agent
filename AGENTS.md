# AGENTS.md

Instructions for Pi sessions working in this repository (`~/.pi/agent`). This is a living config repo — you are likely editing the very environment you are running in. Read this before making changes.

## What this repo is

Global Pi configuration: `settings.json`, packaged extensions (`npm/`), local extensions (`extensions/`), permission rules, and the `/docker` sandbox. `README.md` is the human-facing overview; this file tells you how to keep it accurate.

## Doc-sync rule (important)

**Any change that alters something the README documents must update the README (and, if it changes conventions here, this file) in the same commit.**

The README documents: active packages, npm dependencies, local extensions, config files, and directory layout. These drift silently because most changes touch only one of `settings.json`, `npm/package.json`, or `extensions/`.

## When to update the README

| You changed… | Update… |
| --- | --- |
| `settings.json` → `packages` (added/removed a package) | "Active packages" list — add a one-line description with a link, or remove the entry |
| `npm/package.json` (added/removed a dependency) | Confirm it matches `settings.json` → `packages`; npm deps and active packages should stay in sync |
| `extensions/` (added/removed/renamed a local extension) | "Local Extensions" table |
| `docker/` (Dockerfile, overlay behavior, env vars like `PI_DOCKER_DROP_PACKAGES`, `PI_DOCKER_TOOLS_VOLUME`) | "Local Extensions" row for `docker-session.ts` — its docstring is the source of truth |
| `extensions/pi-permission-system/config.json` (new deny/ask rules, gated commands) | Nothing — unless a rule changes a documented behavior (e.g. a new gated command users should know about) |
| New top-level directory or file category | "Configuration Files" and/or "Directory Layout" tables |
| Install steps or prerequisites | "Installation" section |

## When to update AGENTS.md

Add a row here when you introduce a new convention or a new sync rule (e.g. a new table that must be maintained, a new gitignored path, a new env var with repo-wide impact).

## Hygiene rules

- **No stale deps.** After removing a package from `settings.json`, also remove it from `npm/package.json` and run `npm install` in `npm/` to refresh the lockfile (and vice versa). Note: `npm/` is fully gitignored, so this sync happens locally only — it still matters, because pi loads packages from `settings.json` but the deps must be installed for them to work.
- **Secrets stay out.** `auth.json`, `models-store.json`, and anything under `sessions/` are gitignored — never commit or print their contents. The permission config denies reads to credential stores; don't weaken those rules to "fix" a task.
- **Generated files are not edited by hand.** `docker/settings.json` is rewritten on every `/docker` launch; `docker/Dockerfile` is generated from `docker-session.ts`. Edit the extension, not the artifacts.
- **Don't touch `git/` or `node_modules/`.** They are clones/installs managed by pi and npm.
- **Verify before claiming done.** After dep changes: `npm ls --depth=0`. After doc changes: re-read the section you changed against the actual files it describes.
