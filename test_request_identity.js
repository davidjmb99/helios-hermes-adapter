"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  createStableRequestIdentity,
  extractSourceMessageIds
} = require("./request-identity");

function normalized(traceId, messageIds) {
  return {
    account_id: "2",
    tenant_id: "democoi1",
    clinic_id: "coi_demo",
    hermes_profile: "helios",
    conversation_id: "32",
    contact_id: "6",
    trace_id: traceId,
    message_items: messageIds.map(id => ({ id, body: "private" })),
    metadata: {}
  };
}

const tenantContext = {
  account_id: "2",
  tenant_id: "democoi1",
  clinic_id: "coi_demo",
  hermes_profile: "helios"
};

test("original and recovery traces share idempotency when source messages match", () => {
  const original = createStableRequestIdentity(
    normalized("trace-original", ["100", "101"]),
    tenantContext
  );
  const recovery = createStableRequestIdentity(
    normalized("recovery-new-trace", ["101", "100"]),
    tenantContext
  );

  assert.equal(original.strategy, "source_message_ids");
  assert.equal(recovery.strategy, "source_message_ids");
  assert.equal(original.key, recovery.key);
  assert.equal(original.fingerprintHash, recovery.fingerprintHash);
  assert.equal(original.sourceMessageIdCount, 2);
  assert.doesNotMatch(original.key, /100|101|trace-original/);
});

test("a new source message or tenant produces a different idempotency key", () => {
  const first = createStableRequestIdentity(
    normalized("trace-1", ["100"]),
    tenantContext
  );
  const nextMessage = createStableRequestIdentity(
    normalized("trace-2", ["100", "101"]),
    tenantContext
  );
  const nextTenant = createStableRequestIdentity(
    normalized("trace-3", ["100"]),
    { ...tenantContext, tenant_id: "other-tenant" }
  );

  assert.notEqual(first.key, nextMessage.key);
  assert.notEqual(first.key, nextTenant.key);
});

test("source identifiers are normalized without using message content", () => {
  const ids = extractSourceMessageIds({
    message_items: [
      { id: " 200 ", body: "private one" },
      { message_id: 201, body: "private two" },
      { id: "200" }
    ],
    metadata: { chatwoot_message_id: "202" }
  });

  assert.deepEqual(ids, ["200", "201", "202"]);
});

test("trace id remains a safe fallback when source ids are unavailable", () => {
  const identity = createStableRequestIdentity(
    normalized("trace-fallback", []),
    tenantContext
  );

  assert.equal(identity.strategy, "trace_id");
  assert.ok(identity.key);
  assert.doesNotMatch(identity.key, /trace-fallback/);
});
