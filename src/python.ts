import {
  defineSteps,
  StepError,
  type ExecResult,
  type StepCtx,
} from "@perfscale/library-sdk";

/**
 * `python` — trusted local Python steps for perfscale (RFC 009 `process`
 * capability). Three steps over the bounded host import (`ctx.exec`):
 *
 * - `install`       — download an official astral-sh/python-build-standalone
 *                     release tarball, verify its SHA-256 against the
 *                     release's own SHA256SUMS, and extract it into a local
 *                     toolcache (idempotent).
 * - `exec`          — run an inline script (`python -c`) or a script file
 *                     with a chosen python binary, exit code preserved.
 * - `install-exec`  — compose both: install (or reuse the cache), then exec
 *                     with the installed python.
 *
 * Linux-first: `install` supports linux x86_64 and aarch64 only and
 * downloads exclusively from
 * `https://github.com/astral-sh/python-build-standalone/releases` over HTTPS
 * via direct argv to `/usr/bin/curl` — no shell anywhere, a replacement
 * environment on every spawn. The component only loads when the run grants
 * the capability twice over: `capabilities: [process]` on the library entry
 * AND `allow_process_actions: true` + `allow_library_capabilities: true` in
 * the config.
 *
 * Build: node ../sdk-step-authoring/ts/bin/perfscale-library-build.mjs \
 *          --kind steps --process src/python.ts -o python.wasm
 */

/** Minimal explicit PATH: the host environment is never inherited. */
const DEFAULT_PATH = "/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin";

const DEFAULT_INSTALL_DIR = "/tmp/perfscale-toolcache/python";
const DEFAULT_PYTHON_PATH = "/usr/bin/python3";
const RELEASES = "https://github.com/astral-sh/python-build-standalone/releases";

/** Host-call budgets (still host-capped on top of these). */
const TARBALL_TIMEOUT_MS = 600_000;
const SMALL_TIMEOUT_MS = 60_000;

type Log = { tag: "out" | "err" | "sys"; line: string };
type Out = Record<string, unknown>;

interface StepOutcome {
  success: boolean;
  output: Out;
  logs: Log[];
}

/** A `with:` block may only carry these keys; anything else is an error. */
function strictKeys(step: string, params: Record<string, unknown>, allowed: string[]): void {
  for (const k of Object.keys(params)) {
    if (!allowed.includes(k)) {
      throw new StepError(`python/${step}: unknown param '${k}'`);
    }
  }
}

function reqString(step: string, params: Record<string, unknown>, key: string): string {
  const v = params[key];
  if (typeof v !== "string" || v === "") {
    throw new StepError(`python/${step}: '${key}' is required and must be a non-empty string`);
  }
  return v;
}

function optString(step: string, params: Record<string, unknown>, key: string): string | undefined {
  const v = params[key];
  if (v === undefined) return undefined;
  if (typeof v !== "string" || v === "") {
    throw new StepError(`python/${step}: '${key}' must be a non-empty string`);
  }
  return v;
}

/** `working-directory` with `cwd` as an accepted alias; both must agree. */
function optCwd(step: string, params: Record<string, unknown>): string | undefined {
  const wd = params["working-directory"];
  const cwd = params["cwd"];
  for (const [k, v] of [["working-directory", wd], ["cwd", cwd]] as const) {
    if (v !== undefined && (typeof v !== "string" || v === "")) {
      throw new StepError(`python/${step}: '${k}' must be a non-empty string`);
    }
  }
  if (wd !== undefined && cwd !== undefined && wd !== cwd) {
    throw new StepError(`python/${step}: 'working-directory' and 'cwd' disagree`);
  }
  return (wd ?? cwd) as string | undefined;
}

