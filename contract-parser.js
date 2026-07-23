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

function normalizeAdapterResponse(result) {
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
      error_code: "INVALID_HERMES_CONTRACT"
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
  findBalancedJsonObjects,
  isValidHermesContract,
  extractLastValidHermesContract,
  normalizeAdapterResponse
};
