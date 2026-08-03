"use strict";

const crypto = require("node:crypto");

const PERSISTENCE_STAGES = new Set(["durable_lookup", "durable_persistence", "telemetry_finalize"]);

function sha256Prefix(value, length = 12) {
  if (value === null || value === undefined || value === "") return null;
  return crypto.createHash("sha256").update(String(value)).digest("hex").slice(0, length);
}

function derivePersistedResultMetadata(execution) {
  const normalizedResult = execution?.normalized_result || null;
  const failedNormalizedResult = normalizedResult?.ok === false;
  return {
    durable_result_reused: Boolean(execution),
    persisted_result_status: failedNormalizedResult ? "failed" : execution?.status || null,
    persisted_error_code: execution?.error_code || normalizedResult?.error_code || null
  };
}

function classifyPostProcessingError(error, context, fallback) {
  const stage = error?.exceptionStage || context?.processingStage || "unknown";
  const contractShapeValid = context?.contractShapeValid === true;
  const base = { ...fallback };

  if (!contractShapeValid) return base;

  if (PERSISTENCE_STAGES.has(stage)) {
    const persistedErrorCode = String(base.error_code || "").startsWith("SUPABASE_")
      ? base.error_code
      : "ADAPTER_PERSISTENCE_FAILED";
    return {
      ...base,
      error_code: persistedErrorCode,
      intent: "adapter_persistence_error",
      recoverable: true,
      requires_handoff: false,
      safe_to_send: false,
      response_sent: false,
      http_status: 503
    };
  }

  if (base.error_code === "OUTPUT_CONTRACT_VIOLATION") {
    return {
      ...base,
      error_code: "ADAPTER_EXCEPTION",
      intent: "error_tecnico",
      recoverable: true,
      requires_handoff: false,
      safe_to_send: false,
      response_sent: false,
      http_status: 502
    };
  }

  return base;
}

function buildProcessingTelemetry({
  traceId,
  requestKey,
  processingStage,
  answerSource,
  answer,
  contractShapeValid,
  contractStrategy,
  contractCandidateCount,
  normalizedSafeToSend,
  normalizedErrorCode,
  durableResultReused,
  persistedResultStatus,
  persistedErrorCode,
  exception
} = {}) {
  return {
    event: exception ? "adapter_processing_exception" : "adapter_contract_diagnostics",
    request_key_hash: sha256Prefix(requestKey),
    trace_id: traceId || null,
    processing_stage: processingStage || null,
    answer_source: answerSource || "unknown",
    answer_length: typeof answer === "string" ? answer.length : 0,
    answer_sha256_prefix: sha256Prefix(typeof answer === "string" ? answer : ""),
    contract_shape_valid: contractShapeValid === true,
    contract_strategy: contractStrategy || null,
    contract_candidate_count: Number.isInteger(contractCandidateCount) ? contractCandidateCount : 0,
    normalized_safe_to_send: normalizedSafeToSend === true,
    normalized_error_code: normalizedErrorCode || null,
    durable_result_reused: durableResultReused === true,
    persisted_result_status: persistedResultStatus || null,
    persisted_error_code: persistedErrorCode || null,
    exception_name: exception?.name || null,
    exception_stage: exception ? exception.exceptionStage || processingStage || "unknown" : null
  };
}

module.exports = {
  buildProcessingTelemetry,
  classifyPostProcessingError,
  derivePersistedResultMetadata,
  sha256Prefix
};