/** User env merges over the minimal PATH; every value must be a string. */
function optEnv(step: string, params: Record<string, unknown>): Record<string, string> {
  const env: Record<string, string> = { PATH: DEFAULT_PATH };
  const v = params["env"];
  if (v === undefined) return env;
  if (typeof v !== "object" || v === null || Array.isArray(v)) {
    throw new StepError(`python/${step}: 'env' must be a map of string to string`);
  }
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (typeof val !== "string") {
      throw new StepError(`python/${step}: env['${k}'] must be a string`);
    }
    env[k] = val;
  }
  return env;
}

/** Extra arguments, passed verbatim to python (no shell splitting). */
function optArgs(step: string, params: Record<string, unknown>): string[] {
  const v = params["args"];
  if (v === undefined) return [];
  if (!Array.isArray(v) || v.some((a) => typeof a !== "string")) {
    throw new StepError(`python/${step}: 'args' must be an array of strings`);
  }
  return v as string[];
}

/** Accepts a number or a numeric string (like other perfscale params). */
function optTimeoutMs(step: string, params: Record<string, unknown>): number | undefined {
  for (const key of ["timeout_ms", "timeoutMs"] as const) {
    const v = params[key];
    if (v === undefined) continue;
    const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
    if (!Number.isFinite(n) || n <= 0) {
      throw new StepError(`python/${step}: '${key}' must be a positive number of milliseconds`);
    }
    return n;
  }
  return undefined;
}

function runHost(
  ctx: StepCtx,
  req: {
    executable: string;
    argv: string[];
    cwd?: string;
    timeoutMs?: number;
  },
): ExecResult {
  return ctx.exec({
    executable: req.executable,
    argv: req.argv,
    env: { PATH: DEFAULT_PATH, PERFSCALE_STEP: ctx.stepName },
    ...(req.cwd !== undefined ? { cwd: req.cwd } : {}),
    ...(req.timeoutMs !== undefined ? { timeoutMs: req.timeoutMs } : {}),
  });
}

function failOut(logs: Log[], res: ExecResult, note: string): StepOutcome {
  logs.push({ tag: "sys", line: note });
  if (res.stdout !== "") logs.push({ tag: "out", line: res.stdout.trimEnd() });
  if (res.stderr !== "") logs.push({ tag: "err", line: res.stderr.trimEnd() });
  return {
    success: false,
    output: { exit_code: res.exitCode, stdout: res.stdout, stderr: res.stderr },
    logs,
  };
}

// ---------------------------------------------------------------------------
// install
// ---------------------------------------------------------------------------

const EXACT_VERSION = /^\d+\.\d+\.\d+$/;
const RELEASE_TAG = /^\d{8}$/;

interface InstallParsed {
  version: string;
  release: string | undefined;
  installDir: string;
}

function parseInstallParams(step: string, params: Record<string, unknown>): InstallParsed {
  const pythonVersion = reqString(step, params, "python-version");
  if (!EXACT_VERSION.test(pythonVersion)) {
    throw new StepError(
      `python/${step}: 'python-version' must be an exact full version X.Y.Z (e.g. 3.13.18)`,
    );
  }
  const release = optString(step, params, "release");
  if (release !== undefined && !RELEASE_TAG.test(release)) {
    throw new StepError(
      `python/${step}: 'release' must be a python-build-standalone release tag (e.g. 20261026)`,
    );
  }
  const installDir = optString(step, params, "install-dir") ?? DEFAULT_INSTALL_DIR;
  return { version: pythonVersion, release, installDir };
}

/** Map the host to a python-build-standalone target triple; else unsupported. */
function hostTriple(ctx: StepCtx): string {
  const os = runHost(ctx, {
    executable: "/usr/bin/uname",
    argv: ["-s"],
    timeoutMs: SMALL_TIMEOUT_MS,
  });
  const osName = os.stdout.trim();
  if (os.exitCode !== 0 || osName !== "Linux") {
    throw new StepError(
      `python: unsupported OS '${osName || "?"}' — install supports Linux only (python-build-standalone linux tarballs)`,
    );
  }
  const machine = runHost(ctx, {
    executable: "/usr/bin/uname",
    argv: ["-m"],
    timeoutMs: SMALL_TIMEOUT_MS,
  });
  const m = machine.stdout.trim();
  if (machine.exitCode === 0 && m === "x86_64") return "x86_64-unknown-linux-gnu";
  if (machine.exitCode === 0 && m === "aarch64") return "aarch64-unknown-linux-gnu";
  throw new StepError(
    `python: unsupported architecture '${m || "?"}' — install supports linux x86_64 and aarch64 only`,
  );
}

