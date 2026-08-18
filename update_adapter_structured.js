const fs = require('fs');
let content = fs.readFileSync('server.js', 'utf8');

// Update finishAdapterEvent
content = content.replace(
  `response_preview: extra.response_preview || null,`,
  `response_preview: extra.response_preview || null,
          operation_type: extra.operation_type || null,
          operation_status: extra.operation_status || null,
          operation_summary: extra.operation_summary || null,
          has_profile_patch: extra.has_profile_patch || false,
          has_booking_patch: extra.has_booking_patch || false,`
);

// Update failAdapterEvent
content = content.replace(
  `response_preview: extra.response_preview || null
        })
        .eq('id', ctx.eventId);`,
  `response_preview: extra.response_preview || null,
          operation_type: extra.operation_type || null,
          operation_status: extra.operation_status || null,
          operation_summary: extra.operation_summary || null,
          has_profile_patch: extra.has_profile_patch || false,
          has_booking_patch: extra.has_booking_patch || false
        })
        .eq('id', ctx.eventId);`
);

// Update normalizeAdapterResponse
const newNormalizeFunction = `function normalizeAdapterResponse(result) {
  const rawReply = result.answer || "";
  
  if (isProviderErrorText(rawReply)) {
    return {
      ok: false,
      reply: "",
      message_for_client: "",
      operation: { type: "technical_error", status: "failed", summary: "Respuesta de Hermes rechazada por error de proveedor." },
      profile_patch: {}, state_patch: {}, booking_patch: {}, tool_calls: [],
      safe_to_send: false, response_sent: false, requires_handoff: true, recoverable: true, error_code: "PROVIDER_ERROR",
      metadata: { profile: HERMES_PROFILE, hermes_session_id: result.sessionId, provider_error: true }
    };
  }

  let parsedJson = null;
  let isStrictJson = false;

  try {
    const trimmed = rawReply.trim();
    if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
      parsedJson = JSON.parse(trimmed);
      isStrictJson = true;
    }
  } catch (e) {
    parsedJson = null;
  }

  if (!isStrictJson) {
     const hasPartialJson = /\\{.*"message_for_client".*\\}/s.test(rawReply) || /\\{.*"safe_to_send".*\\}/s.test(rawReply);
     
     if (hasPartialJson || containsInternalReasoning(rawReply)) {
       return {
          ok: false, reply: "", message_for_client: "",
          operation: { type: "technical_error", status: "failed", summary: "Respuesta de Hermes rechazada por formato inválido." },
          profile_patch: {}, state_patch: {}, booking_patch: {}, tool_calls: [],
          safe_to_send: false, response_sent: false, requires_handoff: false, recoverable: true, error_code: "INVALID_HERMES_CONTRACT"
       };
     }

     const sanitizedReply = sanitizePatientReply(rawReply);
     const lowerReply = (sanitizedReply || "").toLowerCase();
     const forbiddenPhrases = [
       "perfil incompleto", "display_name", "mensajes consolidados", "buffer",
       "reglas internas", "herramientas", "razonamiento", "estados tǸcnicos", "nombres de campos"
     ];
     const containsForbidden = forbiddenPhrases.some(p => lowerReply.includes(p));

     if (containsForbidden || containsInternalReasoning(sanitizedReply)) {
        return {
          ok: false, reply: "", message_for_client: "",
          operation: { type: "technical_error", status: "failed", summary: "Respuesta de Hermes rechazada por formato inválido." },
          profile_patch: {}, state_patch: {}, booking_patch: {}, tool_calls: [],
          safe_to_send: false, response_sent: false, requires_handoff: false, recoverable: true, error_code: "INVALID_HERMES_CONTRACT"
        };
     }
     
     if (!sanitizedReply) {
        return {
          ok: false, reply: "", message_for_client: "",
          operation: { type: "technical_error", status: "failed", summary: "Respuesta vacía." },
          profile_patch: {}, state_patch: {}, booking_patch: {}, tool_calls: [],
          safe_to_send: false, response_sent: false, requires_handoff: true, recoverable: true, error_code: "INVALID_HERMES_CONTRACT"
        };
     }

     return {
        ok: true, reply: sanitizedReply, message_for_client: sanitizedReply,
        operation: {}, profile_patch: {}, state_patch: {}, booking_patch: {}, tool_calls: [],
        safe_to_send: true, response_sent: false, requires_handoff: false, recoverable: false, error_code: null
     };
  }

  const isValidContract = 
    parsedJson && 
    typeof parsedJson === "object" &&
    typeof parsedJson.message_for_client === "string" &&
    typeof parsedJson.operation === "object" && parsedJson.operation !== null &&
    typeof parsedJson.profile_patch === "object" && parsedJson.profile_patch !== null &&
    typeof parsedJson.state_patch === "object" && parsedJson.state_patch !== null &&
    typeof parsedJson.booking_patch === "object" && parsedJson.booking_patch !== null &&
    Array.isArray(parsedJson.tool_calls) &&
    typeof parsedJson.safe_to_send === "boolean" &&
    typeof parsedJson.requires_handoff === "boolean" &&
    typeof parsedJson.recoverable === "boolean" &&
    (typeof parsedJson.error_code === "string" || parsedJson.error_code === null);

  if (!isValidContract) {
     return {
        ok: false, reply: "", message_for_client: "",
        operation: { type: "technical_error", status: "failed", summary: "Respuesta de Hermes rechazada por formato inválido." },
        profile_patch: {}, state_patch: {}, booking_patch: {}, tool_calls: [],
        safe_to_send: false, response_sent: false, requires_handoff: false, recoverable: true, error_code: "INVALID_HERMES_CONTRACT"
     };
  }

  const safe = parsedJson.safe_to_send === true;
  const hasMsg = parsedJson.message_for_client.trim().length > 0;
  
  return {
     ok: safe && hasMsg,
     reply: (safe && hasMsg) ? parsedJson.message_for_client : "",
     message_for_client: parsedJson.message_for_client,
     operation: parsedJson.operation,
     profile_patch: parsedJson.profile_patch,
     state_patch: parsedJson.state_patch,
     booking_patch: parsedJson.booking_patch,
     tool_calls: parsedJson.tool_calls,
     safe_to_send: safe,
     response_sent: false,
     requires_handoff: parsedJson.requires_handoff,
     recoverable: parsedJson.recoverable,
     error_code: parsedJson.error_code
  };
}`;

