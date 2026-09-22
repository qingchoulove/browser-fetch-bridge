# Browser Fetch Bridge

API-first local bridge that calls explicitly registered endpoints through an
already logged-in Chrome tab.

```text
agent / skill / shell
  -> browser-fetch-bridge adapter run
  -> Adapter Registry          (schema validation, governance)
  -> one Endpoint Adapter      (one bounded request plan)
  -> internal Core Transport
  -> local daemon              (loopback + token)
  -> Chrome extension          (authenticated fetch)
  -> normalized JSON contract
```

The browser supplies the authenticated session; nothing else needs credentials.
Callers own pagination, polling, batching, aggregation, reporting, and mutation
readback. The project deliberately does not expose DOM automation, click/fill/
eval, a workflow engine, or a public raw-fetch command.

## Repository scope

This repository ships the CLI, the detached daemon, the Chrome extension, and
the adapter runtime.

The `adapters/` tree is intentionally **not** published. Endpoint adapters
encode the request shapes, identity rules, and error envelopes of specific
sites, so they stay local or in a separate private repository. The CLI loads
them from `adapters/index.js` in this checkout, or from the directory named by
`BROWSER_BRIDGE_ADAPTERS_DIR`. Without an adapter tree the bridge still starts,
`doctor` works, and `adapter list` is empty.

## Requirements

- Node.js 18 or newer.
- Chrome 120 or newer, so reconnect alarms can wake a suspended extension
  service worker.

## Install

```bash
npm install
npm link
```

`npm link` installs the executable declared in `package.json`, so commands need
no explicit `node ...` prefix:

```bash
browser-fetch-bridge doctor
browser-fetch-bridge adapter list
```

Configuration comes from the environment:

| Variable | Default | Purpose |
| --- | --- | --- |
| `BROWSER_BRIDGE_HOST` | `127.0.0.1` | Daemon bind host. |
| `BROWSER_BRIDGE_PORT` | `37891` | Daemon port; also names the PID file. |
| `BROWSER_BRIDGE_TOKEN` | `browser-fetch-bridge-dev` | Local daemon token, asserted by the extension hello. |
| `BROWSER_BRIDGE_TIMEOUT_MS` | `30000` | Readiness wait, including daemon startup. |
| `BROWSER_BRIDGE_STATE_DIR` | `~/.browser-fetch-bridge` | PID, log, trace, and mutation-authorization state. |
| `BROWSER_BRIDGE_ADAPTERS_DIR` | `<repo>/adapters` | Adapter tree containing `index.js`. |
| `BROWSER_BRIDGE_AUTOSTART` | `1` | `0` disables first-use daemon startup. |

## Daemon

The CLI starts a detached local daemon on first use, so Docker and a terminal
running `npm start` are not required. PID and logs live under
`~/.browser-fetch-bridge/`.

```bash
browser-fetch-bridge daemon status
browser-fetch-bridge daemon start
browser-fetch-bridge daemon restart
browser-fetch-bridge daemon stop
```

`stop` only terminates a PID recorded by this CLI and confirmed by the live
daemon. `server/Dockerfile` is an optional deployment artifact, not a runtime
dependency.

## Chrome Extension

1. Open `chrome://extensions`.
2. Enable Developer mode.
3. Choose **Load unpacked** and select this repository's `extension/` folder.
4. After upgrading, click **Reload** once to activate the updated extension
   code.
5. Verify:

```bash
browser-fetch-bridge doctor
```

`doctor` waits for the extension connection and `hello`, then checks daemon
connectivity, protocol version, and advertised capabilities. The v2 extension
advertises `fetch.text`, `fetch.json`, `fetch.base64`, and
`fetch.started-ack`. `status` and `daemon status` are immediate snapshots and do
not wait.

### Automatic connection recovery

The extension retries every 1.5 seconds after a disconnect, and a 30-second
Chrome alarm wakes a suspended MV3 worker. Connection attempts stuck in
`CONNECTING` are retired after 10 seconds, and heartbeat failures also trigger
recovery. Old socket callbacks cannot disturb a recovered connection, and a
successful connection cancels pending reconnect work.

Recovery applies only before dispatch. It never replays a request, never
consumes mutation authorization while waiting, and never reloads the extension
or launches Chrome. A live adapter reports `extension_disconnected` or
`extension_not_ready` instead of treating a missing connection as a missing
capability. If Chrome is closed or the extension is disabled, open Chrome or
enable the extension; the popup's reconnect button stays available for an
explicit reset.

## Adapter CLI

Discover registered contracts:

```bash
browser-fetch-bridge adapter list --prefix example.
browser-fetch-bridge adapter describe example.item-read
browser-fetch-bridge adapter schema example.item-read
```

Run a read:

```bash
browser-fetch-bridge adapter run example.item-read --input '{"id":115}'
```

Use `--input-file <path>` instead of `--input` when appropriate.

Output controls keep large responses out of the terminal:

- `--select` projects dot paths with `[*]` array mapping and fails when a path
  does not match.
- `--summary-only` reports only the normalized envelope and data shape.
- `--compact` emits compact JSON.
- `--output-file` atomically saves the complete normalized result and prints
  only the absolute path, SHA-256, and byte count. The output path must differ
  from `--input-file`.

```bash
browser-fetch-bridge adapter run example.item-read \
  --input-file request.json \
  --select data.items[*].id
```

With `--output-file` the file always contains the complete result; terminal
projection flags do not change the saved artifact. When combined, `--select`
projects first and `--summary-only` summarizes that projection.

Every adapter returns normalized data with `source`, `observedAt`, `requestId`,
`dispatchState`, and `meta.attempts`. Collection data carries effective `scope`,
`returnedCount`, and either proven pagination or `completeness: "unknown"`;
opaque upstream evidence stays under adapter-defined `raw` fields.

### Mutations

Mutations prepare an exact request without dispatching. Apply requires the
single-use authorization produced by that preparation:

```bash
browser-fetch-bridge adapter run example.item-approve --input '{"id":9918059}'

browser-fetch-bridge adapter run example.item-approve --input '{"id":9918059}' \
  --apply \
  --preparation-token PREPARATION_TOKEN
```

Add `--request-summary` to a dry-run for a concise `method`, `url`, and `body`
view. Every dry-run returns `preparationToken`, `expiresAt`, and `planDigest`.
Review the exact request, then apply the same canonical input and generated plan
within 15 minutes.

The token is bearer authorization from the caller, not evidence that a human
approved the plan. It is consumed atomically before dispatch and is never
restored after a transport failure or an unknown result. Expired, unknown,
consumed, or input/plan-mismatched tokens are rejected. Multi-operation callers
must save prepared plans in owner-only (`0600`) files, review them, and apply
those saved inputs and tokens; they must not prepare and immediately apply in
one unattended step.

An accepted acknowledgement is not proof that the desired state was applied.
Read the exact target independently after every mutation. For `result_unknown`,
do not retry with the consumed token: read back first, then prepare a new
caller-reviewed mutation only if the intended state is absent.

## Writing Adapters

Register a CommonJS module in `adapters/index.js`. Each adapter declares:

- `name` (lowercase, dot-namespaced), `description`, `effect: "read"|"mutation"`;
- `agentStandard: true` plus risk booleans `readOnly`, `destructive`,
  `idempotent`, `openWorld`, where `readOnly` must match `effect: "read"`;
- `retry: "never"` and the extension capabilities it `requires`;
- closed input and output JSON Schemas (`type: "object"` with
  `additionalProperties: false`);
- `buildRequest(input)` returning one bounded request plan with an absolute
  HTTP(S) `tabUrl`, an absolute same-origin request URL, explicit method and
  response type, and `timeoutMs`;
- `parseResponse(response, input)` validating upstream evidence and returning
  decision-ready data plus its effective scope.

The Registry rejects ungoverned modules, inconsistent risk metadata, automatic
retry policies, cross-origin targets, and embedded URL credentials. One
invocation dispatches at most one HTTP request; callers may explicitly invoke a
failed read again. Request plans bind a tab through `tabUrl`, and the extension
derives the origin match from that URL.

## Protocol And Dispatch Evidence

The latest extension connection replaces the previous one. The daemon records
extension `instanceId`, extension version, protocol version, and capabilities.
Before executing the injected fetch, the extension sends a `started` ACK.
Dispatch states are `not_dispatched`, `dispatched_unacknowledged`, `started`,
and `completed`. Reads and mutations never retry automatically, including
inside the daemon transport.

Trace is off by default:

```bash
browser-fetch-bridge adapter run example.item-read --input '{"id":1}' \
  --trace retain-on-failure
```

Modes are `off`, `retain-on-failure`, and `retain-all`. Files are written under
`~/.browser-fetch-bridge/traces/`; the directory is mode `0700` and files are
mode `0600`. Trace output is intentionally raw and unredacted: it can contain
credentials, signed URLs, personal data, request bodies, and response bodies.
Enable it only for a specific diagnostic need.

## Security Boundary

- The daemon listens only on loopback and requires a local token.
- Chrome host permission is broad because registered adapters target multiple
  authenticated sites.
- The extension exposes only a fixed fetch action, not arbitrary JavaScript.
- Callers cannot supply arbitrary URLs; only registered adapters construct
  requests.
- The daemon's `POST /fetch` route is Core Transport, reached only by
  `lib/adapter-runtime.js`, not by a public CLI command.
- The most recently connected Chrome profile wins.

## Tests

```bash
npm test
```

Node's built-in test runner covers the CLI surface, adapter registry
governance, daemon transport, and the extension's connection state machine.
Tests that drive a local adapter tree are local-only and not published.

## Design Docs

- `docs/design/agent-tool-standard.md` defines the tool contract adapters must
  meet to be safely exposed to an agent.