/** First line of SHA256SUMS content matching `re`, as a regex match. */
function matchSums(sums: string, re: RegExp): RegExpExecArray | undefined {
  for (const line of sums.split("\n")) {
    const m = re.exec(line.trim());
    if (m) return m;
  }
  return undefined;
}

function assetName(version: string, release: string, triple: string): string {
  return `cpython-${version}+${release}-${triple}-install_only_stripped.tar.gz`;
}

/**
 * Resolve the release tag. A pinned `release` is used verbatim; otherwise the
 * latest release's SHA256SUMS (via the releases/latest redirect) is scanned
 * for an exact-version asset and the release is parsed out of its name.
 */
function resolveRelease(
  ctx: StepCtx,
  version: string,
  requested: string | undefined,
  triple: string,
  logs: Log[],
): { release: string; sums: string } | StepOutcome {
  if (requested !== undefined) {
    const url = `${RELEASES}/download/${requested}/SHA256SUMS`;
    logs.push({ tag: "sys", line: `python: fetching checksums from pinned release ${requested}` });
    const res = runHost(ctx, {
      executable: "/usr/bin/curl",
      argv: ["-fsSL", url],
      timeoutMs: SMALL_TIMEOUT_MS,
    });
    if (res.exitCode !== 0) {
      return failOut(logs, res, `python: failed to fetch ${url}`);
    }
    return { release: requested, sums: res.stdout };
  }
  const url = `${RELEASES}/latest/download/SHA256SUMS`;
  logs.push({ tag: "sys", line: `python: resolving latest python-build-standalone release via ${url}` });
  const res = runHost(ctx, {
    executable: "/usr/bin/curl",
    argv: ["-fsSL", url],
    timeoutMs: SMALL_TIMEOUT_MS,
  });
  if (res.exitCode !== 0) {
    return failOut(logs, res, `python: failed to fetch ${url}`);
  }
  const assetRe = new RegExp(
    `^[0-9a-f]{64}  cpython-${version.replaceAll(".", "\\.")}\\+(\\d{8})-${triple}-install_only_stripped\\.tar\\.gz$`,
  );
  const release = matchSums(res.stdout, assetRe)?.[1];
  if (release === undefined) {
    logs.push({ tag: "sys", line: `python: no cpython-${version} asset for ${triple} in the latest release` });
    return {
      success: false,
      output: { exit_code: 1, stdout: res.stdout, stderr: res.stderr },
      logs,
    };
  }
  logs.push({ tag: "sys", line: `python: resolved latest release → ${release}` });
  return { release, sums: res.stdout };
}

