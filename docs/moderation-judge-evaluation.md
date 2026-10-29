# Moderation judge evaluation

The bundled corpus is synthetic development data. Its labels were proposed by an agent and have no human adjudication. It covers English only and makes no quality or language-support claim. The tiny Qwen model used for the native smoke is a runtime test asset, not a recommended moderation model.

## Run the tooling

From the repository root, run the focused tooling tests:

```sh
. ./bin/activate-hermit
node --test scripts/moderation-eval/*.test.mjs
```

The 24 development examples in `scripts/moderation-eval/fixtures/development.jsonl` cover the six rules, benign near matches, quotes and counterspeech, profanity, defensive code, uncertain context, and prompt injection. Names, credentials and domains are fictional. Keep generated predictions and reports under `.scratch/`, which is ignored by Git.

A model driver is an explicitly selected local executable. The runner starts one process at a time, does not use a shell, and does not retry. A driver receives one JSON object on stdin with exactly `id`, `source` and the authoritative shared `policy`. Expected labels and reviewer records are excluded. It returns one JSON object on stdout:

```json
{"status":"completion","raw":"{\"verdict\":\"no_match\",\"matches\":[],\"uncertainty\":null}","promptTokens":123,"completionTokens":17}
```

Other driver outcomes are `{"status":"refusal"}` and `{"status":"error","code":"invalid_response"}`. Error codes accepted without replacement are `invalid_response`, `cancelled`, `timeout`, `unavailable` and `unsupported`. Optional resource fields are `maxRssMb`, `promptTokens` and `completionTokens`. They must be measured nonnegative numbers. The runner measures process latency, including driver startup. It suppresses driver stderr and rejects extra result fields, including an attempted replacement `id`.

Use only a driver that calls the typed local-only SDK path. No ordinary OpenAI ingress or remote endpoint is supplied by this tooling. The native test below is the supplied integration harness for that path. A custom executable still requires independent routing, capture and cancellation verification.

```sh
mkdir -p .scratch/moderation-eval
node scripts/moderation-eval/run.mjs \
  scripts/moderation-eval/fixtures/development.jsonl -- \
  /absolute/path/to/verified-local-driver \
  > .scratch/moderation-eval/development-predictions.jsonl
node scripts/moderation-eval/score.mjs \
  scripts/moderation-eval/fixtures/development.jsonl \
  .scratch/moderation-eval/development-predictions.jsonl \
  > .scratch/moderation-eval/development-score.json
```

A driver timeout stops the run after 65 seconds and sets `terminationConfirmed:false`. Killing a process does not establish that a detached backend stopped. Resolve the backend before restarting. Remaining examples stay missing in the score.

The scorer validates raw completions using the native result contract, including exact fields, literal evidence, duplicate rules and Unicode character limits. Invalid output becomes a schema failure. The native `invalid_response` error also counts as a schema failure because native code intentionally withholds the raw output. Such a code can include a disallowed finish reason, so its count is broader than JSON syntax failures alone. Separate `refusal`, backend-error and missing rates remain visible. A driver must report structured refusal metadata as a refusal before discarding it.

Every rate includes numerator, denominator and a 95% Wilson interval. Empty denominators return null. Per-rule precision uses flagged examples, and recall uses labeled positives. Failed or missing predictions count as misses on positive rules. Benign false positives count any validated rule match, including a match attached to `uncertain`. Confusion-matrix `tn` means a rule was not flagged on a labeled negative; it does not turn a missing or failed prediction into a validated `no_match`. The schema-valid rate uses all examples as its denominator. Results are also split by language and category. Categories can overlap.

Latency reports sample count, minimum, median, p95, maximum and mean. Resource values are optional and missing measurements remain explicit with zero samples and null statistics. Severe recall counts labeled severe rule occurrences, so an example with two severe rules contributes twice. No resource values are inferred from a model name.

## Prepare a held-out evaluation

Create at least 200 distinct synthetic or consented and de-identified examples that have never been used for prompt/model selection. Preserve the development corpus separately. Two human reviewers must label each example independently before seeing the model result or each other's label. Record their actual reviewer IDs, labels and independence declarations. `reviews` must contain two distinct human reviewers with `reviewerId`, `human:true`, `independent:true`, `verdict` and `ruleIds`. Do not copy agent labels into reviewer records.

Use the development record schema with `split:"heldout"`, `language`, category `tags`, `source`, and `expected:{verdict,ruleIds,severeRuleIds}`. Document disagreements in `adjudication:{reviewerId,human:true,rationale,verdict,ruleIds}` after both independent reviews. The final expected label must match the agreement or the documented adjudication. Agree the severe labels with the human reviewers as part of the evaluation protocol.

Include all six rules and every difficult category listed above. Include every claimed language. The scorer checks source and ID overlap against the supplied development corpus, but humans must also check paraphrases, shared templates and prior exposure. Self-reported review fields cannot verify a person's identity or independence.

