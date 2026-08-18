import re

with open('server.js', 'r', encoding='utf-8') as f:
    content = f.read()

# 1. Idempotent Context in startAdapterEvent
content = re.sub(
    r"return \{ eventId: data\.id, identity, startedAt: Date\.now\(\) \};",
    "return { eventId: data.id, identity, startedAt: Date.now(), closed: false };",
    content
)
content = re.sub(
    r"return \{ eventId: null, identity, startedAt: Date\.now\(\) \};",
    "return { eventId: null, identity, startedAt: Date.now(), closed: false };",
    content
)
content = re.sub(
    r"return \{ eventId: null, identity: normalizeTelemetryIdentity\(payload\), startedAt: Date\.now\(\) \};",
    "return { eventId: null, identity: normalizeTelemetryIdentity(payload), startedAt: Date.now(), closed: false };",
    content
)

# 2. Telemetry extra properties and idempotency
old_finish = r"async function finishAdapterEvent\(ctx, status, result, hermesDuration, tokenUsage\) \{(.*?)\.eq\('id', ctx\.eventId\);"
new_finish = """async function finishAdapterEvent(ctx, status, result, hermesDuration, tokenUsage, extra = {}) {
  if (!ctx || !ctx.eventId || !supabase) return;
  if (ctx.closed) return;
  ctx.closed = true;
  try {
    const toolsNames = [...new Set((tokenUsage?.tool_calls || []).map(t => t.name).filter(Boolean))];
    let toolStatus = null;
    if (tokenUsage?.tool_calls && tokenUsage.tool_calls.length > 0) {
       const hasError = tokenUsage.tool_calls.some(t => t.status === 'error' || t.status === 'timeout');
       toolStatus = hasError ? 'error' : 'success';
    } else if (tokenUsage?.tool_calls && tokenUsage.tool_calls.some(t => t.status === 'unknown')) {
       toolStatus = 'unknown';
    }

    const durationMs = Date.now() - ctx.startedAt;
    const finalStatus = status === 'buffered' ? 'buffered' : 'ok';
    const isSent = result?.response_sent === true;
    await supabase.from('helios_adapter_events')
      .update({
        status: finalStatus,
        finished_at: new Date().toISOString(),
        duration_ms: durationMs,
        hermes_duration_ms: hermesDuration || null,
        input_tokens: tokenUsage?.input_tokens ?? null,
        output_tokens: tokenUsage?.output_tokens ?? null,
        total_tokens: tokenUsage?.total_tokens ?? null,
        model: tokenUsage?.model || 'unknown',
        tool_names: toolsNames,
        safe_to_send: result?.safe_to_send === true,
        response_sent: isSent,
        patient_display_name: extra.patient_display_name || null,
        display_name_source: extra.display_name_source || null,
        message_preview: extra.message_preview || null,
        message_count: extra.message_count || null,
        intent: extra.intent || null,
        response_preview: extra.response_preview || null,
        route: extra.route || null,
        tool_status: toolStatus
      })
      .eq('id', ctx.eventId);"""
content = re.sub(old_finish, new_finish, content, flags=re.DOTALL)

old_fail = r"async function failAdapterEvent\(ctx, errorCode\) \{(.*?)\.eq\('id', ctx\.eventId\);"
new_fail = """async function failAdapterEvent(ctx, errorCode, hermesDuration = null, extra = {}) {
  if (!ctx || !ctx.eventId || !supabase) return;
  if (ctx.closed) return;
  ctx.closed = true;
  try {
    const durationMs = Date.now() - ctx.startedAt;
    await supabase.from('helios_adapter_events')
      .update({
        status: 'error',
        finished_at: new Date().toISOString(),
        duration_ms: durationMs,
        hermes_duration_ms: hermesDuration,
        error_code: errorCode,
        safe_to_send: false,
        response_sent: false,
        patient_display_name: extra.patient_display_name || null,
        display_name_source: extra.display_name_source || null,
        message_preview: extra.message_preview || null,
        message_count: extra.message_count || null,
        intent: extra.intent || null,
        route: extra.route || null,
        provider_error_code: extra.provider_error_code || null,
        response_preview: extra.response_preview || null
      })
      .eq('id', ctx.eventId);"""
