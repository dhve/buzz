import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { readJsonl } from "./score.mjs";
const policy = JSON.parse(
  readFileSync(
    new URL(
      "../../desktop/src/shared/moderation/defaultGuidelines.json",
      import.meta.url,
    ),
    "utf8",
  ),
);

// Explicit development-only subprocess driver; no network or ordinary mesh ingress.
// No retry. A killed driver is NOT proof that a detached backend terminated.
export async function runEvaluation(rows, command, { timeoutMs = 65000 } = {}) {
  if (
    !Array.isArray(command) ||
    !command.length ||
    command.some((arg) => typeof arg !== "string")
  )
    throw new Error("explicit_local_driver_required");
  const results = [];
  for (const row of rows) {
    const started = performance.now();
    const child = spawnSync(command[0], command.slice(1), {
      input: JSON.stringify({ id: row.id, source: row.source, policy }),
      encoding: "utf8",
      timeout: timeoutMs,
      // SIGTERM is catchable: spawnSync can otherwise wait indefinitely.
      // Killing this driver still says nothing about a detached backend.
      killSignal: "SIGKILL",
      maxBuffer: 65536,
      shell: false,
    });
    const elapsedMs = performance.now() - started;
    const failure = (code) => ({
      id: row.id,
      status: "error",
      code,
      elapsedMs,
    });
    if (["ETIMEDOUT", "ENOBUFS"].includes(child.error?.code)) {
      results.push({
        ...failure(
          child.error.code === "ETIMEDOUT"
            ? "driver_timeout"
            : "driver_output_limit",
        ),
        terminationConfirmed: false,
      });
      break; // Keep remaining predictions absent; never accumulate unresolved work.
    }
    if (child.error || child.status !== 0) {
      results.push(failure("driver_failed"));
      continue;
    }
    let value;
    try {
      value = JSON.parse(child.stdout);
    } catch {
      results.push(failure("invalid_driver_response"));
      continue;
    }
    const allowed = [
      "status",
      "raw",
      "code",
      "maxRssMb",
      "promptTokens",
      "completionTokens",
    ];
    if (
      !value ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      Object.keys(value).some((key) => !allowed.includes(key)) ||
      !["completion", "refusal", "error"].includes(value.status) ||
      (value.status === "completion" && typeof value.raw !== "string") ||
      ["maxRssMb", "promptTokens", "completionTokens"].some(
        (key) =>
          value[key] !== undefined &&
          (!Number.isFinite(value[key]) || value[key] < 0),
      )
    ) {
      results.push(failure("invalid_driver_response"));
      continue;
    }
    const result = { id: row.id, status: value.status, elapsedMs };
    if (value.status === "completion") result.raw = value.raw;
    if (value.status === "error")
      result.code = [
        "invalid_response",
        "cancelled",
        "timeout",
        "unavailable",
        "unsupported",
      ].includes(value.code)
        ? value.code
        : "backend_error";
    for (const key of ["maxRssMb", "promptTokens", "completionTokens"])
      if (value[key] !== undefined) result[key] = value[key];
    results.push(result);
  }
  return results;
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    const [dataset, separator, ...command] = process.argv.slice(2);
    if (!dataset || separator !== "--" || !command.length)
      throw new Error(
        "usage: node scripts/moderation-eval/run.mjs DATASET.jsonl -- LOCAL_DRIVER [ARG ...]",
      );
    const results = await runEvaluation(readJsonl(dataset), command);
    for (const result of results)
      process.stdout.write(`${JSON.stringify(result)}\n`);
    if (results.some((result) => result.terminationConfirmed === false))
      process.exitCode = 2;
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