A run manifest supplies `claimedLanguages` and `run` fields `modelId`, `runtimeVersion`, `policyDigest`, `promptVersion` and `platform`. Record the actual weight digest when known, runtime settings, hardware and capture/routing evidence alongside the manifest. Do not invent a digest. For example, use the exact values measured during the run instead of copying a model catalog label.

```sh
node scripts/moderation-eval/score.mjs \
  .scratch/moderation-eval/heldout.jsonl \
  .scratch/moderation-eval/heldout-predictions.jsonl \
  scripts/moderation-eval/fixtures/development.jsonl \
  .scratch/moderation-eval/run-manifest.json \
  > .scratch/moderation-eval/heldout-score.json
```

`qualification.qualified` requires 200 held-out examples, complete independent human labels, documented disagreement resolution, development separation, category/rule/language coverage, run metadata and complete latency data. It also applies conservative bounds to the issue's proposed targets: benign FPR upper 95% bound at most 5%, severe recall lower bound at least 90%, and schema validity lower bound at least 99%. The targets remain proposals rather than an approved product recommendation. Even 200 perfect schema results do not establish the 99% lower bound. A qualification result is evidence for human review, and does not enable a model in the application.

No held-out corpus, human judgments, model evaluation predictions or measured quality results are bundled with this change.

## Run the native smoke

The ignored `mesh_llm::live_tests::isolated_relay_and_real_local_model` test starts an actual embedded serving runtime with an explicit local GGUF and a new owner key inside its scratch directory. It then constructs the desktop runtime wrapper around that handle. The judge service, authenticated relay reads, production local-only adapter, SDK submission, parsing, final checks, cancellation and admission guard run as production code. The test does not exercise the desktop startup UI or its default owner identity path.

Prepare a separate local relay with its own database, Redis and synthetic owners/members. Never point the fixture at an existing workspace. Seed an open eligible kind-9 report in an explicitly open stream/forum channel. A synthetic report note should contain `REPORTER_NOTE_CANARY` and the source text must be unique. Save the fixture outside the smoke runtime root, with mode 0600 and these fields:

```text
relayUrl, channelId, reportEventId, sourceEventId,
ownerPrivateKey, ownerPubkey, memberPrivateKey
```

The fixture is read only and must never be committed. The main report stays open throughout this test. The test rejects non-loopback relay hosts and requires dedicated non-default Mesh HTTP/console ports.

Create a fresh empty scratch root before each run, and set these process environment variables to absolute paths:

| Variable | Value |
| --- | --- |
| `BUZZ_JUDGE_LIVE_ROOT` | New empty scratch directory |
| `BUZZ_JUDGE_LIVE_FIXTURE` | Synthetic relay fixture outside the root |
| `BUZZ_JUDGE_LIVE_MODEL` | Explicit local GGUF file |
| `BUZZ_MESH_API_PORT`, `BUZZ_MESH_CONSOLE_PORT` | Unused dedicated ports, such as 19335 and 19336 |
| `MESH_LLM_DATA_DIR` | Scratch root plus `/data` |
| `MESH_LLM_RUNTIME_ROOT` | Scratch root plus `/runtime` |
| `MESH_LLM_TEST_HOME` | Scratch root plus `/identity` |
| `HF_HOME`, `HF_HUB_CACHE` | Scratch root plus `/hf` and `/hf/hub` |
| `MESH_LLM_NATIVE_RUNTIME_CACHE_DIR` | Scratch root plus `/native-cache` |
| `MESH_LLM_NATIVE_RUNTIME_BUNDLE_DIR` | Verified compatible extracted native runtime bundle |

Keep `MESH_LLM_SWARM_CAPTURE` unset or empty. The test supplies an isolated configuration, disables public discovery and Iroh relays, and uses an explicit owner allowlist. It does not change `HOME` or another runtime's settings. Only synthetic text should be used. Acquire the shared Cargo slot before running:

```sh
. ./bin/activate-hermit
cargo test --manifest-path desktop/src-tauri/Cargo.toml --features mesh-llm \
  --lib mesh_llm::live_tests::isolated_relay_and_real_local_model -- \
  --ignored --exact --nocapture --test-threads=1
```

Expected output identifies either `schema_valid` or `safe_invalid_response`, the actual local model ID, Mesh version, platform, policy/prompt versions and measured latency. The tiny smoke model may fail the result schema. A safe rejection proves the error path was exercised, and makes no statement about moderation quality. Other errors fail the test.

The second operation cancels after the adapter is entered and waits for the adapter to return and the admission guard to clear. If the model finishes before cancellation, the test fails with an explicit race message. A member request must return `inaccessible` without another model lease. The test then shuts down the runtime and scans its isolated files for source and reporter-note canaries. It omits raw prompts, source text, completion text and keys from its own output.

The file scan detects plaintext canary persistence within the configured runtime directories. It does not establish absence of token-ID persistence, unconfigured external paths or remote traffic. The SDK's production routing/capture/cancellation tests and an independent review remain required. No peers are introduced by this smoke, so routing exclusion under available remote peers is a separate deterministic runtime test. Full desktop UI checks and explicit human testing remain separate gates.