function runInstall(step: string, params: Record<string, unknown>, ctx: StepCtx): StepOutcome {
  const logs: Log[] = [];
  const { version, release: requestedRelease, installDir } = parseInstallParams(step, params);
  const triple = hostTriple(ctx);

  const resolved = resolveRelease(ctx, version, requestedRelease, triple, logs);
  if (!("release" in resolved)) return resolved;
  const { release, sums } = resolved;

  const asset = assetName(version, release, triple);
  const base = `cpython-${version}+${release}-${triple}`;
  const path = `${installDir}/${base}`;
  const pythonPath = `${path}/python/bin/python3`;

  // Idempotent: a working cached python is reused, never re-downloaded.
  const cached = runHost(ctx, {
    executable: pythonPath,
    argv: ["--version"],
    timeoutMs: SMALL_TIMEOUT_MS,
  });
  if (cached.exitCode === 0) {
    logs.push({ tag: "sys", line: `python: ${base} already installed at ${path} (${cached.stdout.trim()})` });
    return {
      success: true,
      output: {
        path,
        "python-path": pythonPath,
        version,
        release,
        exit_code: 0,
        stdout: cached.stdout,
        stderr: cached.stderr,
      },
      logs,
    };
  }

  const tarballUrl = `${RELEASES}/download/${release}/${asset}`;
  const archive = `${installDir}/.${asset}`;

  const expected = matchSums(
    sums,
    new RegExp(`^([0-9a-f]{64})  ${asset.replaceAll(".", "\\.").replaceAll("+", "\\+")}$`),
  )?.[1];
  if (expected === undefined) {
    logs.push({ tag: "sys", line: `python: no checksum for ${asset} in release ${release} SHA256SUMS` });
    return { success: false, output: { exit_code: 1, stdout: sums, stderr: "" }, logs };
  }

  const mk = runHost(ctx, {
    executable: "/usr/bin/mkdir",
    argv: ["-p", installDir],
    timeoutMs: SMALL_TIMEOUT_MS,
  });
  if (mk.exitCode !== 0) return failOut(logs, mk, `python: mkdir -p ${installDir} failed`);

  logs.push({ tag: "sys", line: `python: downloading ${tarballUrl}` });
  const dl = runHost(ctx, {
    executable: "/usr/bin/curl",
    argv: ["-fsSL", tarballUrl, "-o", archive],
    timeoutMs: TARBALL_TIMEOUT_MS,
  });
  if (dl.exitCode !== 0) return failOut(logs, dl, `python: download of ${tarballUrl} failed`);

  const sum = runHost(ctx, {
    executable: "/usr/bin/sha256sum",
    argv: [archive],
    timeoutMs: SMALL_TIMEOUT_MS,
  });
  const actual = sum.exitCode === 0 ? (sum.stdout.trim().split(/\s+/)[0] ?? "") : "";
  if (sum.exitCode !== 0 || actual !== expected) {
    // Delete only the bad downloaded archive; never rm install trees.
    runHost(ctx, { executable: "/usr/bin/rm", argv: ["-f", archive], timeoutMs: SMALL_TIMEOUT_MS });
    logs.push({
      tag: "sys",
      line: `python: checksum mismatch for ${asset} (expected ${expected}, got ${actual || "?"}) — archive deleted`,
    });
    return {
      success: false,
      output: { exit_code: sum.exitCode === 0 ? 1 : sum.exitCode, stdout: sum.stdout, stderr: sum.stderr },
      logs,
    };
  }
  logs.push({ tag: "sys", line: `python: sha256 verified (${expected})` });

  // The tarball's single top-level dir is `python/`; extract it under the
  // version+release+triple target so unrelated toolcache dirs are untouched.
  const mkTarget = runHost(ctx, {
    executable: "/usr/bin/mkdir",
    argv: ["-p", path],
    timeoutMs: SMALL_TIMEOUT_MS,
  });
  if (mkTarget.exitCode !== 0) return failOut(logs, mkTarget, `python: mkdir -p ${path} failed`);
  const untar = runHost(ctx, {
    executable: "/usr/bin/tar",
    argv: ["-xzf", archive, "-C", path],
    timeoutMs: TARBALL_TIMEOUT_MS,
  });
  if (untar.exitCode !== 0) return failOut(logs, untar, `python: extraction of ${archive} failed`);
  runHost(ctx, { executable: "/usr/bin/rm", argv: ["-f", archive], timeoutMs: SMALL_TIMEOUT_MS });

  const verify = runHost(ctx, {
    executable: pythonPath,
    argv: ["--version"],
    timeoutMs: SMALL_TIMEOUT_MS,
  });
  if (verify.exitCode !== 0) {
    return failOut(logs, verify, `python: installed python at ${pythonPath} failed --version`);
  }
  logs.push({ tag: "sys", line: `python: installed ${base} at ${path} (${verify.stdout.trim()})` });
  return {
    success: true,
    output: {
      path,
      "python-path": pythonPath,
      version,
      release,
      exit_code: 0,
      stdout: verify.stdout,
      stderr: verify.stderr,
    },
    logs,
  };
}

