/**
 * Docker Session Extension
 *
 * Registers a `/docker` command that starts a new interactive pi session
 * inside a container with full parity to the host:
 *   - same settings, auth, npm packages, local extensions, skills
 *   - same `~/.pi` absolute path (mounted read-write)
 *   - current project mounted at its same absolute path
 *   - host TUI suspends while the container runs, restored on exit
 *
 * Permission-free container sessions: a filtered copy of the host
 * settings.json (dropping packages matched by PI_DOCKER_DROP_PACKAGES,
 * default `@gotgenes/pi-permission-system`) is written to
 * ~/.pi/agent/docker/settings.json and bind-mounted over the shared
 * settings.json inside the container only — tools run there with no
 * approval prompts. The host permission system is untouched.
 *
 * Works with both Docker and Podman (via its `docker` CLI compatibility
 * layer). Engine is probed at launch for accurate error messages only;
 * the command subset used is identical under both engines.
 *
 * Usage:
 *   /docker            # new interactive container session
 *   /docker <args>     # extra args for the container's pi (e.g. -p "prompt")
 *   /docker rebuild    # reset tool state: remove the tools volume and
 *                      # rebuild the sandbox image (--no-cache supported)
 *
 * Image `pi-sandbox:<host-pi-version>` is built on first use from a
 * generated Dockerfile cached at ~/.pi/agent/docker/Dockerfile, and
 * rebuilt automatically whenever the host pi version changes.
 *
 * Tool persistence: a named engine volume `pi-docker-tools-<cwd-hash>`
 * (hash = first 10 hex chars of sha256 of the project cwd) is mounted at
 * /usr, so packages installed inside container sessions (apt-get, npm i -g,
 * tarball installs, manual builds) survive across sessions. Docker/Podman
 * auto-creates the volume on first use by copying the image's /usr into it
 * (copy-up — the first launch after a reset is slower, one-time). The
 * volume therefore pins /usr content: after upgrading pi or node, the
 * container keeps the volume's old /usr (including the old node) until you
 * run `/docker rebuild`, which removes the tools volume and rebuilds the
 * sandbox image; the next launch re-copies /usr from the fresh image.
 * Set PI_DOCKER_TOOLS_VOLUME=<name> to share one volume across projects
 * deliberately, or PI_DOCKER_TOOLS_VOLUME=off to disable the mount
 * (fully ephemeral sessions, as before). The writable container layer is
 * still discarded by --rm; only /usr persists.
 */

