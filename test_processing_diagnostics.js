"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { normalizeAdapterResponse } = require("./contract-parser");
const {
  buildProcessingTelemetry,
  classifyPostProcessingError,
  derivePersistedResultMetadata
} = require("./processing-diagnostics");

const validContract = {
  message_for_client: "Entiendo que quieres una revisión, me encantará ayudarte con eso. Solo necesito que me indiques tu nombre, apellidos y correo electrónico para poder seguir adelante y consultar la disponibilidad.",
  operation: {
    type: "identity_required",
    status: "pending",
    summary: "El paciente repite la solicitud sin proporcionar los datos de identidad requeridos."
  },
  profile_patch: {},
  state_patch: { pending_question: "identity" },
  booking_patch: {},
  tool_calls: [],
  safe_to_send: true,
  requires_handoff: false,
  recoverable: false,
  error_code: null
};

function normalize(answer) {
  return normalizeAdapterResponse(
    { answer, httpStatus: 200, toolCalls: [] },
    { httpStatus: 200, identityComplete: false, missingFields: ["first_name", "last_name", "email"] }
  );
}

test("valid strict JSON exposes successful contract diagnostics", () => {
  const result = normalize(JSON.stringify(validContract));
  assert.equal(result.contract_shape_valid, true);
  assert.equal(result.contract_strategy, "strict_json");
  assert.equal(result.contract_candidate_count, 1);
  assert.equal(result.safe_to_send, true);
  assert.equal(result.error_code, null);
});

test("reasoning before the JSON preserves the selected valid contract", () => {
  const result = normalize("Razonamiento previo que no debe enviarse.\n" + JSON.stringify(validContract));
  assert.equal(result.contract_shape_valid, true);
  assert.equal(result.contract_strategy, "last_balanced_valid_contract");
  assert.ok(result.contract_candidate_count > 0);
  assert.equal(result.message_for_client, validContract.message_for_client);
  assert.equal(result.safe_to_send, true);
});

test("invalid JSON is the only parser path to OUTPUT_CONTRACT_VIOLATION", () => {
  const result = normalize('{"message_for_client":"incompleto"');
  assert.equal(result.contract_shape_valid, false);
  assert.equal(result.contract_strategy, "not_found");
  assert.equal(result.safe_to_send, false);
  assert.equal(result.error_code, "OUTPUT_CONTRACT_VIOLATION");
});

test("valid contract followed by persistence failure is not reclassified as output violation", () => {
  const error = new Error("JSON persistence serialization failed");
  error.exceptionStage = "durable_persistence";
  const classified = classifyPostProcessingError(
    error,
    { processingStage: "durable_persistence", contractShapeValid: true },
    {
      error_code: "ADAPTER_EXCEPTION",
      intent: "error_tecnico",
      recoverable: true,
      safe_to_send: false,
      response_sent: false,
      http_status: 502
    }
  );
  assert.equal(classified.error_code, "ADAPTER_PERSISTENCE_FAILED");
  assert.notEqual(classified.error_code, "OUTPUT_CONTRACT_VIOLATION");

  const telemetry = buildProcessingTelemetry({
    processingStage: "durable_persistence",
    contractShapeValid: true,
    contractStrategy: "strict_json",
    exception: error
  });
  assert.equal(telemetry.exception_stage, "durable_persistence");
});

test("telemetry finalization failure preserves valid contract classification", () => {
  const error = new Error("telemetry failed");
  error.exceptionStage = "telemetry_finalize";
  const classified = classifyPostProcessingError(
    error,
    { processingStage: "telemetry_finalize", contractShapeValid: true },
    { error_code: "ADAPTER_EXCEPTION", safe_to_send: false, recoverable: true }
  );
  assert.equal(classified.error_code, "ADAPTER_PERSISTENCE_FAILED");
  assert.notEqual(classified.error_code, "OUTPUT_CONTRACT_VIOLATION");
});

test("legacy failed durable result is explicitly identified when reused", () => {
  const metadata = derivePersistedResultMetadata({
    status: "completed",
    error_code: null,
    normalized_result: { ok: false, error_code: "OUTPUT_CONTRACT_VIOLATION" }
  });
  assert.deepEqual(metadata, {
    durable_result_reused: true,
    persisted_result_status: "failed",
    persisted_error_code: "OUTPUT_CONTRACT_VIOLATION"
  });
});

test("successful durable result is explicitly identified when reused", () => {
  const metadata = derivePersistedResultMetadata({
    status: "completed",
    normalized_result: { ok: true, error_code: null }
  });
  assert.deepEqual(metadata, {
    durable_result_reused: true,
    persisted_result_status: "completed",
    persisted_error_code: null
  });
});

test("strict valid contract can never be converted to OUTPUT_CONTRACT_VIOLATION by post-processing", () => {
  const error = new SyntaxError("contrato JSON");
  for (const stage of ["durable_persistence", "telemetry_finalize", "response_returned"]) {
    error.exceptionStage = stage;
    const classified = classifyPostProcessingError(
      error,
      { processingStage: stage, contractShapeValid: true },
      { error_code: "OUTPUT_CONTRACT_VIOLATION", safe_to_send: false, recoverable: true }
    );
    assert.notEqual(classified.error_code, "OUTPUT_CONTRACT_VIOLATION");
  }
});

test("diagnostic telemetry contains hashes and lengths but no answer or request key", () => {
  const telemetry = buildProcessingTelemetry({
    traceId: "trace-safe",
    requestKey: "secret-request-key",
    processingStage: "contract_validated",
    answerSource: "agent_api_output_text",
    answer: "PRIVATE PATIENT RESPONSE",
    contractShapeValid: true,
    contractStrategy: "strict_json",
    contractCandidateCount: 1,
    normalizedSafeToSend: true
  });
  const serialized = JSON.stringify(telemetry);
  assert.equal(telemetry.answer_length, 24);
  assert.match(telemetry.answer_sha256_prefix, /^[a-f0-9]{12}$/);
  assert.match(telemetry.request_key_hash, /^[a-f0-9]{12}$/);
  assert.doesNotMatch(serialized, /PRIVATE PATIENT RESPONSE|secret-request-key/);
});