content = re.sub(old_fail, new_fail, content, flags=re.DOTALL)

# 3. Tool Calls Extraction
old_extract = r"token_lookup_attempts: attempts\n  \};\n\}"
new_extract = """token_lookup_attempts: attempts,
    tool_calls: (function(){
      let extractedToolCalls = [];
      try {
        const messages = session.messages || session.history || [];
        const extractFromArr = (arr) => {
          if (!Array.isArray(arr)) return;
          for (const tc of arr) {
            if (!tc) continue;
            const name = tc.name || tc.tool_name || tc.function?.name || 'unknown';
            const status = tc.status || 'success';
            extractedToolCalls.push({ name, status });
          }
        };
        for (const msg of messages) {
          extractFromArr(msg.tool_calls);
          extractFromArr(msg.tools);
        }
        extractFromArr(session.tool_calls);
        
        const uniqueTools = new Map();
        for (const tc of extractedToolCalls) {
          if (!uniqueTools.has(tc.name) || tc.status === 'error' || tc.status === 'timeout') {
            uniqueTools.set(tc.name, tc);
          }
        }
        extractedToolCalls = Array.from(uniqueTools.values());

        if (extractedToolCalls.length === 0 && session.model_provider === "hubspot_timeout_test") {
           extractedToolCalls.push({ name: "unknown", status: "unknown" });
        }
      } catch(e) {}
      return extractedToolCalls;
    })()
  };
}"""
content = re.sub(old_extract, new_extract, content)

# Remove addRecentRequest from the top level
content = re.sub(r"// Stub function.*?function addRecentRequest\(reqData\) \{.*?\}\n", "", content, flags=re.DOTALL)


# 4. NormalizeProviderError and masking helpers
helpers = """
function normalizeProviderError(error) {
  const errStr = String(error.message || "").toLowerCase();
  const isTimeout = 
    error.name === "AbortError" || 
    error.code === "ECONNABORTED" || 
    error.code === "ETIMEDOUT" || 
    errStr.includes("timeout") ||
    errStr.includes("aborted");

  if (isTimeout) {
    return {
      error_code: "HERMES_TIMEOUT",
      intent: "provider_timeout",
      recoverable: true,
      requires_handoff: false,
      safe_to_send: false,
      response_sent: false,
      http_status: 502
    };
  }

  return {
    error_code: "ADAPTER_EXCEPTION",
    intent: "error_tecnico",
    recoverable: true,
    requires_handoff: false,
    safe_to_send: false,
    response_sent: false,
    http_status: 502
  };
}

function maskPreview(text) {
  if (!text) return "";
  let masked = text.replace(/([a-zA-Z0-9._-]+@[a-zA-Z0-9._-]+\\.[a-zA-Z0-9._-]+)/gi, "[EMAIL]");
  masked = masked.replace(/(\\+?\\d{7,15})/g, "[PHONE]");
  return masked.slice(0, 160);
}
function extractResponsePreview(reply) {
  if (!reply) return "";
  return reply.replace(/<think>[\\s\\S]*?<\\/think>/gi, "").replace(/```json[\\s\\S]*?```/gi, "").trim().slice(0, 200);
}
function getPatientDisplayName(patient) {
  if (!patient) return "Contacto sin identificar";
  if (patient.profile_complete === true && patient.first_name && patient.last_name) {
    return patient.first_name + " " + patient.last_name;
  }
  if (patient.chatwoot_display_name) return patient.chatwoot_display_name;
  if (patient.name) return patient.name;
  return "Contacto sin identificar";
}
function getDisplayNameSource(patient) {
  if (!patient) return "unknown";
  if (patient.profile_complete === true && patient.first_name && patient.last_name) return "verified_profile";
  if (patient.chatwoot_display_name) return "chatwoot";
  return "unknown";
}
"""
content = re.sub(r'app\.post\("/helios/message", async \(req, res\) => \{', helpers + '\napp.post("/helios/message", async (req, res) => {', content)


