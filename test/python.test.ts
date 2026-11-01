import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  StepCtx,
  StepError,
  testStep,
  type ExecRequest,
  type ExecResult,
  type HostExec,
} from "@perfscale/library-sdk";
import def from "../src/python.ts";

/**
 * Record every host spawn and answer from a script. The harness fake is a
 * WIT-boundary `HostExec` (env as entry pairs); tests see the ergonomic
 * ExecRequest shape (env as a Record) the component itself uses.
 */
function fakeExec(handler: (req: ExecRequest, call: number) => ExecResult) {
  const calls: ExecRequest[] = [];
  const exec: HostExec = (wreq) => {
    const req: ExecRequest = {
      executable: wreq.executable,
      env: Object.fromEntries(wreq.env ?? []),
    };
    if (wreq.argv !== undefined) req.argv = wreq.argv;
    if (wreq.cwd !== undefined) req.cwd = wreq.cwd;
    if (wreq.timeoutMs !== undefined) req.timeoutMs = wreq.timeoutMs;
    calls.push(req);
    return handler(req, calls.length - 1);
  };
  return { calls, exec };
}

function ctx(exec?: HostExec): StepCtx {
  const c = new StepCtx(exec);
  c.stepName = "t";
  return c;
}

const ok = (stdout = ""): ExecResult => ({ exitCode: 0, stdout, stderr: "" });
const SHA = "a".repeat(64);
const VERSION = "3.13.18";
const RELEASE = "20261026";
const TRIPLE = "x86_64-unknown-linux-gnu";
const ASSET = `cpython-${VERSION}+${RELEASE}-${TRIPLE}-install_only_stripped.tar.gz`;
const sums = (sha = SHA): string => `${sha}  ${ASSET}\n`;

/**
 * A full Linux host for install flows. `python --version` fails on the
 * first invocation (cache miss) and succeeds afterwards (post-install
 * verify), unless `cached` — then it succeeds immediately and nothing is
 * downloaded.
 */
function installHost(opts: { cached?: boolean; badSum?: boolean } = {}) {
  return fakeExec((req) => {
    const argv = req.argv ?? [];
    if (req.executable === "/usr/bin/uname") {
      return ok(argv[0] === "-s" ? "Linux\n" : "x86_64\n");
    }
    // The cache probe: ENOENT at spawn is a host error, so the component
    // checks existence with test(1) before running the cached binary.
    if (req.executable === "/usr/bin/test") {
      return opts.cached ? ok() : { exitCode: 1, stdout: "", stderr: "" };
    }
    if (req.executable.endsWith("/bin/python3")) {
      return ok(`Python ${VERSION}\n`);
    }
    if (req.executable === "/usr/bin/curl") {
      if (argv.includes("-o")) return ok();
      return ok(sums(opts.badSum ? "c".repeat(64) : SHA));
    }
    if (req.executable === "/usr/bin/sha256sum") return ok(`${SHA}  ${argv[0]}\n`);
    if (req.executable === "/usr/bin/mkdir") return ok();
    if (req.executable === "/usr/bin/tar") return ok();
    if (req.executable === "/usr/bin/rm") return ok();
    return { exitCode: 99, stdout: "", stderr: `unhandled: ${req.executable}` };
  });
}

