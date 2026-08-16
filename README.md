# Pi Agent Configuration

Global configuration and extension bundle for [Pi Coding Agent](https://pi.dev) (`~/.pi/agent`).

## Documentation

- **Pi Coding Agent**: [pi.dev](https://pi.dev) | [npm](https://www.npmjs.com/package/@earendil-works/pi-coding-agent) | [GitHub](https://github.com/badlogic/pi-mono)
- **Plugins & Extensions**:
  - [`@gotgenes/pi-permission-system`](https://github.com/gotgenes/pi-packages/tree/main/packages/pi-permission-system) — Granular tool and shell permission enforcement.
  - [`pi-lens`](https://github.com/apmantza/pi-lens) — LSP navigation, diagnostics, and structural code analysis.
  - [`pi-web-access`](https://github.com/nicobailon/pi-web-access) — Web search, URL fetching, GitHub cloning, and media inspection.
  - [`@narumitw/pi-plan-mode`](https://github.com/narumiruna/pi-extensions) — Read-only `/plan` collaboration mode.
  - [`pi-behavior-control`](https://github.com/wbelk/pi-behavior-control) — Behavioral verification and read-before-edit enforcement.

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
   git clone <repo-url> ~/.pi/agent
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
| `extensions/pi-permission-system/config.json` | Tool and bash command permission rules |
| `npm/package.json` | Package dependencies for extensions |
| `auth.json` | Provider API keys *(gitignored)* |
| `models-store.json` | Cached model metadata *(gitignored)* |