const oldNormalizeFunctionRegex = /function normalizeAdapterResponse\(result\) \{[\s\S]*?\n  \}\n/m;
content = content.replace(oldNormalizeFunctionRegex, newNormalizeFunction + "\n");

// We need to update extractResponsePreview to ensure it only extracts from message_for_client if valid json contract.
// We can just rely on normalizedResponse.message_for_client !
content = content.replace(
  `function extractResponsePreview(responseObj) {
  if (!responseObj) return "";
  const reply = responseObj.reply || responseObj.answer || responseObj.message_for_client || "";
  return reply.replace(/<think>[\\s\\S]*?<\\/think>/gi, "").replace(/\\\`\\\`\\\`json[\\s\\S]*?\\\`\\\`\\\`/gi, "").trim().slice(0, 200);
}`,
  `function extractResponsePreview(responseObj) {
  if (!responseObj) return "";
  const reply = responseObj.message_for_client || responseObj.reply || "";
  return reply.replace(/<think>[\\s\\S]*?<\\/think>/gi, "").replace(/\\\`\\\`\\\`json[\\s\\S]*?\\\`\\\`\\\`/gi, "").trim().slice(0, 200);
}`
);

// We must also update where finishAdapterEvent is called to include operation and patch boolean!
content = content.replace(
  `route: finalRoute,`,
  `route: finalRoute,
          operation_type: normalizedResponse.operation?.type || null,
          operation_status: normalizedResponse.operation?.status || null,
          operation_summary: normalizedResponse.operation?.summary || null,
          has_profile_patch: Object.keys(normalizedResponse.profile_patch || {}).length > 0,
          has_booking_patch: Object.keys(normalizedResponse.booking_patch || {}).length > 0,`
);

fs.writeFileSync('server.js', content, 'utf8');
console.log("Structured contract updates applied.");
