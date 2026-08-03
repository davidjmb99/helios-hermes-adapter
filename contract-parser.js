function containsInternalReasoning(text) {
  if (!text) return false;
  const lowerText = text.toLowerCase();
  const patterns = [
    "<think",
    "</think>",
    "siguiendo el flujo interno",
    "validar estado",
    "consultar rag",
    "rag/tools",
    "ai enabled",
    "kill switch",
    "pending_question",
    "pending_intent",
    "profile_patch",
    "state_patch",
    "booking_patch",
    "tool_calls",
    "safe_to_send",
    "requires_handoff",
    "**estado:**",
    "**perfil:**",
    "**clínica:**",
    "**clinica:**",
    "clasificar intención",
    "clasificar intencion",
    "flujo interno",
    "voy a procesar",
    "detecto que",
    "esta simulación",
    "esta simulacion",
    "voy a intentar",
    "perfil está incompleto",
    "perfil esta incompleto",
    "no tengo acceso directo",
    "no tengo conectado"
  ];
  return patterns.some(pattern => lowerText.includes(pattern));
}

const HERMES_OUTPUT_CONTRACT_INSTRUCTIONS = `OUTPUT CONTRACT (REQUIRED):
Return exactly one JSON object and no Markdown or prose outside it.
The object must contain: message_for_client (string), operation (object), profile_patch (object), state_patch (object), booking_patch (object), tool_calls (array), safe_to_send (boolean), requires_handoff (boolean), recoverable (boolean), and error_code (string or null).
Do not omit empty patch objects or the tool_calls array.`;

function buildHermesContractInput(payload) {
  return `${HERMES_OUTPUT_CONTRACT_INSTRUCTIONS}\n\nOPERATIONAL PAYLOAD:\n${JSON.stringify(payload || {}, null, 2)}`;
}