describe("python/install", () => {
  it("installs an exact version: download, checksum, extract, verify", () => {
    const { calls, exec } = installHost();
    const res = testStep(def, ctx(exec), "install", {
      "python-version": VERSION,
      release: RELEASE,
    });
    assert.equal(res.success, true);
    const out = res.output as Record<string, unknown>;
    assert.equal(out["version"], VERSION);
    assert.equal(out["release"], RELEASE);
    assert.equal(
      out["python-path"],
      `/tmp/perfscale-toolcache/python/cpython-${VERSION}+${RELEASE}-${TRIPLE}/python/bin/python3`,
    );
    const dl = calls.find((c) => c.executable === "/usr/bin/curl" && c.argv?.includes("-o"))!;
    assert.ok(dl.argv!.includes(`https://github.com/astral-sh/python-build-standalone/releases/download/${RELEASE}/${ASSET}`));
    // every spawn is direct argv with a replacement env
    assert.ok(calls.every((c) => c.env?.PATH === "/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"));
  });

  it("rejects a checksum mismatch and deletes the archive", () => {
    const { calls, exec } = installHost({ badSum: true });
    const res = testStep(def, ctx(exec), "install", {
      "python-version": VERSION,
      release: RELEASE,
    });
    assert.equal(res.success, false);
    assert.ok(calls.some((c) => c.executable === "/usr/bin/rm"));
    assert.ok(!calls.some((c) => c.executable === "/usr/bin/tar"));
  });

  it("rejects unknown keys and bad install params", () => {
    const { exec } = installHost({ cached: true });
    for (const p of [
      { "python-version": VERSION, shell: true },
      { "python-version": "3.13" },
      { "python-version": VERSION, release: "latest" },
    ]) {
      assert.throws(() => testStep(def, ctx(exec), "install", p), StepError, JSON.stringify(p));
    }
  });
});

describe("python/exec", () => {
  it("runs an inline script with the default python", () => {
    const { calls, exec } = fakeExec(() => ok("hi\n"));
    const res = testStep(def, ctx(exec), "exec", { script: "print('hi')" });
    assert.equal(res.success, true);
    assert.equal(calls[0]!.executable, "/usr/bin/python3");
    assert.deepEqual(calls[0]!.argv, ["-c", "print('hi')"]);
  });

  it("preserves a non-zero exit code", () => {
    const { exec } = fakeExec(() => ({ exitCode: 4, stdout: "", stderr: "boom\n" }));
    const res = testStep(def, ctx(exec), "exec", { file: "t.py" });
    assert.equal(res.success, false);
    assert.equal((res.output as Record<string, unknown>)["exit_code"], 4);
  });
});

// ---------------------------------------------------------------------------
// Settings (RFC 009): extensions[python] > variables[python] > library with
// > built-in defaults; explicit step `with:` wins over everything.
// ---------------------------------------------------------------------------

function settingsCtx(
  exec: HostExec | undefined,
  settings: { extensions?: Record<string, unknown>; variables?: Record<string, unknown> },
): StepCtx {
  const c = ctx(exec);
  c.settings = {
    vus: null,
    duration_ms: null,
    seed: null,
    stages: null,
    arrival: null,
    variables: settings.variables ?? {},
    extensions: settings.extensions ?? {},
  };
  return c;
}

/** Reset library-level `with:` defaults so module state never leaks between tests. */
function resetLibraryWith() {
  def.init?.(null);
}

