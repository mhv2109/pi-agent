# Pi Agent Configuration

Global configuration and extension bundle for [Pi Coding Agent](https://pi.dev) (`~/.pi/agent`).

## Documentation

- **Pi Coding Agent**: [pi.dev](https://pi.dev) | [npm](https://www.npmjs.com/package/@earendil-works/pi-coding-agent) | [GitHub](https://github.com/badlogic/pi-mono)
- **Active packages** (see `settings.json` → `packages`):
  - [`@gotgenes/pi-permission-system`](https://github.com/gotgenes/pi-packages/tree/main/packages/pi-permission-system) — Granular tool and shell permission enforcement.
  - [`@gotgenes/pi-subagents`](https://github.com/gotgenes/pi-packages/tree/main/packages/pi-subagents) — Subagent orchestration with permission allowlisting.
  - [`pi-lens`](https://github.com/apmantza/pi-lens) — LSP navigation, diagnostics, and structural code analysis.
  - [`pi-web-access`](https://github.com/nicobailon/pi-web-access) — Web search, URL fetching, GitHub cloning, and media inspection.
  - [`obra/superpowers`](https://github.com/obra/superpowers) — Skill library for structured development workflows (brainstorming, TDD, planning, review).
  - [`ayghri/i-have-adhd`](https://github.com/ayghri/i-have-adhd) — Focus and pacing behavior extension.

## Installation

### Prerequisites

- Node.js (>= 22)
- Pi Coding Agent CLI:

  ```bash
  npm i -g @earendil-works/pi-coding-agent
  ```

### Setup

1. Clone repository to `~/.pi/agent`:

   ```bash
   git clone https://github.com/mhv2109/pi-agent ~/.pi/agent
   ```

2. Install extension dependencies:

   ```bash
   cd ~/.pi/agent/npm && npm install
   ```

3. Configure API keys in `~/.pi/agent/auth.json` (or set them interactively when running `pi`):

   ```json
   {
     "openrouter": {
       "apiKey": "your-api-key"
     }
   }
   ```

## Configuration Files

| Path | Description |
| --- | --- |
| `settings.json` | Global settings (provider, model, thinking level, theme, active packages) |
| `extensions/pi-permission-system/config.json` | Tool and bash command permission rules (deny/ask/allow paths, gated commands) |
| `npm/package.json` | Package dependencies for extensions — should match `settings.json` → `packages` |
| `auth.json` | Provider API keys *(gitignored)* |
| `models-store.json` | Cached model metadata *(gitignored)* |
| `docker/settings.json` | Generated settings overlay for container sessions *(gitignored, rewritten on each `/docker` launch)* |

## Local Extensions

| Path | Description |
| --- | --- |
| `extensions/docker-session.ts` | `/docker` command: runs pi sessions inside a Docker/Podman container (`pi-sandbox` image) with full parity to the host — same settings, auth, packages, and skills. Permission-free inside the container via a filtered settings overlay (drops `pi-permission-system` by default, configurable with `PI_DOCKER_DROP_PACKAGES`). Tool installs persist in a per-project named volume; `/docker rebuild` resets it. |

## Directory Layout

| Path | Purpose | Tracked |
| --- | --- | --- |
| `extensions/` | Local TypeScript extensions and permission config | Partially (only `docker-session.ts` and `pi-permission-system/config.json`) |
| `npm/` | Node dependencies for packaged extensions (managed locally, not committed) | No |
| `docker/` | Sandbox Dockerfile + generated container settings overlay | `Dockerfile` only |
| `bin/` | Local binaries (e.g. `fd`) | No |
| `git/` | Packages cloned from git (superpowers, i-have-adhd) | No |
| `sessions/` | Session state | No |
