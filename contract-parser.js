function containsInternalReasoning(text) {
  if (!text) return false;
  const lowerText = text.toLowerCase();
  const patterns = [
    "estado:",
    "**estado:**",
    "siguiendo el flujo interno",
    "validar estado",
    "señales",
    "clasificar intención",
    "clasificar intencion",
    "consultar rag",
    "rag/tools",
    "responder",
    "ai enabled",
    "handoff humano",
    "kill switch",
    "status:",
    "perfil:",
    "**perfil:**",
    "clínica:",
    "clinica:",
    "**clínica:**",
    "**clinica:**",
    "no hay herramienta",
    "herramienta de agenda",
    "base de conocimiento",
    "flujo interno",
    "debo responder",
    "la respuesta debe",
    "voy a procesar",
    "el paciente",
    "detecto que",
    "no tengo acceso directo",
    "no tengo conectado",
    "esta simulación",
    "esta simulacion",
    "voy a intentar",
    "perfil está incompleto",
    "perfil esta incompleto"
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
      ok: false, reply: "", message_for_client: "",
      operation: { type: "technical_error", status: "failed", summary: "Respuesta final de Hermes rechazada por contrato inválido o no encontrado." },
      profile_patch: {}, state_patch: {}, booking_patch: {}, tool_calls: [],
      safe_to_send: false, response_sent: false, requires_handoff: false, recoverable: true, error_code: "INVALID_HERMES_CONTRACT"
    };
  }

  // Validaciones de seguridad adicionales:
  // La presencia de razonamiento fuera del JSON no debe invalidar el contrato,
  // siempre que el JSON extraído cumpla el contrato, message_for_client no contenga
  // razonamiento interno, y safe_to_send sea true para poder enviar al paciente.
  const hasReasoning = containsInternalReasoning(parsedJson.message_for_client);
  const safe = parsedJson.safe_to_send === true && !hasReasoning;

  return {
    ok: safe,
    reply: safe ? parsedJson.message_for_client : "",
    message_for_client: parsedJson.message_for_client,
    operation: parsedJson.operation,
    profile_patch: parsedJson.profile_patch,
    state_patch: parsedJson.state_patch,
    booking_patch: parsedJson.booking_patch,
    tool_calls: parsedJson.tool_calls,
    safe_to_send: parsedJson.safe_to_send,
    response_sent: false,
    requires_handoff: parsedJson.requires_handoff,
    recoverable: parsedJson.recoverable,
    error_code: parsedJson.error_code
  };
}

module.exports = {
  findBalancedJsonObjects,
  isValidHermesContract,
  extractLastValidHermesContract,
  normalizeAdapterResponse
};