function normalizeForSafetyCheck(text) {
  return String(text || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

function isSafePlainIdentityRequest(rawReply, context = {}) {
  const text = String(rawReply || "").trim();
  if (!text || context.httpStatus !== 200 || context.identityComplete !== false) return false;

  const toolCalls = Array.isArray(context.toolCalls) ? context.toolCalls : [];
  if (toolCalls.length > 0 || findBalancedJsonObjects(text).length > 0) return false;
  if (context.requiresHandoff === true) return false;
  if (context.profilePatch && Object.keys(context.profilePatch).length > 0) return false;
  if (context.bookingPatch && Object.keys(context.bookingPatch).length > 0) return false;

  const lower = normalizeForSafetyCheck(text);
  const structuredMarkers = [
    "profile_patch", "booking_patch", "state_patch", "tool_calls",
    "requires_handoff", "safe_to_send"
  ];
  if (structuredMarkers.some(marker => lower.includes(marker))) return false;

  const forbiddenClinicalOrExternalActions = [
    /\bdiagnostic/, /\benfermedad\b/, /\bcaries\b/,
    /\bmedic(?:acion|amento|ina)\b/, /\brecet/, /\bdosis\b/,
    /\bantibiotic/, /\banalgesic/, /\bprecio\b/, /\bcosto\b/,
    /\bcuesta\b/, /(?:\$|€|\busd\b|\beur\b)/,
    /\b(?:cita|reserva|turno)\s+(?:esta\s+)?(?:confirmad|agendad|reservad|cancelad|reprogramad)/,
    /\b(?:he|hemos)\s+(?:confirmado|agendado|reservado|cancelado|reprogramado)\b/,
    /\b(?:derivar|transferir|handoff)\b/,
    /\b(?:agente|asesor|equipo|humano)\b/
  ];
  if (forbiddenClinicalOrExternalActions.some(pattern => pattern.test(lower))) return false;

  const requestCue = /(?:\?|¿|necesit|podrias|puedes|facilit|indica|dime|compart|proporcion|escrib)/.test(lower);
  if (!requestCue) return false;

  const missingFields = [...new Set(
    (Array.isArray(context.missingFields) ? context.missingFields : [])
      .map(field => String(field))
      .filter(field => ["first_name", "last_name", "email"].includes(field))
  )];
  if (missingFields.length === 0) return false;

  const asksFullName = /\bnombre\s+completo\b/.test(lower);
  const requestsField = {
    first_name: asksFullName || /\bnombre\b/.test(lower),
    last_name: asksFullName || /\bapellido/.test(lower),
    email: /\bcorreo(?:\s+electronico)?\b|\be-?mail\b/.test(lower)
  };
  return missingFields.every(field => requestsField[field] === true);
}

function createPlainIdentityRepair(rawReply) {
  const text = String(rawReply).trim();
  return {
    ok: true,
    reply: text,
    message_for_client: text,
    route: "identity",
    intent: "collect_patient_identity",
    operation: {
      type: "identity_required",
      status: "pending",
      summary: "Faltan datos obligatorios de identidad."
    },
    operation_type: "identity_required",
    operation_status: "pending",
    operation_summary: "Faltan datos obligatorios de identidad.",
    profile_patch: {},
    state_patch: { pending_question: "identity" },
    booking_patch: {},
    has_profile_patch: false,
    has_state_patch: true,
    has_booking_patch: false,
    tool_calls: [],
    safe_to_send: true,
    response_sent: false,
    requires_handoff: false,
    recoverable: false,
    error_code: null,
    contract_repair_applied: true,
    contract_repair_reason: "identity_request_plain_text",
    original_output_format: "plain_text"
  };
}

function findBalancedJsonObjects(text) {
  const candidates = [];
  if (typeof text !== "string") return candidates;

  for (let startIdx = 0; startIdx < text.length; startIdx++) {
    if (text[startIdx] !== '{') continue;

    let depth = 0;
    let start = startIdx;
    let inString = false;
    let escaped = false;
    let balanced = false;
    let endIdx = -1;

    for (let i = startIdx; i < text.length; i++) {
      const char = text[i];

      if (escaped) {
        escaped = false;
        continue;
      }

      if (inString) {
        if (char === '\\') {
          escaped = true;
        } else if (char === '"') {
          inString = false;
        }
      } else {
        if (char === '"') {
          inString = true;
        } else if (char === '{') {
          depth++;
        } else if (char === '}') {
          if (depth > 0) {
            depth--;
            if (depth === 0) {
              endIdx = i;
              balanced = true;
              break;
            }
          }
        }
      }
    }

    if (balanced && endIdx !== -1) {
      const candidate = text.substring(start, endIdx + 1);
      candidates.push(candidate);
    }
  }

  return candidates;
}

function isValidHermesContract(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  if (typeof value.message_for_client !== "string") {
    return false;
  }
  
  const isObjectNotArrayOrNull = (val) => {
    return val && typeof val === "object" && !Array.isArray(val);
  };

  if (!isObjectNotArrayOrNull(value.operation)) {
    return false;
  }
  if (!isObjectNotArrayOrNull(value.profile_patch)) {
    return false;
  }
  if (!isObjectNotArrayOrNull(value.state_patch)) {
    return false;
  }
  if (!isObjectNotArrayOrNull(value.booking_patch)) {
    return false;
  }
  
  if (!Array.isArray(value.tool_calls)) {
    return false;
  }
  if (typeof value.safe_to_send !== "boolean") {
    return false;
  }
  if (typeof value.requires_handoff !== "boolean") {
    return false;
  }
  if (typeof value.recoverable !== "boolean") {
    return false;
  }
  if (typeof value.error_code !== "string" && value.error_code !== null) {
    return false;
  }
  
  return true;
}

function extractLastValidHermesContract(text) {
  const candidates = findBalancedJsonObjects(text);
  for (let i = candidates.length - 1; i >= 0; i--) {
    try {
      const parsed = JSON.parse(candidates[i]);
      if (isValidHermesContract(parsed)) {
        return { parsed, substring: candidates[i], candidateCount: candidates.length };
      }
    } catch (_) {
      // Ignore individual JSON.parse exceptions
    }
  }
  return null;
}

function normalizeAdapterResponse(result, context = {}) {
  const rawReply = result.answer || "";
  
  let parsedJson = null;
  let isStrictJson = false;
  let strategy = "not_found";
  let candidateCount = 0;
  let selectedLength = null;
  let reasoningPrefixDetected = false;

  const trimmed = rawReply.trim();
  
  // A. Intentar JSON estricto completo si rawReply entero es JSON válido.
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
    try {
      const parsed = JSON.parse(trimmed);
      if (isValidHermesContract(parsed)) {
        parsedJson = parsed;
        isStrictJson = true;
        strategy = "strict_json";
        candidateCount = 1;
        selectedLength = trimmed.length;
        reasoningPrefixDetected = false;
      }
    } catch (e) {}
  }

  // B. Si no lo es, ejecutar extractLastValidHermesContract(rawReply).
  if (!parsedJson) {
    const extracted = extractLastValidHermesContract(rawReply);
    if (extracted) {
      parsedJson = extracted.parsed;
      strategy = "last_balanced_valid_contract";
      candidateCount = extracted.candidateCount;
      selectedLength = extracted.substring.length;
      
      const jsonIndex = rawReply.indexOf(extracted.substring);
      const prefix = rawReply.substring(0, jsonIndex).trim();
      reasoningPrefixDetected = prefix.length > 0;
    }
  }

  // Aportar observabilidad
  console.log("Telemetry Contract Extraction Info:", JSON.stringify({
    event: "hermes_contract_extraction",
    strategy,
    candidate_count: candidateCount,
    raw_length: rawReply.length,
    selected_length: selectedLength,
    reasoning_prefix_detected: reasoningPrefixDetected
  }));

  // D. Si no encuentra contrato válido, devolver INVALID_HERMES_CONTRACT.
  if (!parsedJson) {
    if (isSafePlainIdentityRequest(rawReply, {
      ...context,
      toolCalls: context.toolCalls || result.toolCalls || result.tokenUsage?.tool_calls || [],
      profilePatch: context.profilePatch || result.profile_patch,
      bookingPatch: context.bookingPatch || result.booking_patch,
      requiresHandoff: context.requiresHandoff ?? result.requires_handoff
    })) {
      console.log("Telemetry Contract Repair Info:", JSON.stringify({
        event: "hermes_contract_repair",
        contract_repair_applied: true,
        contract_repair_reason: "identity_request_plain_text",
        original_output_format: "plain_text"
      }));
      return createPlainIdentityRepair(rawReply);
    }

    return {
      ok: false,
      reply: "",
      message_for_client: "",
      route: "error",
      intent: "technical_error",
      operation: { type: "technical_error", status: "failed", summary: "Respuesta final de Hermes rechazada por contrato inválido o no encontrado." },
      operation_type: "technical_error",
      operation_status: "failed",
      operation_summary: "Respuesta final de Hermes rechazada por contrato inválido o no encontrado.",
      profile_patch: {},
      state_patch: {},
      booking_patch: {},
      has_profile_patch: false,
      has_booking_patch: false,
      has_state_patch: false,
      tool_calls: [],
      safe_to_send: false,
      response_sent: false,
      requires_handoff: false,
      recoverable: true,
      contract_repair_applied: false,
      contract_repair_reason: null,
      original_output_format: "invalid_or_ambiguous",
      error_code: "OUTPUT_CONTRACT_VIOLATION"
    };
  }

  // Validaciones de seguridad adicionales:
  // Corrección 2: Cuando hasReasoning === true dentro de message_for_client
  const hasReasoning = containsInternalReasoning(parsedJson.message_for_client);
  if (hasReasoning) {
    return {
      ok: false,
      reply: "",
      message_for_client: "",
      route: "error",
      intent: "internal_reasoning_blocked",
      operation: { type: "technical_error", status: "failed", summary: "Respuesta final de Hermes rechazada por contener razonamiento interno en el mensaje al cliente." },
      operation_type: "technical_error",
      operation_status: "failed",
      operation_summary: "Respuesta final de Hermes rechazada por contener razonamiento interno en el mensaje al cliente.",
      profile_patch: {},
      state_patch: {},
      booking_patch: {},
      has_profile_patch: false,
      has_booking_patch: false,
      has_state_patch: false,
      tool_calls: [],
      safe_to_send: false,
      response_sent: false,
      requires_handoff: false,
      recoverable: true,
      error_code: "INTERNAL_REASONING_IN_CLIENT_MESSAGE"
    };
  }

  // Corrección 1: safe_to_send: safe y ok: safe
  const safe = parsedJson.safe_to_send === true;
  const profilePatch = parsedJson.profile_patch || {};
  const statePatch = parsedJson.state_patch || {};
  const bookingPatch = parsedJson.booking_patch || {};
  const operationObj = parsedJson.operation || {};

  return {
    ok: safe,
    reply: safe ? parsedJson.message_for_client : "",
    message_for_client: parsedJson.message_for_client,
    route: parsedJson.route || "hermes",
    intent: parsedJson.intent || statePatch.pending_intent || statePatch.last_intent || operationObj.type || "respuesta_hermes",
    operation: operationObj,
    operation_type: operationObj.type || null,
    operation_status: operationObj.status || null,
    operation_summary: operationObj.summary || null,
    profile_patch: profilePatch,
    state_patch: statePatch,
    booking_patch: bookingPatch,
    has_profile_patch: Object.keys(profilePatch).length > 0,
    has_state_patch: Object.keys(statePatch).length > 0,
    has_booking_patch: Object.keys(bookingPatch).length > 0,
    tool_calls: parsedJson.tool_calls || [],
    safe_to_send: safe,
    response_sent: false,
    requires_handoff: parsedJson.requires_handoff === true,
    recoverable: parsedJson.recoverable === true,
    error_code: parsedJson.error_code || null
  };
}

module.exports = {
  HERMES_OUTPUT_CONTRACT_INSTRUCTIONS,
  buildHermesContractInput,
  findBalancedJsonObjects,
  isValidHermesContract,
  extractLastValidHermesContract,
  isSafePlainIdentityRequest,
  normalizeAdapterResponse
};
