"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const test = require("node:test");
const { createExecutionStore } = require("./execution-store");
const { assertSupabaseSuccess, SupabaseOperationError } = require("./supabase-assert");

function identity(overrides = {}) {
  return {
    request_key: "helios-request-a",
    tenant_id: "democoi1",
    account_id: "2",
    clinic_id: "coi_demo",
    hermes_profile: "helios",
    conversation_id: "42",
    contact_id: "9",
    source_message_ids_hash: "source-hash",
    ...overrides
  };
}

test("18/30 concurrent Adapter calls execute Hermes only once", async () => {
  const store = createExecutionStore({ leaseMs: 60000 });
  const [a, b] = await Promise.all([store.claim(identity()), store.claim(identity())]);
  assert.deepEqual([a.action, b.action].sort(), ["execute", "waiting"]);
});

test("19/30 completed execution is returned as a durable deduplication result", async () => {
  const store = createExecutionStore();
  await store.claim(identity());
  await store.complete(identity().request_key, {
    hermes_conversation_id: "conversation-a",
    hermes_response_id: "response-a",
    normalized_result: { ok: true, message_for_client: "safe result" },
    token_usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
    tool_calls: [{ name: "hubspot_contacts" }],
    duration_ms: 20
  });
  const duplicate = await store.claim(identity());
  assert.equal(duplicate.action, "completed");
  assert.equal(duplicate.execution.hermes_response_id, "response-a");
  assert.equal(duplicate.execution.normalized_result.message_for_client, "safe result");
});

test("20/30 a failed final execution never invokes Hermes automatically", async () => {
  const store = createExecutionStore();
  await store.claim(identity());
  await store.fail(identity().request_key, "FINAL", false);
  assert.equal((await store.claim(identity())).action, "failed_final");
});

test("21/30 a recoverable execution can be reclaimed under policy", async () => {
  const store = createExecutionStore();
  await store.claim(identity());
  await store.fail(identity().request_key, "TEMPORARY", true);
  assert.equal((await store.claim(identity())).action, "execute");
});

test("22/30 an expired execution lease can be reclaimed", async () => {
  const store = createExecutionStore({ leaseMs: -1 });
  assert.equal((await store.claim(identity())).action, "execute");
  assert.equal((await store.claim(identity())).action, "execute");
});

test("23/30 Supabase error objects are never treated as success", () => {
  assert.throws(
    () => assertSupabaseSuccess({ error: { status: 503, message: "network" } }, "adapter.test"),
    error => error instanceof SupabaseOperationError && error.code === "SUPABASE_NETWORK"
  );
});

test("24-26/30 execution SQL is atomic, leased, and final-state aware", () => {
  const sql = fs.readFileSync(
    "./supabase/migrations/20260727123000_durable_adapter_execution.sql",
    "utf8"
  );
  assert.match(sql, /GET DIAGNOSTICS inserted_count = ROW_COUNT/);
  assert.match(sql, /FOR UPDATE/);
  assert.match(sql, /failed_final/);
});

test("27-28/30 telemetry schema stores Agent API IDs, tokens, and completion", () => {
  const sql = fs.readFileSync(
    "./supabase/migrations/20260727124000_adapter_events_agent_api.sql",
    "utf8"
  );
  assert.match(sql, /hermes_conversation_id/);
  assert.match(sql, /hermes_response_id/);
  assert.match(sql, /completed_at/);
  assert.match(sql, /tool_count/);
});

test("29/30 historical reconciliation cannot send or execute", () => {
  const sql = fs.readFileSync(
    "./supabase/migrations/20260727131000_adapter_event_reconciliation.sql",
    "utf8"
  );
  assert.doesNotMatch(sql, /chatwoot|v1\/responses|send_message/i);
  assert.match(sql, /historical_unknown/);
});

test("30/30 dashboard has no fixed STREAM_API or legacy Session/Stream labels", () => {
  const source = fs.readFileSync("./server.js", "utf8");
  const dashboardStart = source.lastIndexOf("<!DOCTYPE html>");
  const dashboard = source.slice(dashboardStart, source.indexOf("</html>", dashboardStart));
  assert.doesNotMatch(dashboard, />STREAM_API</);
  assert.doesNotMatch(dashboard, /<span>Session ID<\/span>|<span>Stream ID<\/span>/);
  assert.match(dashboard, /Hermes Conversation ID/);
  assert.match(dashboard, /America\/Caracas/);
});