import { spawnSync, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const IMAGE_PREFIX = "pi-sandbox";
const DOCKER_DIR = join(process.env.HOME ?? "/root", ".pi", "agent", "docker");
const DOCKERFILE = join(DOCKER_DIR, "Dockerfile");

const BASE_IMAGE = "node:24-bookworm-slim";
const CONTAINER_USER = "node"; // standard non-root user in official node images

/** Provider credential / config env vars to forward when present on the host. */
const PROVIDER_ENV_VARS = [
	"ANTHROPIC_API_KEY",
	"ANTHROPIC_BASE_URL",
	"ANTHROPIC_AUTH_TOKEN",
	"OPENAI_API_KEY",
	"OPENAI_BASE_URL",
	"OPENROUTER_API_KEY",
	"GOOGLE_API_KEY",
	"GEMINI_API_KEY",
	"GOOGLE_GENERATIVE_AI_API_KEY",
	"XAI_API_KEY",
	"GROQ_API_KEY",
	"MISTRAL_API_KEY",
	"DEEPSEEK_API_KEY",
	"TOGETHER_API_KEY",
	"FIREWORKS_API_KEY",
	"AZURE_OPENAI_API_KEY",
	"AZURE_API_KEY",
	"AZURE_OPENAI_ENDPOINT",
	"KIMI_API_KEY",
	"MOONSHOT_API_KEY",
	"ZAI_API_KEY",
	"MINIMAX_API_KEY",
	"COHERE_API_KEY",
	"PERPLEXITY_API_KEY",
	"OPENAI_SEARCH_API_KEY",
	"BRAVE_API_KEY",
	"TAVILY_API_KEY",
	"EXA_API_KEY",
	"KAGI_API_KEY",
	"FIRECRAWL_API_KEY",
	"SearXNG_URL",
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface EngineInfo {
	ok: boolean;
	podman: boolean;
	rootless: boolean;
	name: string; // "Docker" | "Podman" | "docker"
	error?: string;
}

/** Probe the container engine: reachable + which backend is behind `docker`. */
function detectEngine(): EngineInfo {
	const result = spawnSync("docker", ["info", "--format", "{{json .}}"], {
		encoding: "utf8",
		timeout: 15_000,
	});
	if (result.error || result.status !== 0) {
		const stderr = (result.stderr ?? result.error?.message ?? "")
			.toString()
			.trim();
		return {
			ok: false,
			podman: false,
			rootless: false,
			name: "docker",
			error: stderr,
		};
	}
	try {
		const info = JSON.parse(result.stdout);
		// Podman's info payload includes buildahVersion and host.security.rootless;
		// Docker's does not.
		const podman =
			typeof info?.host?.buildahVersion === "string" ||
			typeof info?.buildahVersion === "string";
		const rootless = info?.host?.security?.rootless === true;
		return { ok: true, podman, rootless, name: podman ? "Podman" : "Docker" };
	} catch {
		return { ok: true, podman: false, rootless: false, name: "docker" };
	}
}

/** Host pi version, from the running install's package.json (fallback: `pi --version`). */
function hostPiVersion(): string {
	try {
		// process.argv[1] is pi's CLI entry, so resolution is anchored to the
		// installed package regardless of where the extension lives.
		const anchor = process.argv[1] ?? process.execPath;
		const req = createRequire(anchor);
		const pkg = req("@earendil-works/pi-coding-agent/package.json") as {
			version?: string;
		};
		if (pkg?.version) return pkg.version;
	} catch {
		// fall through
	}
	try {
		return execFileSync("pi", ["--version"], { encoding: "utf8" }).trim();
	} catch {
		return "latest";
	}
}

/** Generate (if needed) the Dockerfile used to build the sandbox image. */
function ensureDockerfile(version: string): string {
	const versionLine = `RUN npm install -g --ignore-scripts @earendil-works/pi-coding-agent@${version}`;
	let existing = "";
	if (existsSync(DOCKERFILE)) {
		try {
			existing = readFileSync(DOCKERFILE, "utf8");
		} catch {
			existing = "";
		}
	}
	if (existing.includes(versionLine)) return DOCKERFILE;

	const dockerfile = [
		`FROM ${BASE_IMAGE}`,
		"RUN apt-get update \\",
		"  && apt-get install -y --no-install-recommends bash ca-certificates git ripgrep \\",
		"  && rm -rf /var/lib/apt/lists/*",
		versionLine,
		"",
	].join("\n");
	mkdirSync(DOCKER_DIR, { recursive: true });
	writeFileSync(DOCKERFILE, dockerfile);
	return DOCKERFILE;
}

function imageTag(version: string): string {
	return `${IMAGE_PREFIX}:${version}`;
}

/**
 * Name of the engine volume mounted at /usr for tools persistence, derived
 * per project cwd. Env overrides:
 *   - PI_DOCKER_TOOLS_VOLUME=<name>  use this exact volume name (e.g. to
 *     share one volume across projects deliberately)
 *   - PI_DOCKER_TOOLS_VOLUME=off|none  disable the mount entirely
 *     (fully ephemeral sessions)
 * Returns null when disabled.
 */
export function toolsVolumeName(cwd: string): string | null {
	const override = process.env.PI_DOCKER_TOOLS_VOLUME?.trim();
	if (override) {
		if (/^(off|none)$/i.test(override)) return null;
		return override;
	}
	const hash = createHash("sha256").update(cwd).digest("hex").slice(0, 10);
	return `pi-docker-tools-${hash}`;
}

function volumeExists(name: string): boolean {
	return (
		spawnSync("docker", ["volume", "inspect", name], { timeout: 10_000 })
			.status === 0
	);
}

function imageExists(tag: string): boolean {
	const r = spawnSync("docker", ["image", "inspect", tag], { timeout: 10_000 });
	return r.status === 0;
}

/** Truncate a string for inclusion in an error message. */
function short(s: string, n = 200): string {
	return s.length > n ? s.slice(0, n) + "…" : s;
}

// ---------------------------------------------------------------------------
// Settings filtering (permission-free container sessions)
// ---------------------------------------------------------------------------

/** Package-source substrings (case-insensitive) dropped from container settings. */
const DEFAULT_DROP_PACKAGES = "@gotgenes/pi-permission-system";

/**
 * Strip // and /* *\/ comments outside of strings (defensive JSONC handling;
 * settings.json is plain JSON today but this keeps the filter robust).
 */
function stripJsonComments(src: string): string {
	let out = "";
	let i = 0;
	let inString = false;
	while (i < src.length) {
		const ch = src[i];
		if (inString) {
			out += ch;
			if (ch === "\\") {
				out += src[i + 1] ?? "";
				i += 2;
				continue;
			}
			if (ch === '"') inString = false;
			i++;
			continue;
		}
		if (ch === '"') {
			inString = true;
			out += ch;
			i++;
			continue;
		}
		if (ch === "/" && src[i + 1] === "/") {
			while (i < src.length && src[i] !== "\n") i++;
			continue;
		}
		if (ch === "/" && src[i + 1] === "*") {
			i += 2;
			while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) i++;
			i += 2;
			continue;
		}
		out += ch;
		i++;
	}
	return out;
}

/** Drop patterns from env (comma-separated), defaulting to the permission system. */
function dropPatterns(): string[] {
	const raw = process.env.PI_DOCKER_DROP_PACKAGES ?? DEFAULT_DROP_PACKAGES;
	return raw
		.split(",")
		.map((s) => s.trim().toLowerCase())
		.filter(Boolean);
}

interface FilteredSettings {
	/** Re-serialized settings JSON with dropped packages removed. */
	json: string;
	/** Package entries that were removed. */
	dropped: string[];
}

/**
 * Remove configured package entries from raw settings text.
 * Returns null when the settings are missing, unparseable, lack a packages
 * array, or nothing matched (in which case the host settings stay live in the
 * container — no pointless shadow mount).
 */
export function filterSettings(raw: string): FilteredSettings | null {
	const patterns = dropPatterns();
	if (!patterns.length) return null;
	let parsed: { packages?: unknown };
	try {
		parsed = JSON.parse(stripJsonComments(raw));
	} catch {
		return null;
	}
	if (!Array.isArray(parsed?.packages)) return null;
	const packages = parsed.packages as unknown[];
	const dropped: string[] = [];
	const kept = packages.filter((entry) => {
		const source = typeof entry === "string" ? entry : String(entry);
		const hit = patterns.some((p) => source.toLowerCase().includes(p));
		if (hit) dropped.push(source);
		return !hit;
	});
	if (dropped.length === 0) return null;
	parsed.packages = kept;
	return { json: JSON.stringify(parsed, null, 2) + "\n", dropped };
}

/**
 * Filter the host settings and write the container copy. Returns the filter
 * result, or null when no overlay should be mounted: silently for the
 * intentional no-match/opt-out path, and (after one status line) on real
 * failures — the container then runs with unfiltered host settings (fail-open).
 */
export function prepareContainerSettings(
	homeDir: string,
): FilteredSettings | null {
	try {
		const hostSettings = join(homeDir, ".pi", "agent", "settings.json");
		if (!existsSync(hostSettings)) {
			console.error(
				`docker-session: could not filter settings — permission system will load in container (${hostSettings} not found)`,
			);
			return null;
		}
		if (!dropPatterns().length) return null; // explicit opt-out: stay silent
		const raw = readFileSync(hostSettings, "utf8");
		const filtered = filterSettings(raw);
		if (!filtered) {
			// Distinguish genuine breakage from the silent no-match path.
			let ok: boolean;
			try {
				ok = Array.isArray(JSON.parse(stripJsonComments(raw))?.packages);
			} catch {
				ok = false;
			}
			if (!ok) {
				console.error(
					`docker-session: could not filter settings — permission system will load in container (${hostSettings} unparseable)`,
				);
			}
			return null;
		}
		// Written on every launch so the copy keeps tracking host settings
		// changes (e.g. newly added packages). Lives inside the already-mounted
		// ~/.pi, so the identical container path exists before the overlay mount.
		mkdirSync(DOCKER_DIR, { recursive: true });
		writeFileSync(join(DOCKER_DIR, "settings.json"), filtered.json);
		return filtered;
	} catch (err) {
		console.error(
			`docker-session: could not filter settings — permission system will load in container (${short(
				String((err as Error)?.message ?? err),
				120,
			)})`,
		);
		return null;
	}
}

/** Build the `docker run` argv for the container pi session. */
export function buildRunArgs(opts: {
	version: string;
	uid: number;
	gid: number;
	rootlessPodman: boolean;
	homeDir: string; // host home (for the ~/.pi mount source)
	piHomeDir: string; // where ~/.pi appears inside the container
	cwd: string;
	args: string[];
	/** Host path of the filtered settings copy, when one was prepared. */
	settingsOverlay?: string;
	/** Engine volume mounted at /usr for tool persistence, when enabled. */
	toolsVolume?: string;
}): string[] {
	const {
		version,
		uid,
		gid,
		rootlessPodman,
		homeDir,
		piHomeDir,
		cwd,
		args,
		settingsOverlay,
		toolsVolume,
	} = opts;

	const dockerArgs = ["run", "--rm", "-it"];

	// User mapping so files created inside the container are owned by the
	// host user:
	//   - Rootless Podman maps container root (0) to the host user, and
	//     non-root container uids to subuid ranges (breaking file ownership
	//     parity) — so run as container root there.
	//   - Docker Desktop runs a root VM, so map the host uid/gid explicitly.
	//   - Host root: skip mapping entirely, mount home at /root/.pi.
	if (uid !== 0 && !rootlessPodman) {
		dockerArgs.push("--user", `${uid}:${gid}`);
	}

	// Environment
	dockerArgs.push("-e", `HOME=${piHomeDir}`);
	dockerArgs.push("-e", `PI_IN_CONTAINER=1`);
	// Pin the agent dir to the shared mount. pi defaults to ~/.pi/agent, which
	// with HOME=<piHomeDir> would resolve to <piHomeDir>/.pi/agent — a fresh
	// dir one level too deep — so set it explicitly and ignore any host value.
	dockerArgs.push("-e", `PI_CODING_AGENT_DIR=${piHomeDir}/agent`);
	if (process.env.TERM) dockerArgs.push("-e", "TERM");
	// PI_* passthrough, except session pointers: the container must get its
	// own new session, not append to the host's active one, and except the
	// agent dir, which points at the host path and doesn't exist in-container.
	const skipEnv = new Set([
		"PI_SESSION_FILE",
		"PI_SESSION_ID",
		"PI_IN_CONTAINER",
		"PI_CODING_AGENT_DIR",
	]);
	for (const [key, value] of Object.entries(process.env)) {
		if (key.startsWith("PI_") && value !== undefined && !skipEnv.has(key)) {
			dockerArgs.push("-e", `${key}=${value}`);
		}
	}
	for (const key of PROVIDER_ENV_VARS) {
		const value = process.env[key];
		if (value !== undefined) dockerArgs.push("-e", `${key}=${value}`);
	}

	// Bind mounts, always :Z-labeled (required by rootless Podman on SELinux
	// hosts; Docker Desktop accepts and ignores the label).
	dockerArgs.push("-v", `${cwd}:${cwd}:Z`);
	dockerArgs.push("-v", `${homeDir}/.pi:${piHomeDir}:Z`);

	// Single-file overlay shadowing the shared settings.json: drops configured
	// packages (default: the permission system) inside the container only.
	// Layered over the ~/.pi directory mount above; `:Z` on a single user-owned
	// file is fine under Docker Desktop and rootless Podman alike.
	if (settingsOverlay) {
		dockerArgs.push(
			"-v",
			`${settingsOverlay}:${piHomeDir}/agent/settings.json:Z`,
		);
	}

	// Tools-persistence volume at /usr: engine-managed (auto-created on first
	// use by copy-up from the image), so no :Z label is needed — labels apply
	// to bind mounts, not named volumes. `--rm` still discards the writable
	// container layer; only /usr persists.
	if (toolsVolume) {
		dockerArgs.push("-v", `${toolsVolume}:/usr`);
	}

	dockerArgs.push("-w", cwd);
	dockerArgs.push(imageTag(version));
	dockerArgs.push("pi", ...args);
	return dockerArgs;
}

// ---------------------------------------------------------------------------
// Launch flow
// ---------------------------------------------------------------------------

interface LaunchResult {
	code: number | null;
	error?: string;
}

interface RebuildResult {
	ok: boolean;
	error?: string;
	note?: string;
}

/**
 * Reset tool state: remove the project's tools volume (if any) and rebuild
 * the sandbox image. Order matters — the image rebuild only happens after the
 * volume removal succeeds, so a failure (e.g. volume in use) leaves nothing
 * half-done.
 */
export function rebuild(cwd: string, noCache: boolean): RebuildResult {
	// Same preflight as launch: docker CLI present + engine reachable.
	const which = spawnSync("which", ["docker"], { encoding: "utf8" });
	if (which.status !== 0 || !which.stdout.trim()) {
		return {
			ok: false,
			error:
				"`docker` CLI not found. Install Docker or the Podman docker compatibility layer (e.g. `podman-docker`).",
		};
	}
	const engine = detectEngine();
	if (!engine.ok) {
		const backend = engine.name;
		const hint = engine.podman
			? `Is the ${backend} machine running? Try: podman machine start`
			: `Is Docker running? Start Docker Desktop (or the docker daemon).`;
		return {
			ok: false,
			error: `Container engine unreachable (${short(engine.error ?? "", 160)}). ${hint}`,
		};
	}

	// 1. Remove the tools volume, when one is configured for this project.
	const volume = toolsVolumeName(cwd);
	let volumeRemoved: string | null = null;
	if (volume && volumeExists(volume)) {
		const rm = spawnSync("docker", ["volume", "rm", volume], {
			encoding: "utf8",
			timeout: 30_000,
		});
		if (rm.status !== 0) {
			const detail = short((rm.stderr ?? rm.stdout ?? "").toString().trim(), 200);
			return {
				ok: false,
				error: `Failed to remove tools volume ${volume} (exit ${rm.status ?? "?"}). ${detail} — is a container still using it? Reset aborted; nothing was rebuilt.`,
			};
		}
		volumeRemoved = volume;
	}

	// 2. Rebuild the sandbox image (layer cache makes this cheap unless
	// --no-cache was requested).
	const version = hostPiVersion();
	const tag = imageTag(version);
	const dockerfile = ensureDockerfile(version);
	console.error(
		`docker-session: rebuilding image ${tag}${noCache ? " (--no-cache)" : ""}...`,
	);
	const buildArgs = ["build", "-t", tag, "-f", dockerfile];
	if (noCache) buildArgs.push("--no-cache");
	buildArgs.push(DOCKER_DIR);
	const build = spawnSync("docker", buildArgs, { stdio: "inherit" });
	if (build.status !== 0) {
		return {
			ok: false,
			error: `Failed to build image ${tag} (exit ${build.status ?? "?"}). Build output above; fix the issue and retry /docker rebuild.`,
		};
	}

	let note: string;
	if (volumeRemoved) {
		note = `reset: removed tools volume ${volumeRemoved}; rebuilt ${tag} — next launch re-copies /usr from the image (slower first launch, one-time)`;
	} else if (volume) {
		note = `reset: no tools volume to remove; rebuilt ${tag} — next launch re-copies /usr from the image (slower first launch, one-time)`;
	} else {
		note = `reset: tools volume disabled (PI_DOCKER_TOOLS_VOLUME=off) — rebuilt ${tag}`;
	}
	return { ok: true, note };
}

/** The whole launch (preflight + run) runs while the TUI is suspended. */
function launch(args: string[], cwd: string): LaunchResult {
	// 1. docker CLI present?
	const which = spawnSync("which", ["docker"], { encoding: "utf8" });
	if (which.status !== 0 || !which.stdout.trim()) {
		return {
			code: null,
			error:
				"`docker` CLI not found. Install Docker or the Podman docker compatibility layer (e.g. `podman-docker`).",
		};
	}

	// 2. Engine reachable? (names the backend in errors)
	const engine = detectEngine();
	if (!engine.ok) {
		const backend = engine.name;
		const hint = engine.podman
			? `Is the ${backend} machine running? Try: podman machine start`
			: `Is Docker running? Start Docker Desktop (or the docker daemon).`;
		return {
			code: null,
			error: `Container engine unreachable (${short(engine.error ?? "", 160)}). ${hint}`,
		};
	}
	console.error(
		`docker-session: backend detected: ${engine.name}${engine.rootless ? " (rootless)" : ""}`,
	);

	// 3. Image present for this host pi version? Build if not.
	const version = hostPiVersion();
	const tag = imageTag(version);
	if (!imageExists(tag)) {
		const dockerfile = ensureDockerfile(version);
		console.error(
			`docker-session: building image ${tag} (first run takes a minute)...`,
		);
		const build = spawnSync(
			"docker",
			["build", "-t", tag, "-f", dockerfile, DOCKER_DIR],
			{ stdio: "inherit" },
		);
		if (build.status !== 0) {
			return {
				code: null,
				error: `Failed to build image ${tag} (exit ${build.status ?? "?"}). Build output above; fix the issue and retry /docker.`,
			};
		}
	}

	// 4. Tools-persistence volume: derived from cwd unless overridden/disabled
	// via PI_DOCKER_TOOLS_VOLUME. The engine auto-creates it on first use; we
	// just announce the one-time copy-up cost when it doesn't exist yet.
	const toolsVolume = toolsVolumeName(cwd) ?? undefined;
	if (toolsVolume && !volumeExists(toolsVolume)) {
		console.error(
			`docker-session: initializing tools volume ${toolsVolume} (first-run /usr copy-up, one-time)...`,
		);
	}

	// 5. Filter settings for the container (drops the permission system and
	// anything on PI_DOCKER_DROP_PACKAGES) and write the copy that gets
	// bind-mounted over the shared settings.json inside the container. On
	// failure (missing/unparseable settings) we fail open: launch proceeds
	// without the overlay and the permission system loads as usual.
	const uid = process.getuid?.() ?? 1000;
	const gid = process.getgid?.() ?? 1000;
	const isRoot = uid === 0;
	const piHomeDir = isRoot ? "/root/.pi" : `/home/${CONTAINER_USER}/.pi`;
	const homeDir = process.env.HOME ?? "/root";

	const filtered = prepareContainerSettings(homeDir);
	if (filtered) {
		console.error(
			`docker-session: container settings filtered — dropping: ${filtered.dropped.join(", ")}`,
		);
	}

	// 6. Run the container with the host pi TUI in it.
	const runArgs = buildRunArgs({
		version,
		uid,
		gid,
		rootlessPodman: engine.rootless,
		homeDir,
		piHomeDir,
		cwd,
		args,
		settingsOverlay: filtered ? join(DOCKER_DIR, "settings.json") : undefined,
		toolsVolume,
	});

	console.error(`docker-session: starting container session (pi ${version})...`);
	const run = spawnSync("docker", runArgs, {
		stdio: "inherit",
		env: process.env,
	});
	return { code: run.status };
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
	pi.registerCommand("docker", {
		description:
			"Start a new pi session inside a container (same settings, packages, auth, and project path). Extra args are passed to the container's pi.",
		handler: async (args, ctx) => {
			if (ctx.mode !== "tui") {
				ctx.ui.notify("/docker requires an interactive TUI session", "warning");
				return;
			}
			if (process.env.PI_IN_CONTAINER) {
				ctx.ui.notify(
					"Already inside a container session (/docker cannot nest)",
					"warning",
				);
				return;
			}

			const cwd = ctx.cwd;
			const trimmed = (args ?? "").trim();
			const tokens = trimmed.length ? trimmed.split(/\s+/) : [];

			// /docker rebuild [--no-cache]: reset tool state (remove the tools
			// volume) and rebuild the sandbox image. Anything else after
			// "rebuild" is warned about and ignored.
			if (tokens[0] === "rebuild") {
				let noCache = false;
				const ignored: string[] = [];
				for (const token of tokens.slice(1)) {
					if (token === "--no-cache") noCache = true;
					else ignored.push(token);
				}
				if (ignored.length) {
					ctx.ui.notify(
						`/docker rebuild: ignoring unsupported arg(s): ${ignored.join(", ")}`,
						"warning",
					);
				}

				const result = await ctx.ui.custom<RebuildResult>(
					(tui, _theme, _kb, done) => {
						tui.stop();
						process.stdout.write("\x1b[2J\x1b[H");

						const res = rebuild(cwd, noCache);

						tui.start();
						tui.requestRender(true);
						done(res);
						return { render: () => [], invalidate: () => {} };
					},
				);
				if (!result) return;
				if (!result.ok) {
					ctx.ui.notify(result.error ?? "Rebuild failed", "error");
					return;
				}
				ctx.ui.notify(result.note ?? "Rebuild complete", "info");
				return;
			}

			// Anything else is forwarded verbatim to the container's pi.
			const extraArgs = tokens;

			// Suspend the TUI, run the container synchronously with the
			// terminal inherited, then restore the TUI.
			const result = await ctx.ui.custom<LaunchResult>(
				(tui, _theme, _kb, done) => {
					tui.stop();
					process.stdout.write("\x1b[2J\x1b[H");

					const res = launch(extraArgs, cwd);

					tui.start();
					tui.requestRender(true);
					done(res);
					return { render: () => [], invalidate: () => {} };
				},
			);

			if (!result) return;
			if (result.error) {
				ctx.ui.notify(result.error, "error");
				return;
			}
			const code = result.code;
			if (code === 0) {
				ctx.ui.notify("Container pi session exited cleanly (0)", "info");
			} else if (code === null || code === undefined) {
				ctx.ui.notify("Container pi session terminated", "warning");
			} else {
				ctx.ui.notify(
					`Container pi session exited with code ${code}`,
					code === 130 ? "info" : "warning",
				);
			}
		},
	});
}
