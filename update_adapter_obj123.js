const fs = require('fs');
let content = fs.readFileSync('server.js', 'utf8');

// OBJETIVO 1: Strict JSON contract parsing
const newNormalize = `function normalizeAdapterResponse(result) {
  const rawReply = result.answer || "";
  
  if (isProviderErrorText(rawReply)) {
    return {
      ok: false,
      reply: "",
      message_for_client: "",
      operation: { type: "technical_error", status: "failed", summary: "Respuesta de Hermes rechazada por error de proveedor." },
      profile_patch: {}, state_patch: {}, booking_patch: {}, tool_calls: [],
      safe_to_send: false, response_sent: false, requires_handoff: true, recoverable: true, error_code: "PROVIDER_ERROR"
    };
  }

  let parsedJson = null;
  let isStrictJson = false;
  let jsonError = false;

  const trimmed = rawReply.trim();
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
    try {
      parsedJson = JSON.parse(trimmed);
      isStrictJson = true;
    } catch (e) {
      jsonError = true;
    }
  }

  // If there's text before/after, or multiple JSON objects, it will fail the strict startswith/endswith or JSON.parse.
  // Also, check for "Pensando" or reasoning tags.
  if (containsInternalReasoning(rawReply) || jsonError || (!isStrictJson && trimmed.includes("{") && trimmed.includes("}"))) {
      return {
        ok: false, reply: "", message_for_client: "",
        operation: { type: "technical_error", status: "failed", summary: "Respuesta de Hermes rechazada por formato inválido." },
        profile_patch: {}, state_patch: {}, booking_patch: {}, tool_calls: [],
        safe_to_send: false, response_sent: false, requires_handoff: false, recoverable: true, error_code: "INVALID_HERMES_CONTRACT"
      };
  }

  // Fallback a texto plano si no hay llaves de JSON
  if (!isStrictJson) {
     const sanitizedReply = sanitizePatientReply(rawReply);
     const lowerReply = (sanitizedReply || "").toLowerCase();
     const forbiddenPhrases = ["perfil incompleto", "display_name", "mensajes consolidados", "buffer", "reglas internas", "herramientas", "razonamiento", "estados tǸcnicos", "nombres de campos"];
     if (forbiddenPhrases.some(p => lowerReply.includes(p)) || containsInternalReasoning(sanitizedReply) || !sanitizedReply) {
        return {
          ok: false, reply: "", message_for_client: "",
          operation: { type: "technical_error", status: "failed", summary: "Respuesta de Hermes rechazada por formato inválido." },
          profile_patch: {}, state_patch: {}, booking_patch: {}, tool_calls: [],
          safe_to_send: false, response_sent: false, requires_handoff: false, recoverable: true, error_code: "INVALID_HERMES_CONTRACT"
        };
     }
     
     return {
        ok: true, reply: sanitizedReply, message_for_client: sanitizedReply,
        operation: {}, profile_patch: {}, state_patch: {}, booking_patch: {}, tool_calls: [],
        safe_to_send: true, response_sent: false, requires_handoff: false, recoverable: false, error_code: null
     };
  }

  // Es un JSON estricto, validar campos requeridos
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

  // Contrato vǭlido
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

const normalizeStart = content.indexOf('function normalizeAdapterResponse(result) {');
const endMarker = 'app.get("/health", (req, res) => {';
const normalizeEnd = content.indexOf(endMarker);

if (normalizeStart !== -1 && normalizeEnd !== -1) {
  content = content.substring(0, normalizeStart) + newNormalize + '\n\n  ' + content.substring(normalizeEnd);
} else {
  console.log("Could not find normalizeAdapterResponse block");
}


// OBJETIVO 2: Identidad Util
// Update getPatientDisplayName
content = content.replace(
  `function extractPhone(normalized, payload) {
  return normalized?.conversation?.phone || normalized?.patient?.phone || payload?.conversation?.phone || payload?.patient?.phone || null;
}`,
  `function extractPhone(normalized, payload, input) {
  return normalized?.conversation?.phone || normalized?.patient?.phone || payload?.conversation?.phone || payload?.patient?.phone || input?.conversation?.phone || input?.patient?.phone || null;
}`
);

content = content.replace(
  `function getPatientDisplayName(patient) {
  if (!patient) return "Contacto sin identificar";
  if (patient.profile_complete === true && patient.first_name && patient.last_name) {
    return patient.first_name + " " + patient.last_name;
  }
  if (patient.chatwoot_display_name) return patient.chatwoot_display_name;
  
  return "Contacto sin identificar";
}`,
  `function getPatientDisplayName(patient) {
  if (!patient) return "Contacto sin identificar";
  if (patient.profile_complete === true && patient.first_name && patient.last_name) {
    return patient.first_name + " " + patient.last_name;
  }
  if (patient.profile_complete === false && patient.chatwoot_display_name) {
    return patient.chatwoot_display_name;
  }
  if (patient.chatwoot_display_name) return patient.chatwoot_display_name;
  return "Contacto sin identificar";
}`
);

// In telemetry, we must store session_id and stream_id
// Wait, finishAdapterEvent parameters are getting too many.
// extra.session_id and extra.stream_id
content = content.replace(
  `tool_duration_ms: extra.tool_duration_ms || null,`,
  `tool_duration_ms: extra.tool_duration_ms || null,
          session_id: extra.session_id || null,
          stream_id: extra.stream_id || null,`
);

content = content.replace(
  `tool_duration_ms: extra.tool_duration_ms || null`, // wait, there are 2 finishAdapterEvent replacements in DB update
  `tool_duration_ms: extra.tool_duration_ms || null,
          session_id: extra.session_id || null,
          stream_id: extra.stream_id || null`
);

// We need to fetch streamId from result.streamId and sessionId from result.sessionId.
// Inside app.post("/helios/message"), result has streamId and sessionId.
content = content.replace(
  `hermes_first_token_ms: hermesFirstTokenMs,`,
  `hermes_first_token_ms: hermesFirstTokenMs,
          session_id: result?.sessionId || null,
          stream_id: result?.streamId || null,`
);

// OBJETIVO 3: UI Updates for Dashboard
content = content.replace(
  `<div><span class="label">Duration:</span> <span class="value">\\\${ev.duration_ms}ms</span></div>
   <div><span class="label">Phone:</span> <span class="value">\\\${ev.phone || 'N/A'}</span></div>`,
  `<div><span class="label">Duration:</span> <span class="value">\\\${ev.duration_ms}ms</span></div>
   <div><span class="label">Phone:</span> <span class="value">\\\${ev.phone ? maskPhone(ev.phone) : 'N/A'}</span></div>
   <div><span class="label">Session ID:</span> <span class="value">\\\${ev.session_id || 'N/A'}</span></div>
   <div><span class="label">Stream ID:</span> <span class="value">\\\${ev.stream_id || 'N/A'}</span></div>`
);
// Wait, maskPhone must be available in frontend? 
// No, the UI is constructed on the server. Oh wait, it's a template literal rendered in the frontend via JS!
// \`\${ev.phone || 'N/A'}\` is evaluated on the client. Wait.
// Oh, \`\${...}\` is string interpolation on the server? No, it's sent as HTML template literal to the client if it's inside <script>.
// Let's check how maskPhone works. The server has \`maskPhone\`. We should mask it before sending to the client, OR we just mask it when writing to DB? No, DB must have raw phone? The user says: "Mostrar el teléfono ya enmascarado que llega desde Gateway". Gateway already masked it? No, Gateway sends it raw, but user says "Mostrar el telefono ya enmascarado que llega desde Gateway", meaning the payload from Gateway has `phone` which we mask in the dashboard. Wait, if we use `maskPhone(ev.phone)` in the client script, it will fail because `maskPhone` is not in the client script.
// Let's modify the `/debug/events` to map the events and mask the phone before sending JSON.

content = content.replace(
  `res.json({ count: data.length, events: data });`,
  `const maskedEvents = data.map(ev => ({
        ...ev,
        phone: ev.phone ? maskPhone(ev.phone) : 'N/A'
      }));
      res.json({ count: maskedEvents.length, events: maskedEvents });`
);

// Now in the frontend script:
content = content.replace(
  `<div><span class="label">Phone:</span> <span class="value">\\\${ev.phone || 'N/A'}</span></div>`,
  `<div><span class="label">Phone:</span> <span class="value">\\\${ev.phone || 'N/A'}</span></div>
   <div><span class="label">Session ID:</span> <span class="value" title="\\\${ev.session_id || ''}">\\\${ev.session_id ? ev.session_id.substring(0,8)+'...' : 'N/A'}</span></div>
   <div><span class="label">Stream ID:</span> <span class="value" title="\\\${ev.stream_id || ''}">\\\${ev.stream_id ? ev.stream_id.substring(0,8)+'...' : 'N/A'}</span></div>`
);

content = content.replace(
  `<div><strong>Teléfono:</strong> \\\${event.phone ?? 'N/A'}</div>`,
  `<div><strong>Teléfono:</strong> \\\${event.phone ?? 'N/A'}</div>
   <div><strong>Session ID:</strong> \\\${event.session_id ?? 'N/A'}</div>
   <div><strong>Stream ID:</strong> \\\${event.stream_id ?? 'N/A'}</div>`
);


// Ensure error catching in app.post does not leak ADAPTER_EXCEPTION when not necessary.
// If normalizeAdapterResponse throws? It doesn't throw anymore.
// Also, response_preview should exclusively be from message_for_client.
content = content.replace(
  `function extractResponsePreview(responseObj) {
  if (!responseObj) return "";
  const reply = responseObj.message_for_client || responseObj.reply || "";
  return reply.replace(/<think>[\\s\\S]*?<\\/think>/gi, "").replace(/\\\`\\\`\\\`json[\\s\\S]*?\\\`\\\`\\\`/gi, "").trim().slice(0, 200);
}`,
  `function extractResponsePreview(responseObj) {
  if (!responseObj) return "";
  const reply = responseObj.message_for_client || "";
  return reply.replace(/<think>[\\s\\S]*?<\\/think>/gi, "").replace(/\\\`\\\`\\\`json[\\s\\S]*?\\\`\\\`\\\`/gi, "").trim().slice(0, 200);
}`
);


// We need to ensure telemetry includes operation fields and patches exactly as the user wants.
content = content.replace(
  `operation_type: normalizedResponse.operation?.type || null,
          operation_status: normalizedResponse.operation?.status || null,
          operation_summary: normalizedResponse.operation?.summary || null,
          has_profile_patch: Object.keys(normalizedResponse.profile_patch || {}).length > 0,
          has_booking_patch: Object.keys(normalizedResponse.booking_patch || {}).length > 0,`,
  `operation_type: normalizedResponse.operation?.type || null,
          operation_status: normalizedResponse.operation?.status || null,
          operation_summary: normalizedResponse.operation?.summary || null,
          has_profile_patch: Object.keys(normalizedResponse.profile_patch || {}).length > 0,
          has_booking_patch: Object.keys(normalizedResponse.booking_patch || {}).length > 0,`
);

fs.writeFileSync('server.js', content, 'utf8');
console.log("DONE");