// ---------------------------------------------------------------------------
// exec
// ---------------------------------------------------------------------------

const EXEC_KEYS = [
  "script", "file", "python-path", "args", "working-directory", "cwd", "env",
  "timeout_ms", "timeoutMs",
];

function runExec(
  step: string,
  params: Record<string, unknown>,
  ctx: StepCtx,
  installedPythonPath?: string,
): StepOutcome {
  const script = optString(step, params, "script");
  const file = optString(step, params, "file");
  if ((script === undefined) === (file === undefined)) {
    throw new StepError(`python/${step}: exactly one of 'script' or 'file' is required`);
  }
  const pythonPath = installedPythonPath ?? optString(step, params, "python-path") ?? DEFAULT_PYTHON_PATH;
  if (!pythonPath.startsWith("/")) {
    throw new StepError(`python/${step}: 'python-path' must be an absolute path to the python executable`);
  }
  const args = optArgs(step, params);
  const cwd = optCwd(step, params);
  const env = optEnv(step, params);
  const timeoutMs = optTimeoutMs(step, params);

  const argv = script !== undefined ? ["-c", script, ...args] : [file!, ...args];
  const res = ctx.exec({
    executable: pythonPath,
    argv,
    env: { ...env, PERFSCALE_STEP: ctx.stepName },
    ...(cwd !== undefined ? { cwd } : {}),
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
  });
  const logs: Log[] = [
    { tag: "sys", line: `python/${step}: ${pythonPath} exit code ${res.exitCode}` },
  ];
  if (res.stdout !== "") logs.push({ tag: "out", line: res.stdout.trimEnd() });
  if (res.stderr !== "") logs.push({ tag: "err", line: res.stderr.trimEnd() });
  return {
    success: res.exitCode === 0,
    output: { exit_code: res.exitCode, stdout: res.stdout, stderr: res.stderr },
    logs,
  };
}

// ---------------------------------------------------------------------------

export default defineSteps({
  name: "python",
  version: "0.1.0",
  steps: {
    install: {
      description:
        "Install an official python-build-standalone CPython release (checksum-verified) into a local toolcache; idempotent per version+release+arch",
      run(params, ctx) {
        strictKeys("install", params, ["python-version", "release", "install-dir"]);
        return runInstall("install", params, ctx);
      },
    },
    exec: {
      description:
        "Run an inline Python script (`python -c`) or a script file with a chosen python binary; exit code preserved",
      run(params, ctx) {
        strictKeys("exec", params, EXEC_KEYS);
        return runExec("exec", params, ctx);
      },
    },
    "install-exec": {
      description:
        "Install (or reuse the cached) Python, then run a script with the installed python; installation failure skips exec",
      run(params, ctx) {
        strictKeys("install-exec", params, ["python-version", "release", "install-dir", ...EXEC_KEYS.filter((k) => k !== "python-path")]);
        const inst = runInstall("install-exec", params, ctx);
        if (!inst.success) return inst;
        const pythonPath = inst.output["python-path"] as string;
        const ex = runExec("install-exec", params, ctx, pythonPath);
        return {
          success: ex.success,
          output: {
            path: inst.output["path"],
            "python-path": pythonPath,
            version: inst.output["version"],
            release: inst.output["release"],
            exit_code: ex.output["exit_code"],
            stdout: ex.output["stdout"],
            stderr: ex.output["stderr"],
          },
          logs: [...inst.logs, ...ex.logs],
        };
      },
    },
  },
});
