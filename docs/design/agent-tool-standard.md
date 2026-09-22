# Agent Tool Standard

## Purpose

This document defines the minimum contract for exposing Browser Fetch Bridge
capabilities to an Agent. The goal is not to make every endpoint generic. The
goal is to make every tool easy to select, hard to misuse, observable after
execution, and safe to retry only when retry is actually valid.

The existing architecture remains unchanged:

```text
Agent
  -> Skill or planner
  -> registered Endpoint Adapter
  -> Adapter Registry
  -> authenticated browser transport
```

One adapter invocation performs at most one HTTP request. Skills own
pagination, polling, batching, aggregation, reporting, and mutation readback.

The words MUST, MUST NOT, SHOULD, SHOULD NOT, and MAY are normative.

## 1. Tool Identity And Selection

- A tool MUST have a stable, unique, action-oriented name such as
  `orders.order-search` or `reports.job-stop`.
- Its description MUST state the exact operation, target scope, and important
  exclusion. Avoid generic descriptions such as "query data" or "update item".
- Similar tools MUST use consistent parameter names and units.
- Read and mutation behavior MUST be separate when their authorization or
  retry semantics differ.
- A tool SHOULD expose risk metadata equivalent to `readOnly`, `destructive`,
  `idempotent`, and `openWorld`. These are discovery hints; the runtime MUST
  enforce the real policy independently.

## 2. Input Contract

- The root input MUST be a JSON object with `additionalProperties: false`.
- Every property MUST have a meaningful `description` when its name alone does
  not fully define semantics, units, allowed source, or format.
- Required fields MUST be listed explicitly.
- IDs MUST state their entity type and representation. Do not use a bare `id`
  when several domain IDs exist.
- Time values MUST state unit and timezone. Prefer explicit caller-supplied
  ranges over hidden `now` calculations.
- Finite domains MUST use `enum`, `const`, `pattern`, or numeric bounds.
- Arrays and strings MUST have practical size limits at external boundaries.
- Mutations MUST NOT accept an unconstrained object when the allowed writable
  fields are known.
- Mutually exclusive inputs MUST be represented and validated in the schema.
- Defaults MAY be used only when they are stable and visible in the schema or
  result. A default that changes request scope MUST be returned as effective
  scope.

## 3. Deterministic Request Construction

- The same validated input SHOULD produce the same request plan.
- All material request scope MUST come from input or a versioned tool
  configuration. Hidden wall-clock time, ambient locale, implicit region, or
  caller identity MUST NOT silently change the business query.
- The normalized result MUST return the effective scope actually used,
  including time range, page, page size, filters, region, and target identity.
- Dynamic values that cannot be avoided MUST be materialized once and included
  in the dry-run plan and result.
- Request construction MUST reject impossible combinations before dispatch.

## 4. Side Effects And Authorization

- Every tool MUST declare `effect: read|mutation`.
- Mutations MUST default to dry-run and MUST require an explicit apply action.
- A dry-run MUST expose the exact method, URL, target identity, and body that
  would be dispatched, excluding secrets that are injected only by transport.
- Apply SHOULD be bound to the reviewed plan using a digest or opaque
  preparation token. If binding is not implemented, the caller MUST preserve
  identical input, re-resolve target scope immediately before apply, and record
  that this is a weaker guarantee.
- A mutation MUST execute at most once per authorization unless the endpoint
  has a proven idempotency mechanism.
- Mutations MUST use `retry: never` unless an endpoint-supported idempotency key
  makes automatic retry safe.
- Successful dispatch is not proof of the desired state. A Skill MUST perform
  independent readback when a read API exists.
- A mutation result MUST distinguish `accepted`, `applied`, `verified`, and
  `result_unknown`; it MUST NOT claim a state transition that was not observed.

### Browser Fetch Bridge governed profile

Browser Fetch Bridge enforces plan-bound authorization for every registered
mutation adapter. All namespaces use the governed contract; there is no legacy
authorization or retry exemption. A mutation dry-run through
`registry.run(name, input)` returns the exact request with
`preparationToken`, `expiresAt`, `planDigest`, `requestId`, and
`dispatchState: "not_dispatched"`. Apply uses the same input and runtime options
`{ apply: true, preparationToken }`; the CLI uses
`--apply --preparation-token TOKEN`.

The opaque bearer token expires after 15 minutes and binds the adapter name,
canonical input, and complete generated request plan. It is single-use across
processes, consumed atomically before dispatch, and never restored after a
crash, transport failure, or uncertain result. It proves caller authorization,
not human approval. A caller must preserve a reviewed prepared plan rather than
dry-run and immediately auto-apply an unattended batch. After an accepted or
`result_unknown` mutation, independently read the exact target. If the desired
state is absent, create and review a new dry-run; never retry the consumed
authorization.

All registered adapters use `retry: never` so the one-request
boundary is literal. A caller may explicitly invoke a failed read again after
considering its error evidence; the runtime performs no hidden read retry.

## 5. Execution And Dispatch Evidence

- The runtime MUST validate input before building or dispatching a request.
- The runtime MUST validate the generated request plan.
- Required transport capabilities MUST be checked before dispatch.
- Each invocation MUST have an opaque request ID and each attempt MUST have a
  distinct attempt ID.
- Dispatch state MUST distinguish at least:
  `not_dispatched`, `dispatched_unacknowledged`, `started`, and `completed`.
