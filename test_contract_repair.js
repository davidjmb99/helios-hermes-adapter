"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  buildHermesContractInput,
  normalizeAdapterResponse
} = require("./contract-parser");

const validContract = {
  message_for_client: "Indícame tu nombre completo y correo electrónico.",
  operation: { type: "identity_required", status: "pending", summary: "Identidad pendiente" },
  profile_patch: {},
  state_patch: { pending_question: "identity" },
  booking_patch: {},
  tool_calls: [],
  safe_to_send: true,
  requires_handoff: false,
  recoverable: false,
  error_code: null
};

const repairContext = {
  httpStatus: 200,
  toolCalls: [],
  identityComplete: false,
  missingFields: ["first_name", "last_name", "email"]
};

test("valid contractual JSON is preserved without repair", () => {
  const result = normalizeAdapterResponse({
    answer: JSON.stringify(validContract),
    httpStatus: 200,
    toolCalls: []
  }, repairContext);

  assert.equal(result.ok, true);
  assert.notEqual(result.contract_repair_applied, true);
  assert.equal(result.message_for_client, validContract.message_for_client);
});

test("safe plain text requesting missing identity is repaired", () => {
  const text = "Para gestionar tu solicitud, ¿podrías decirme tu nombre completo y tu correo electrónico?";
  const result = normalizeAdapterResponse({ answer: text, httpStatus: 200, toolCalls: [] }, repairContext);

  assert.equal(result.ok, true);
  assert.equal(result.safe_to_send, true);
  assert.equal(result.message_for_client, text);
  assert.equal(result.operation.type, "identity_required");
  assert.deepEqual(result.tool_calls, []);
  assert.deepEqual(result.profile_patch, {});
  assert.deepEqual(result.booking_patch, {});
  assert.equal(result.contract_repair_applied, true);
  assert.equal(result.contract_repair_reason, "identity_request_plain_text");
  assert.equal(result.original_output_format, "plain_text");
});

test("plain text after a tool call remains a contract violation", () => {
  const result = normalizeAdapterResponse({
    answer: "¿Podrías decirme tu nombre completo y correo electrónico?",
    httpStatus: 200,
    toolCalls: [{ name: "external_tool", status: "success" }]
  }, { ...repairContext, toolCalls: [{ name: "external_tool", status: "success" }] });

  assert.equal(result.safe_to_send, false);
  assert.equal(result.error_code, "OUTPUT_CONTRACT_VIOLATION");
});

test("plain appointment confirmation is never repaired", () => {
  const result = normalizeAdapterResponse({
    answer: "Tu cita está confirmada. ¿Puedes darme tu nombre completo y correo electrónico?",
    httpStatus: 200,
    toolCalls: []
  }, repairContext);

  assert.equal(result.safe_to_send, false);
  assert.equal(result.error_code, "OUTPUT_CONTRACT_VIOLATION");
});

test("plain diagnosis or medication content is never repaired", () => {
  for (const answer of [
    "El diagnóstico es caries. ¿Puedes darme tu nombre completo y correo electrónico?",
    "Debes tomar un medicamento. ¿Puedes darme tu nombre completo y correo electrónico?"
  ]) {
    const result = normalizeAdapterResponse({ answer, httpStatus: 200, toolCalls: [] }, repairContext);
    assert.equal(result.safe_to_send, false);
    assert.equal(result.error_code, "OUTPUT_CONTRACT_VIOLATION");
  }
});

test("JSON wrapped in Markdown is extracted only when the full contract passes", () => {
  const result = normalizeAdapterResponse({
    answer: `\`\`\`json\n${JSON.stringify(validContract)}\n\`\`\``,
    httpStatus: 200,
    toolCalls: []
  }, repairContext);

  assert.equal(result.ok, true);
  assert.notEqual(result.contract_repair_applied, true);
  assert.equal(result.message_for_client, validContract.message_for_client);
});

test("Agent input explicitly requires the complete JSON contract", () => {
  const input = buildHermesContractInput({ event: "patient_message_ready" });
  assert.match(input, /OUTPUT CONTRACT \(REQUIRED\)/);
  assert.match(input, /message_for_client/);
  assert.match(input, /tool_calls/);
  assert.match(input, /OPERATIONAL PAYLOAD/);
});