describe("python settings", () => {
  it("install takes python-version, release and install-dir from extensions[python]", () => {
    resetLibraryWith();
    const { exec } = installHost();
    const res = testStep(
      def,
      settingsCtx(exec, {
        extensions: {
          python: { "python-version": VERSION, release: RELEASE, "install-dir": "/opt/ext" },
        },
      }),
      "install",
      {},
    );
    assert.equal(res.success, true);
    assert.equal(
      (res.output as Record<string, unknown>)["python-path"],
      `/opt/ext/cpython-${VERSION}+${RELEASE}-${TRIPLE}/python/bin/python3`,
    );
  });

  it("explicit step params beat the run extension", () => {
    resetLibraryWith();
    const { exec } = installHost();
    const res = testStep(
      def,
      settingsCtx(exec, { extensions: { python: { "install-dir": "/opt/ext" } } }),
      "install",
      { "python-version": VERSION, release: RELEASE, "install-dir": "/opt/step" },
    );
    assert.equal(res.success, true);
    assert.equal(
      (res.output as Record<string, unknown>)["path"],
      `/opt/step/cpython-${VERSION}+${RELEASE}-${TRIPLE}`,
    );
  });

  it("variables[python] apply when no extension, library with applies below variables", () => {
    def.init?.({ "install-dir": "/opt/lib", "python-version": VERSION, release: RELEASE });
    try {
      const { exec } = installHost();
      const res = testStep(
        def,
        settingsCtx(exec, { variables: { python: { "install-dir": "/opt/vars" } } }),
        "install",
        {},
      );
      assert.equal(res.success, true);
      assert.equal(
        (res.output as Record<string, unknown>)["path"],
        `/opt/vars/cpython-${VERSION}+${RELEASE}-${TRIPLE}`,
      );
    } finally {
      resetLibraryWith();
    }
  });

  it("library with defaults apply when run settings are silent", () => {
    def.init?.({ "install-dir": "/opt/lib", "python-version": VERSION, release: RELEASE });
    try {
      const { exec } = installHost();
      const res = testStep(def, settingsCtx(exec, {}), "install", {});
      assert.equal(res.success, true);
      assert.equal(
        (res.output as Record<string, unknown>)["path"],
        `/opt/lib/cpython-${VERSION}+${RELEASE}-${TRIPLE}`,
      );
    } finally {
      resetLibraryWith();
    }
  });

  it("exec merges env in precedence order: step > extension > variables > library with", () => {
    def.init?.({ env: { A: "lib", B: "lib", C: "lib", D: "lib" } });
    try {
      const { calls, exec } = fakeExec(() => ok());
      const res = testStep(
        def,
        settingsCtx(exec, {
          variables: { python: { env: { B: "vars", C: "vars", D: "vars" } } },
          extensions: { python: { env: { C: "ext", D: "ext" }, cwd: "/ext/cwd", timeout_ms: 5000 } },
        }),
        "exec",
        { script: "pass", env: { D: "step" } },
      );
      assert.equal(res.success, true);
      const run = calls.find((c) => c.executable.endsWith("/python3"))!;
      assert.equal(run.env?.A, "lib");
      assert.equal(run.env?.B, "vars");
      assert.equal(run.env?.C, "ext");
      assert.equal(run.env?.D, "step");
      assert.equal(run.env?.PATH, "/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin");
      assert.equal(run.cwd, "/ext/cwd");
      assert.equal(run.timeoutMs, 5000);
    } finally {
      resetLibraryWith();
    }
  });

  it("exec takes python-path from settings when the step omits it", () => {
    resetLibraryWith();
    const { calls, exec } = fakeExec(() => ok());
    const res = testStep(
      def,
      settingsCtx(exec, { extensions: { python: { "python-path": "/opt/py/bin/python3" } } }),
      "exec",
      { script: "pass" },
    );
    assert.equal(res.success, true);
    assert.equal(calls[0]!.executable, "/opt/py/bin/python3");
  });

  it("rejects invalid settings blocks", () => {
    resetLibraryWith();
    const { exec } = fakeExec(() => ok());
    for (const settings of [
      { extensions: { python: { bogus: 1 } } },
      { extensions: { python: { env: { A: 1 } } } },
      { extensions: { python: { "python-path": "relative/python" } } },
      { extensions: { python: { "python-version": "3.13" } } },
      { extensions: { python: { release: "latest" } } },
      { extensions: { python: { timeout_ms: -5 } } },
      { variables: { python: "not-an-object" } },
      { variables: { python: { cwd: "/a", "working-directory": "/b" } } },
    ]) {
      assert.throws(
        () => testStep(def, settingsCtx(exec, settings), "exec", { script: "pass" }),
        StepError,
        JSON.stringify(settings),
      );
    }
  });

  it("rejects an invalid library with block at init", () => {
    assert.throws(() => def.init?.({ "install-dir": 42 }), StepError);
    assert.throws(() => def.init?.({ unknown: true }), StepError);
    resetLibraryWith();
  });
});