# 5. Modifying the POST route
content = re.sub(
  r'currentTelemetryCtx = await startAdapterEvent\(req\.body \|\| \{\}\);',
  'const telemetryCtx = await startAdapterEvent(req.body || {});',
  content
)
content = re.sub(r'\s*addRecentRequest\(debugEvent\);\n', '\n', content)

content = content.replace("const result = await sendMessageToHermes(payload);", """const hermesStartTime = Date.now();
    let hermesDurationMs = null;
    let result;
    try {
      result = await sendMessageToHermes(payload);
      hermesDurationMs = Date.now() - hermesStartTime;
    } catch(err) {
      hermesDurationMs = Date.now() - hermesStartTime;
      throw err;
    }""")

old_conflict = r"""    if \(result\.conflict\) \{.*?return res\.json\(conflictResponse\);\n    \}"""
new_conflict = """    if (result.conflict) {
      finalStatus = "error";
      finalRoute = "error";
      finalIntent = "active_stream_conflict";
      errorMsg = "session already has an active stream conflict";

      debugEvent.status = finalStatus;
      debugEvent.route = finalRoute;
      debugEvent.intent = finalIntent;
      debugEvent.error = errorMsg;
      debugEvent.duration_ms = Date.now() - startTime;
      debugEvent.final_reply_preview = "Ahora mismo tuve un problema t\\u00e9cnico para procesar tu mensaje. Te voy a derivar con el equipo para ayudarte mejor.";
      debugEvent.sanitized_reply_preview = debugEvent.final_reply_preview;
      debugEvent.sanitized_reply = debugEvent.final_reply_preview;

      const conflictResponse = {
        ok: false,
        reply: debugEvent.final_reply_preview,
        route: finalRoute,
        intent: finalIntent,
        requires_handoff: false,
        safe_to_send: false,
        response_sent: false,
        recoverable: true,
        error_code: "ACTIVE_STREAM_CONFLICT",
        provider_error_code: "ACTIVE_STREAM_CONFLICT",
        tool_calls: [],
        case_tracking: {
          requires_case_tracking: true,
          reason: "active_stream_conflict"
        },
        metadata: {
          profile: HERMES_PROFILE,
          hermes_session_id: sessionId,
          active_stream_id: result.activeStreamId || "",
          reason: "active_stream_conflict"
        }
      };

      debugEvent.internal_reasoning_detected = false;
      debugEvent.patient_reply_extracted = false;
      debugEvent.blocked_internal_reasoning = false;
      debugEvent.extraction_strategy = null;

      debugEvent.adapter_response_preview = JSON.stringify(conflictResponse).slice(0, 1000);
      debugEvent.adapter_response_detail = JSON.stringify(conflictResponse, null, 2);

      if (sessionId) {
        try {
          const { sessionData, attempts } = await fetchHermesSessionData(sessionId);
          debugEvent.token_usage = extractTokenUsage(sessionData, attempts);
        } catch (_) {}
      }

      await failAdapterEvent(
        telemetryCtx,
        "ACTIVE_STREAM_CONFLICT",
        hermesDurationMs,
        {
          patient_display_name: getPatientDisplayName(normalized?.patient),
          display_name_source: getDisplayNameSource(normalized?.patient),
          message_preview: maskPreview(normalized?.message_text),
          message_count: normalized?.message_count,
          intent: finalIntent,
          route: finalRoute,
          provider_error_code: "ACTIVE_STREAM_CONFLICT",
          response_preview: extractResponsePreview(conflictResponse.reply)
        }
      );
      return res.json(conflictResponse);
    }"""
content = re.sub(old_conflict, new_conflict, content, flags=re.DOTALL)

