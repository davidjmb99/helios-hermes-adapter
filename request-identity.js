"use strict";

const crypto = require("node:crypto");

function nonEmpty(value) {
  if (value === undefined || value === null) return "";
  return String(value).trim();
}

function uniqueSorted(values) {
  return [...new Set(values.map(nonEmpty).filter(Boolean))].sort();
}

function extractSourceMessageIds(normalized = {}) {
  const itemIds = (Array.isArray(normalized.message_items)
    ? normalized.message_items
    : []
  ).flatMap(item => [
    item?.id,
    item?.message_id,
    item?.source_id,
    item?.external_id
  ]);

  const metadata = normalized.metadata || {};
  const raw = normalized.raw || {};
  return uniqueSorted([
    ...itemIds,
    metadata.source_message_id,
    metadata.message_id,
    metadata.chatwoot_message_id,
    raw.source_message_id,
    raw.message_id,
    raw.chatwoot_message_id,
    raw.message?.id
  ]);
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function createStableRequestIdentity(normalized = {}, tenantContext = {}) {
  const sourceMessageIds = extractSourceMessageIds(normalized);
  const sourceMessageIdsHash = sourceMessageIds.length > 0
    ? sha256(sourceMessageIds.join("|"))
    : null;
  const scope = [
    `account:${nonEmpty(tenantContext.account_id || normalized.account_id) || "none"}`,
    `tenant:${nonEmpty(tenantContext.tenant_id || normalized.tenant_id) || "none"}`,
    `clinic:${nonEmpty(tenantContext.clinic_id || normalized.clinic_id) || "none"}`,
    `profile:${nonEmpty(tenantContext.hermes_profile || normalized.hermes_profile) || "none"}`,
    `conversation:${nonEmpty(normalized.conversation_id) || "none"}`,
    `contact:${nonEmpty(normalized.contact_id) || "none"}`
  ];

  let strategy = "none";
  let material = "";
  if (sourceMessageIds.length > 0) {
    strategy = "source_message_ids";
    material = [...scope, `messages:${sourceMessageIds.join(",")}`].join("|");
  } else if (nonEmpty(normalized.trace_id)) {
    strategy = "trace_id";
    material = [...scope, `trace:${nonEmpty(normalized.trace_id)}`].join("|");
  }

  if (!material) {
    return {
      key: null,
      strategy,
      fingerprintHash: null,
      sourceMessageIdCount: 0,
      sourceMessageIdsHash
    };
  }

  const digest = sha256(material);
  return {
    key: `helios-${digest}`,
    strategy,
    fingerprintHash: digest.slice(0, 12),
    sourceMessageIdCount: sourceMessageIds.length,
    sourceMessageIdsHash
  };
}

module.exports = {
  createStableRequestIdentity,
  extractSourceMessageIds
};
