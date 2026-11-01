# @perfscale/library-python

Trusted local Python steps for perfscale (RFC 009 `process` capability),
built with [`@perfscale/library-sdk`](../sdk-step-authoring/ts) against
`perfscale:step@0.1.0`. Three steps over the bounded host `exec` import:

- `lib/python/install` — download an official
  [astral-sh/python-build-standalone](https://github.com/astral-sh/python-build-standalone)
  release tarball, verify its SHA-256 against the release's own
  `SHA256SUMS`, and extract it into a local toolcache (idempotent).
- `lib/python/exec` — run an inline script (`python -c`) or a script file
  with a chosen python binary; exit code preserved.
- `lib/python/install-exec` — compose both.

## Security model — read this first

This component exists to run **host processes**. That is powerful and
dangerous on a shared runner, so the engine keeps it fail-closed: the
component only loads when the run grants the capability twice over —
`capabilities: [process]` on the library entry AND
`allow_process_actions: true` + `allow_library_capabilities: true` in the
config. Every spawn is direct argv (no shell) with a replacement
environment — host variables are never inherited.

## Installing and granting the capability

```yaml
# perfscale.config.yaml
allow_library_capabilities: true
allow_process_actions: true
libraries:
  - use: ./python.wasm
    capabilities: [process]
```

## Steps

### `lib/python/install`

`with:` keys (unknown keys are rejected):

- `python-version` (string, **required** unless set via settings) — exact
  full version X.Y.Z (`3.13.18`).
- `release` (string, optional) — python-build-standalone release tag
  (`20261026`); unset resolves the latest release carrying the version.
- `install-dir` (string, optional, default `/tmp/perfscale-toolcache/python`).

Output: `{ "path", "python-path", "version", "release", "stdout", "stderr",
"exit_code" }`. `success` is true only after the installed
`python --version` confirms the install (or the cache).

### `lib/python/exec`

Exactly one of `script` / `file` is required.

`with:` keys (unknown keys are rejected):

- `script` / `file` (string, **exactly one required**)
- `python-path` (absolute path, optional, default `/usr/bin/python3`)
- `args` (array of strings, optional)
- `working-directory` / `cwd` (string, optional alias pair)
- `env` (map of string→string, optional; merges over the default PATH)
- `timeout_ms` / `timeoutMs` (positive number or numeric string, optional)

Output: `{ "exit_code", "stdout", "stderr" }`; `success` is
`exit_code == 0`.

### `lib/python/install-exec`

Install (or reuse the cache), then exec with the installed python — no
`python-path` needed. `with:` is the strict union of the `install` and
`exec` keys (minus `python-path`). Installation failure skips exec.

## Run settings (RFC 009)

Every step knob may be set once for the whole run instead of repeated per
step. Precedence (highest first):

1. the step's explicit `with:` params
2. the `python:` config extension block (claimed via the component's config
   schema — unknown keys fail the run)
3. the `variables.python` map
4. the library entry's `with:` block
5. the built-in defaults

`env` maps merge in that same order (a step's `env` wins per key). Accepted
settings keys: `python-version` (alias `version`), `release`,
`install-dir`, `python-path` (alias `executable`), `working-directory` /
`cwd`, `timeout_ms` / `timeoutMs`, `env`. Invalid blocks (unknown key,
wrong type, relative `python-path`, bad version) are hard errors — at
instantiation for the library `with:`, at step resolution for the rest.

```yaml
python:                       # config extension, validated against the schema
  python-version: 3.13.18
  install-dir: .perfscale-tools/python
variables:
  python: { timeout_ms: 30000 }
libraries:
  - use: ./python.wasm
    capabilities: [process]
    with: { env: { PYTHONDONTWRITEBYTECODE: "1" } }
steps:
  - name: smoke
    use: lib/python/install-exec
    with:
      script: import sys; print(sys.version)
```

## Orchestration, not hot path

Each step invocation is **real host process spawns** (and `install` may
download tens of MB on a cold cache). Use these steps for setup, fixtures,
and one-off environment checks — the one-shot `before:` / `after:` blocks
are the natural home. Do not put `exec` in the per-iteration VU loop of a
high-RPS test.

## Local e2e

```console
$ npm install
$ npm run build        # → python.wasm
$ perfscale run -f examples/python.test.yaml -c examples/python.config.yaml
```

## Development

```console
$ npm install          # file: dependency on the SDK checkout
$ npm test             # unit tests (node:test, fake host exec)
$ npm run typecheck
$ npm run build
```

## License

Dual-licensed under [Apache-2.0](LICENSE-APACHE) or [MIT](LICENSE-MIT), at
your option.
