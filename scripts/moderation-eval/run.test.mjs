import test from "node:test";
import assert from "node:assert/strict";
import { runEvaluation } from "./run.mjs";
const rows = [
  {
    id: "dev-one",
    source: "synthetic only",
    expected: { verdict: "needs_review" },
    reviews: [{ reviewerId: "secret-label" }],
  },
];

// A runner leaking expected labels into the driver must fail this test.
test("driver receives only source and authoritative policy and returns measured status", async () => {
  const driver = `let s='';process.stdin.on('data',x=>s+=x);process.stdin.on('end',()=>{const v=JSON.parse(s);if(Object.keys(v).sort().join(',')!=='id,policy,source'||v.policy.rules.length!==6||v.source!=='synthetic only')process.exit(2);process.stdout.write(JSON.stringify({status:'completion',raw:'{"verdict":"no_match","matches":[],"uncertainty":null}',promptTokens:12,completionTokens:9}));});`;
  const [result] = await runEvaluation(rows, [process.execPath, "-e", driver]);
  assert.equal(result.id, "dev-one");
  assert.equal(result.status, "completion");
  assert.equal(result.promptTokens, 12);
  assert.ok(result.elapsedMs >= 0);
});

test("driver failures never leak diagnostic stderr or become no_match", async () => {
  const [result] = await runEvaluation(rows, [
    process.execPath,
    "-e",
    `process.stderr.write('SOURCE_CANARY');process.exit(2)`,
  ]);
  assert.equal(result.status, "error");
  assert.equal(result.code, "driver_failed");
  assert.ok(!JSON.stringify(result).includes("SOURCE_CANARY"));
});

test("driver cannot replace example identity or silently supply malformed result", async () => {
  for (const text of [
    "bad json",
    '{"id":"wrong","status":"completion","raw":"anything"}',
    '{"status":"no_match"}',
  ]) {
    const [result] = await runEvaluation(rows, [
      process.execPath,
      "-e",
      `process.stdout.write(${JSON.stringify(text)})`,
    ]);
    assert.equal(result.id, "dev-one");
    assert.equal(result.status, "error");
    assert.equal(result.code, "invalid_driver_response");
  }
});

test("a killed driver leaves later cases missing and termination unconfirmed", async () => {
  const results = await runEvaluation(
    [...rows, { ...rows[0], id: "dev-two" }],
    [process.execPath, "-e", "setTimeout(()=>{},1000)"],
    { timeoutMs: 30 },
  );
  assert.equal(results.length, 1);
  assert.equal(results[0].status, "error");
  assert.equal(results[0].code, "driver_timeout");
  assert.equal(results[0].terminationConfirmed, false);
});

test("overflowing driver output also stops admission of more examples", async () => {
  const results = await runEvaluation(
    [...rows, { ...rows[0], id: "dev-two" }],
    [process.execPath, "-e", `process.stdout.write('x'.repeat(100000))`],
  );
  assert.equal(results.length, 1);
  assert.equal(results[0].code, "driver_output_limit");
  assert.equal(results[0].terminationConfirmed, false);
});

test("a driver ignoring SIGTERM is killed within the timeout bound", async () => {
  const { mkdtempSync, readFileSync, existsSync, rmSync } = await import(
    "node:fs"
  );
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const root = mkdtempSync(join(tmpdir(), "buzz-driver-kill-"));
  const ready = join(root, "ready");
  const terminated = join(root, "sigterm");
  try {
    const driver = `const fs=require('node:fs');process.on('SIGTERM',()=>fs.writeFileSync(${JSON.stringify(terminated)},'ignored'));fs.writeFileSync(${JSON.stringify(ready)},String(process.pid));setTimeout(()=>process.exit(0),2000);`;
    const results = await runEvaluation(
      [...rows, { ...rows[0], id: "dev-two" }],
      [process.execPath, "-e", driver],
      { timeoutMs: 200 },
    );
    assert.ok(
      existsSync(ready),
      "driver registered its SIGTERM handler before the deadline",
    );
    assert.ok(
      results[0].elapsedMs < 1000,
      "runner must not wait for the SIGTERM-ignoring driver to exit itself",
    );
    assert.equal(results.length, 1);
    assert.equal(results[0].code, "driver_timeout");
    assert.equal(
      results[0].terminationConfirmed,
      false,
      "detached backend termination is unproven",
    );
    assert.equal(existsSync(terminated), false);
    const pid = Number(readFileSync(ready, "utf8"));
    assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