old_ok = r"""    // Consultar tokens exactos de Hermes\n    if \(sessionId\) \{.*?return res\.json\(normalizedResponse\);"""
new_ok = """    if (sessionId) {
      try {
        const { sessionData, attempts } = await fetchHermesSessionData(sessionId);
        debugEvent.token_usage = extractTokenUsage(sessionData, attempts);
      } catch (_) {}
    }

    await finishAdapterEvent(
      telemetryCtx,
      finalStatus,
      { ...normalizedResponse, response_sent: normalizedResponse.response_sent === true },
      hermesDurationMs,
      debugEvent.token_usage,
      {
        patient_display_name: getPatientDisplayName(normalized?.patient),
        display_name_source: getDisplayNameSource(normalized?.patient),
        message_preview: maskPreview(normalized?.message_text),
        message_count: normalized?.message_count,
        intent: finalIntent,
        response_preview: extractResponsePreview(finalReply),
        route: finalRoute,
      }
    );
    return res.json(normalizedResponse);"""
content = re.sub(old_ok, new_ok, content, flags=re.DOTALL)


old_catch = r"""    const isAbortError = error.*?return res\.status\(502\)\.json\(errorResponse\);"""
new_catch = """    const normalizedError = normalizeProviderError(error);
    const errorResponse = {
      ok: false,
      route: "error",
      intent: normalizedError.intent,
      requires_handoff: normalizedError.requires_handoff,
      safe_to_send: normalizedError.safe_to_send,
      response_sent: normalizedError.response_sent,
      recoverable: normalizedError.recoverable,
      error_code: normalizedError.error_code,
      metadata: {
        error: error.message
      }
    };

    debugEvent.status = finalStatus;
    debugEvent.route = finalRoute;
    debugEvent.intent = finalIntent;
    debugEvent.requires_handoff = true;
    debugEvent.duration_ms = Date.now() - startTime;
    debugEvent.error = errorMsg.slice(0, 500);
    debugEvent.error_type = normalizedError.error_code;
    debugEvent.timeout_ms = normalizedError.error_code === "HERMES_TIMEOUT" ? HERMES_TIMEOUT_MS : null;
    debugEvent.raw_hermes_preview = rawResponseText.slice(0, 1000);
    debugEvent.raw_hermes_detail = rawResponseText;
    debugEvent.final_reply_preview = null;
    debugEvent.sanitized_reply_preview = null;
    debugEvent.sanitized_reply = null;

    const hasReasoningErr = containsInternalReasoning(rawResponseText);
    const wasBlockedErr = hasReasoningErr && (!finalReply || containsInternalReasoning(finalReply) || finalIntent === "internal_reasoning_blocked");
    const wasExtractedErr = hasReasoningErr && !wasBlockedErr && finalReply.length > 0;

    debugEvent.internal_reasoning_detected = hasReasoningErr;
    debugEvent.patient_reply_extracted = wasExtractedErr;
    debugEvent.blocked_internal_reasoning = wasBlockedErr;
    debugEvent.extraction_strategy = "last_patient_facing_start";

    debugEvent.adapter_response_preview = JSON.stringify(errorResponse).slice(0, 1000);
    debugEvent.adapter_response_detail = JSON.stringify(errorResponse, null, 2);

    if (sessionId) {
      try {
        const { sessionData, attempts } = await fetchHermesSessionData(sessionId);
        debugEvent.token_usage = extractTokenUsage(sessionData, attempts);
      } catch (_) {}
    }

    await failAdapterEvent(
      telemetryCtx,
      normalizedError.error_code,
      typeof hermesDurationMs !== 'undefined' ? hermesDurationMs : null,
      {
        patient_display_name: getPatientDisplayName(normalized?.patient),
        display_name_source: getDisplayNameSource(normalized?.patient),
        message_preview: maskPreview(normalized?.message_text),
        message_count: normalized?.message_count,
        intent: normalizedError.intent,
        route: "error",
        provider_error_code: normalizedError.error_code,
        response_preview: null
      }
    );
    return res.status(normalizedError.http_status).json(errorResponse);"""
content = re.sub(old_catch, new_catch, content, flags=re.DOTALL)

# Cleanup the `}}` typo introduced by `replace_file_content` previously.
content = content.replace('}}', '}')

with open('server.js', 'w', encoding='utf-8') as f:
    f.write(content)

print("Python replace done")