- Tool timeouts MUST be bounded and documented.
- Read retries MUST be limited to errors that are both transient and safe to
  repeat. Business errors and schema errors MUST NOT be retried automatically.
- Request IDs used in filesystem paths MUST be generated internally or
  validated as a single safe filename component.

## 6. Output And Evidence Contract

- The normalized output MUST have a closed, validated schema for fields the
  Agent is expected to reason over.
- Opaque upstream payloads MAY be preserved under a clearly named `raw` field,
  but they MUST NOT replace normalized decision fields.
- A collection result MUST return pagination evidence when available:
  `page`, `pageSize`, `returnedCount`, and one of `total`, `hasMore`,
  `nextCursor`, or `completeness: unknown`.
- An empty collection MUST retain enough effective scope to distinguish "no
  matching rows" from "the relevant time/page/scope was not queried".
- Mutation output MUST include the exact target identity and the endpoint's
  actual acknowledgement evidence.
- Results used as evidence SHOULD include source system, request ID, effective
  query scope, observation time, and any upstream trace ID.
- Output size MUST be bounded or support file output/projection so a large
  result does not consume the Agent context accidentally.

## 7. Error Contract

- Errors MUST be structured and machine-distinguishable.
- At minimum, distinguish input validation, request construction, capability,
  transport, HTTP, upstream business, response parsing, output validation, and
  ambiguous mutation errors.
- Errors MUST preserve request ID, dispatch state, attempt history, and safe
  upstream status details when known.
- Authentication or browser-permission failure MUST NOT be normalized as an
  empty business result.
- Broad catches, silent defaults, and fabricated success values are forbidden.

Across all namespaces, authorization failures use
`authorization_required`, `authorization_unknown`, `authorization_expired`,
`authorization_mismatch`, or `authorization_consumed`. Adapter business
rejections use `upstream_business_error`; malformed or unrecognized upstream
responses use `response_parse_failed`. Runtime failures retain `adapter`,
`requestId`, `dispatchState`, and attempt evidence when available. A mutation
failure after possible dispatch reports `mutationStatus: "result_unknown"` and
`retryable: false`, except a positively parsed upstream business rejection.

## 8. Security And Data Handling

- The Agent MUST be able to call only explicitly registered tools; raw fetch,
  arbitrary JavaScript, shell, SQL, or code execution require a separate,
  explicitly guarded tool class.
- Authorization MUST be enforced before execution, not inferred from model
  reasoning or tool annotations.
- Read tools SHOULD default to least privilege and mutations SHOULD require
  target-specific approval.
- Secrets MUST NOT appear in normal results. Diagnostic traces MUST be opt-in,
  access-restricted, and clearly marked as potentially sensitive.
- Untrusted tool output MUST be treated as data, not as instructions.

## 9. Knowledge Tools

Knowledge retrieval MAY be exposed as tools and should follow the same
contract. A knowledge tool additionally MUST:

- identify the searched corpus or data source;
- accept explicit query and scope inputs;
- return stable source identifiers and retrievable locations;
- return chunk boundaries or excerpts with provenance;
- state truncation, ranking, and coverage limits;
- distinguish no match from unavailable source or failed retrieval;
- keep writes to the knowledge base in a separate mutation tool.

Static policy that applies to every run belongs in the system/developer prompt.
Large, changing, or task-specific knowledge belongs behind retrieval tools and
is injected only when selected.

## 10. Agent Loop Integration

Normal endpoint tools MUST be declared through the model API's native tool
schema. Do not generate template code and execute it merely to call a normal
adapter. Code generation is appropriate only for an explicit code-execution
tool with its own sandbox and authorization boundary.

The minimum loop is:

1. Assemble stable policy, current conversation/state, relevant retrieved
   knowledge, available tool schemas, and the latest tool results.
2. Call the model.
3. If the model returns tool calls, validate and authorize each call.
4. Execute independent read calls in parallel; serialize dependent calls and
   mutations.
5. Append each tool call and its result using the matching call ID.
6. Call the model again until it returns a final answer or a bounded stop
   condition is reached.

Every step does not require copying the entire historical transcript. The
runtime MAY compact or summarize old conversation, but MUST retain current
goals, unresolved decisions, tool call/result pairs needed for causality, and
authoritative evidence references.

## 11. Acceptance Checklist

A new adapter is Agent-ready only when all answers are yes:

- Is the name and description sufficient to select the correct tool?
- Is the input closed, documented, bounded, and unambiguous?
- Is the effective request scope explicit and replayable?
- Is read/mutation effect declared and runtime-enforced?
- Are retry and ambiguous-dispatch semantics correct?
- Does the output schema validate the fields the Agent relies on?
- Can the result prove its pagination or coverage limits?
- Does an empty result remain interpretable?
- Does a mutation avoid claiming unverified success?
- Are errors structured without being converted into empty data?
- Are large responses bounded or projectable?
- Do tests fail when any of these business guarantees regress?

## References

- Model Context Protocol schema reference:
  https://modelcontextprotocol.io/specification/2025-11-25/schema
- OpenAI model and tool-calling guidance:
  https://developers.openai.com/api/docs/guides/latest-model
- JSON Schema metadata guidance:
  https://json-schema.org/understanding-json-schema/reference/metadata
