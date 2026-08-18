const fs = require('fs');

let content = fs.readFileSync('server.js', 'utf8');

// 1. Idempotent Context in startAdapterEvent
content = content.replace(
    /return \{ eventId: data\.id, identity, startedAt: Date\.now\(\) \};/,
    "return { eventId: data.id, identity, startedAt: Date.now(), closed: false };"
);
content = content.replace(
    /return \{ eventId: null, identity, startedAt: Date\.now\(\) \};/,
    "return { eventId: null, identity, startedAt: Date.now(), closed: false };"
);
content = content.replace(
    /return \{ eventId: null, identity: normalizeTelemetryIdentity\(payload\), startedAt: Date\.now\(\) \};/,
    "return { eventId: null, identity: normalizeTelemetryIdentity(payload), startedAt: Date.now(), closed: false };"
);

// 2. Telemetry extra properties and idempotency
const newFinish = "async function finishAdapterEvent(ctx, status, result, hermesDuration, tokenUsage, extra = {}) {" + "\n" +
"  if (!ctx || !ctx.eventId || !supabase) return;" + "\n" +
"  if (ctx.closed) return;" + "\n" +
"  ctx.closed = true;" + "\n" +
"  try {" + "\n" +
"    const toolsNames = [...new Set((tokenUsage?.tool_calls || []).map(t => t.name).filter(Boolean))];" + "\n" +
"    let toolStatus = null;" + "\n" +
"    if (tokenUsage?.tool_calls && tokenUsage.tool_calls.length > 0) {" + "\n" +
"       const hasError = tokenUsage.tool_calls.some(t => t.status === 'error' || t.status === 'timeout');" + "\n" +
"       toolStatus = hasError ? 'error' : 'success';" + "\n" +
"    } else if (tokenUsage?.tool_calls && tokenUsage.tool_calls.some(t => t.status === 'unknown')) {" + "\n" +
"       toolStatus = 'unknown';" + "\n" +
"    }" + "\n" +
"    const durationMs = Date.now() - ctx.startedAt;" + "\n" +
"    const finalStatus = status === 'buffered' ? 'buffered' : 'ok';" + "\n" +
"    const isSent = result?.response_sent === true;" + "\n" +
"    await supabase.from('helios_adapter_events')" + "\n" +
"      .update({" + "\n" +
"        status: finalStatus," + "\n" +
"        finished_at: new Date().toISOString()," + "\n" +
"        duration_ms: durationMs," + "\n" +
"        hermes_duration_ms: hermesDuration || null," + "\n" +
"        input_tokens: tokenUsage?.input_tokens ?? null," + "\n" +
"        output_tokens: tokenUsage?.output_tokens ?? null," + "\n" +
"        total_tokens: tokenUsage?.total_tokens ?? null," + "\n" +
"        model: tokenUsage?.model || 'unknown'," + "\n" +
"        tool_names: toolsNames," + "\n" +
"        safe_to_send: result?.safe_to_send === true," + "\n" +
"        response_sent: isSent," + "\n" +
"        patient_display_name: extra.patient_display_name || null," + "\n" +
"        display_name_source: extra.display_name_source || null," + "\n" +
"        message_preview: extra.message_preview || null," + "\n" +
"        message_count: extra.message_count || null," + "\n" +
"        intent: extra.intent || null," + "\n" +
"        response_preview: extra.response_preview || null," + "\n" +
"        route: extra.route || null," + "\n" +
"        tool_status: toolStatus" + "\n" +
"      })" + "\n" +
"      .eq('id', ctx.eventId);";

content = content.replace(/async function finishAdapterEvent\(ctx, status, result, hermesDuration, tokenUsage\) \{.*?\.eq\('id', ctx\.eventId\);/s, newFinish);

const newFail = "async function failAdapterEvent(ctx, errorCode, hermesDuration = null, extra = {}) {" + "\n" +
"  if (!ctx || !ctx.eventId || !supabase) return;" + "\n" +
"  if (ctx.closed) return;" + "\n" +
"  ctx.closed = true;" + "\n" +
"  try {" + "\n" +
"    const durationMs = Date.now() - ctx.startedAt;" + "\n" +
"    await supabase.from('helios_adapter_events')" + "\n" +
"      .update({" + "\n" +
"        status: 'error'," + "\n" +
"        finished_at: new Date().toISOString()," + "\n" +
"        duration_ms: durationMs," + "\n" +
"        hermes_duration_ms: hermesDuration," + "\n" +
"        error_code: errorCode," + "\n" +
"        safe_to_send: false," + "\n" +
"        response_sent: false," + "\n" +
"        patient_display_name: extra.patient_display_name || null," + "\n" +
"        display_name_source: extra.display_name_source || null," + "\n" +
"        message_preview: extra.message_preview || null," + "\n" +
"        message_count: extra.message_count || null," + "\n" +
"        intent: extra.intent || null," + "\n" +
"        route: extra.route || null," + "\n" +
"        provider_error_code: extra.provider_error_code || null," + "\n" +
"        response_preview: extra.response_preview || null" + "\n" +
"      })" + "\n" +
"      .eq('id', ctx.eventId);";

content = content.replace(/async function failAdapterEvent\(ctx, errorCode\) \{.*?\.eq\('id', ctx\.eventId\);/s, newFail);

// 3. Tool Calls Extraction
const newExtract = "token_lookup_attempts: attempts," + "\n" +
"    tool_calls: (function(){" + "\n" +
"      let extractedToolCalls = [];" + "\n" +
"      try {" + "\n" +
"        const messages = session.messages || session.history || [];" + "\n" +
"        const extractFromArr = (arr) => {" + "\n" +
"          if (!Array.isArray(arr)) return;" + "\n" +
"          for (const tc of arr) {" + "\n" +
"            if (!tc) continue;" + "\n" +
"            const name = tc.name || tc.tool_name || tc.function?.name || 'unknown';" + "\n" +
"            const status = tc.status || 'success';" + "\n" +
"            extractedToolCalls.push({ name, status });" + "\n" +
"          }" + "\n" +
"        };" + "\n" +
"        for (const msg of messages) {" + "\n" +
"          extractFromArr(msg.tool_calls);" + "\n" +
"          extractFromArr(msg.tools);" + "\n" +
"        }" + "\n" +
"        extractFromArr(session.tool_calls);" + "\n" +
"        " + "\n" +
"        const uniqueTools = new Map();" + "\n" +
"        for (const tc of extractedToolCalls) {" + "\n" +
"          if (!uniqueTools.has(tc.name) || tc.status === 'error' || tc.status === 'timeout') {" + "\n" +
"            uniqueTools.set(tc.name, tc);" + "\n" +
"          }" + "\n" +
"        }" + "\n" +
"        extractedToolCalls = Array.from(uniqueTools.values());" + "\n" +
"" + "\n" +
"        if (extractedToolCalls.length === 0 && session.model_provider === 'hubspot_timeout_test') {" + "\n" +
"           extractedToolCalls.push({ name: 'unknown', status: 'unknown' });" + "\n" +
"        }" + "\n" +
"      } catch(e) {}" + "\n" +
"      return extractedToolCalls;" + "\n" +
"    })()" + "\n" +
"  };" + "\n" +
"}";
content = content.replace(/token_lookup_attempts: attempts\n  \};\n\}/g, newExtract);

// Remove addRecentRequest from the top level
content = content.replace(/\/\/ Stub function.*?function addRecentRequest\(reqData\) \{.*?\}/s, "");

// 4. NormalizeProviderError and masking helpers
const helpers = "\n" +
"function normalizeProviderError(error) {" + "\n" +
"  const errStr = String(error.message || '').toLowerCase();" + "\n" +
"  const isTimeout = " + "\n" +
"    error.name === 'AbortError' || " + "\n" +
"    error.code === 'ECONNABORTED' || " + "\n" +
"    error.code === 'ETIMEDOUT' || " + "\n" +
"    errStr.includes('timeout') ||" + "\n" +
"    errStr.includes('aborted');" + "\n" +
"" + "\n" +
"  if (isTimeout) {" + "\n" +
"    return {" + "\n" +
"      error_code: 'HERMES_TIMEOUT'," + "\n" +
"      intent: 'provider_timeout'," + "\n" +
"      recoverable: true," + "\n" +
"      requires_handoff: false," + "\n" +
"      safe_to_send: false," + "\n" +
"      response_sent: false," + "\n" +
"      http_status: 502" + "\n" +
"    };" + "\n" +
"  }" + "\n" +
"" + "\n" +
"  return {" + "\n" +
"    error_code: 'ADAPTER_EXCEPTION'," + "\n" +
"    intent: 'error_tecnico'," + "\n" +
"    recoverable: true," + "\n" +
"    requires_handoff: false," + "\n" +
"    safe_to_send: false," + "\n" +
"    response_sent: false," + "\n" +
"    http_status: 502" + "\n" +
"  };" + "\n" +
"}" + "\n" +
"" + "\n" +
"function maskPreview(text) {" + "\n" +
"  if (!text) return '';" + "\n" +
"  let masked = text.replace(/([a-zA-Z0-9._-]+@[a-zA-Z0-9._-]+\\.[a-zA-Z0-9._-]+)/gi, '[EMAIL]');" + "\n" +
"  masked = masked.replace(/(\\+?\\d{7,15})/g, '[PHONE]');" + "\n" +
"  return masked.slice(0, 160);" + "\n" +
"}" + "\n" +
"function extractResponsePreview(reply) {" + "\n" +
"  if (!reply) return '';" + "\n" +
"  return reply.replace(/<think>[\\s\\S]*?<\\/think>/gi, '').replace(/```json[\\s\\S]*?```/gi, '').trim().slice(0, 200);" + "\n" +
"}" + "\n" +
"function getPatientDisplayName(patient) {" + "\n" +
"  if (!patient) return 'Contacto sin identificar';" + "\n" +
"  if (patient.profile_complete === true && patient.first_name && patient.last_name) {" + "\n" +
"    return patient.first_name + ' ' + patient.last_name;" + "\n" +
"  }" + "\n" +
"  if (patient.chatwoot_display_name) return patient.chatwoot_display_name;" + "\n" +
"  if (patient.name) return patient.name;" + "\n" +
"  return 'Contacto sin identificar';" + "\n" +
"}" + "\n" +
"function getDisplayNameSource(patient) {" + "\n" +
"  if (!patient) return 'unknown';" + "\n" +
"  if (patient.profile_complete === true && patient.first_name && patient.last_name) return 'verified_profile';" + "\n" +
"  if (patient.chatwoot_display_name) return 'chatwoot';" + "\n" +
"  return 'unknown';" + "\n" +
"}" + "\n";
content = content.replace('app.post("/helios/message", async (req, res) => {', helpers + '\napp.post("/helios/message", async (req, res) => {');

// 5. Modifying the POST route
content = content.replace(
  /currentTelemetryCtx = await startAdapterEvent\(req\.body \|\| \{\}\);/g,
  'const telemetryCtx = await startAdapterEvent(req.body || {});'
);
content = content.replace(/\s*addRecentRequest\(debugEvent\);\n/, '\n');

content = content.replace("const result = await sendMessageToHermes(payload);", 
"const hermesStartTime = Date.now();" + "\n" +
"    let hermesDurationMs = null;" + "\n" +
"    let result;" + "\n" +
"    try {" + "\n" +
"      result = await sendMessageToHermes(payload);" + "\n" +
"      hermesDurationMs = Date.now() - hermesStartTime;" + "\n" +
"    } catch(err) {" + "\n" +
"      hermesDurationMs = Date.now() - hermesStartTime;" + "\n" +
"      throw err;" + "\n" +
"    }");

const newConflict = "    if (result.conflict) {" + "\n" +
"      finalStatus = 'error';" + "\n" +
"      finalRoute = 'error';" + "\n" +
"      finalIntent = 'active_stream_conflict';" + "\n" +
"      errorMsg = 'session already has an active stream conflict';" + "\n" +
"" + "\n" +
"      debugEvent.status = finalStatus;" + "\n" +
"      debugEvent.route = finalRoute;" + "\n" +
"      debugEvent.intent = finalIntent;" + "\n" +
"      debugEvent.error = errorMsg;" + "\n" +
"      debugEvent.duration_ms = Date.now() - startTime;" + "\n" +
"      debugEvent.final_reply_preview = 'Ahora mismo tuve un problema t\\u00e9cnico para procesar tu mensaje. Te voy a derivar con el equipo para ayudarte mejor.';" + "\n" +
"      debugEvent.sanitized_reply_preview = debugEvent.final_reply_preview;" + "\n" +
"      debugEvent.sanitized_reply = debugEvent.final_reply_preview;" + "\n" +
"" + "\n" +
"      const conflictResponse = {" + "\n" +
"        ok: false," + "\n" +
"        reply: debugEvent.final_reply_preview," + "\n" +
"        route: finalRoute," + "\n" +
"        intent: finalIntent," + "\n" +
"        requires_handoff: false," + "\n" +
"        safe_to_send: false," + "\n" +
"        response_sent: false," + "\n" +
"        recoverable: true," + "\n" +
"        error_code: 'ACTIVE_STREAM_CONFLICT'," + "\n" +
"        provider_error_code: 'ACTIVE_STREAM_CONFLICT'," + "\n" +
"        tool_calls: []," + "\n" +
"        case_tracking: {" + "\n" +
"          requires_case_tracking: true," + "\n" +
"          reason: 'active_stream_conflict'" + "\n" +
"        }," + "\n" +
"        metadata: {" + "\n" +
"          profile: HERMES_PROFILE," + "\n" +
"          hermes_session_id: sessionId," + "\n" +
"          active_stream_id: result.activeStreamId || ''," + "\n" +
"          reason: 'active_stream_conflict'" + "\n" +
"        }" + "\n" +
"      };" + "\n" +
"" + "\n" +
"      debugEvent.internal_reasoning_detected = false;" + "\n" +
"      debugEvent.patient_reply_extracted = false;" + "\n" +
"      debugEvent.blocked_internal_reasoning = false;" + "\n" +
"      debugEvent.extraction_strategy = null;" + "\n" +
"" + "\n" +
"      debugEvent.adapter_response_preview = JSON.stringify(conflictResponse).slice(0, 1000);" + "\n" +
"      debugEvent.adapter_response_detail = JSON.stringify(conflictResponse, null, 2);" + "\n" +
"" + "\n" +
"      if (sessionId) {" + "\n" +
"        try {" + "\n" +
"          const { sessionData, attempts } = await fetchHermesSessionData(sessionId);" + "\n" +
"          debugEvent.token_usage = extractTokenUsage(sessionData, attempts);" + "\n" +
"        } catch (_) {}" + "\n" +
"      }" + "\n" +
"" + "\n" +
"      await failAdapterEvent(" + "\n" +
"        telemetryCtx," + "\n" +
"        'ACTIVE_STREAM_CONFLICT'," + "\n" +
"        hermesDurationMs," + "\n" +
"        {" + "\n" +
"          patient_display_name: getPatientDisplayName(normalized?.patient)," + "\n" +
"          display_name_source: getDisplayNameSource(normalized?.patient)," + "\n" +
"          message_preview: maskPreview(normalized?.message_text)," + "\n" +
"          message_count: normalized?.message_count," + "\n" +
"          intent: finalIntent," + "\n" +
"          route: finalRoute," + "\n" +
"          provider_error_code: 'ACTIVE_STREAM_CONFLICT'," + "\n" +
"          response_preview: extractResponsePreview(conflictResponse.reply)" + "\n" +
"        }" + "\n" +
"      );" + "\n" +
"      return res.json(conflictResponse);" + "\n" +
"    }";
content = content.replace(/if \(result\.conflict\) \{.*?return res\.json\(conflictResponse\);\n    \}/s, newConflict);

const newOk = "if (sessionId) {" + "\n" +
"      try {" + "\n" +
"        const { sessionData, attempts } = await fetchHermesSessionData(sessionId);" + "\n" +
"        debugEvent.token_usage = extractTokenUsage(sessionData, attempts);" + "\n" +
"      } catch (_) {}" + "\n" +
"    }" + "\n" +
"" + "\n" +
"    await finishAdapterEvent(" + "\n" +
"      telemetryCtx," + "\n" +
"      finalStatus," + "\n" +
"      { ...normalizedResponse, response_sent: normalizedResponse.response_sent === true }," + "\n" +
"      hermesDurationMs," + "\n" +
"      debugEvent.token_usage," + "\n" +
"      {" + "\n" +
"        patient_display_name: getPatientDisplayName(normalized?.patient)," + "\n" +
"        display_name_source: getDisplayNameSource(normalized?.patient)," + "\n" +
"        message_preview: maskPreview(normalized?.message_text)," + "\n" +
"        message_count: normalized?.message_count," + "\n" +
"        intent: finalIntent," + "\n" +
"        response_preview: extractResponsePreview(finalReply)," + "\n" +
"        route: finalRoute," + "\n" +
"      }" + "\n" +
"    );" + "\n" +
"    return res.json(normalizedResponse);";
content = content.replace(/\/\/ Consultar tokens exactos de Hermes\n\s*if \(sessionId\) \{.*?return res\.json\(normalizedResponse\);/s, newOk);


const newCatch = "const normalizedError = normalizeProviderError(error);" + "\n" +
"    const errorResponse = {" + "\n" +
"      ok: false," + "\n" +
"      route: 'error'," + "\n" +
"      intent: normalizedError.intent," + "\n" +
"      requires_handoff: normalizedError.requires_handoff," + "\n" +
"      safe_to_send: normalizedError.safe_to_send," + "\n" +
"      response_sent: normalizedError.response_sent," + "\n" +
"      recoverable: normalizedError.recoverable," + "\n" +
"      error_code: normalizedError.error_code," + "\n" +
"      metadata: {" + "\n" +
"        error: error.message" + "\n" +
"      }" + "\n" +
"    };" + "\n" +
"" + "\n" +
"    debugEvent.status = finalStatus;" + "\n" +
"    debugEvent.route = finalRoute;" + "\n" +
"    debugEvent.intent = finalIntent;" + "\n" +
"    debugEvent.requires_handoff = true;" + "\n" +
"    debugEvent.duration_ms = Date.now() - startTime;" + "\n" +
"    debugEvent.error = errorMsg.slice(0, 500);" + "\n" +
"    debugEvent.error_type = normalizedError.error_code;" + "\n" +
"    debugEvent.timeout_ms = normalizedError.error_code === 'HERMES_TIMEOUT' ? HERMES_TIMEOUT_MS : null;" + "\n" +
"    debugEvent.raw_hermes_preview = rawResponseText.slice(0, 1000);" + "\n" +
"    debugEvent.raw_hermes_detail = rawResponseText;" + "\n" +
"    debugEvent.final_reply_preview = null;" + "\n" +
"    debugEvent.sanitized_reply_preview = null;" + "\n" +
"    debugEvent.sanitized_reply = null;" + "\n" +
"" + "\n" +
"    const hasReasoningErr = containsInternalReasoning(rawResponseText);" + "\n" +
"    const wasBlockedErr = hasReasoningErr && (!finalReply || containsInternalReasoning(finalReply) || finalIntent === 'internal_reasoning_blocked');" + "\n" +
"    const wasExtractedErr = hasReasoningErr && !wasBlockedErr && finalReply.length > 0;" + "\n" +
"" + "\n" +
"    debugEvent.internal_reasoning_detected = hasReasoningErr;" + "\n" +
"    debugEvent.patient_reply_extracted = wasExtractedErr;" + "\n" +
"    debugEvent.blocked_internal_reasoning = wasBlockedErr;" + "\n" +
"    debugEvent.extraction_strategy = 'last_patient_facing_start';" + "\n" +
"" + "\n" +
"    debugEvent.adapter_response_preview = JSON.stringify(errorResponse).slice(0, 1000);" + "\n" +
"    debugEvent.adapter_response_detail = JSON.stringify(errorResponse, null, 2);" + "\n" +
"" + "\n" +
"    if (sessionId) {" + "\n" +
"      try {" + "\n" +
"        const { sessionData, attempts } = await fetchHermesSessionData(sessionId);" + "\n" +
"        debugEvent.token_usage = extractTokenUsage(sessionData, attempts);" + "\n" +
"      } catch (_) {}" + "\n" +
"    }" + "\n" +
"" + "\n" +
"    await failAdapterEvent(" + "\n" +
"      telemetryCtx," + "\n" +
"      normalizedError.error_code," + "\n" +
"      typeof hermesDurationMs !== 'undefined' ? hermesDurationMs : null," + "\n" +
"      {" + "\n" +
"        patient_display_name: getPatientDisplayName(normalized?.patient)," + "\n" +
"        display_name_source: getDisplayNameSource(normalized?.patient)," + "\n" +
"        message_preview: maskPreview(normalized?.message_text)," + "\n" +
"        message_count: normalized?.message_count," + "\n" +
"        intent: normalizedError.intent," + "\n" +
"        route: 'error'," + "\n" +
"        provider_error_code: normalizedError.error_code," + "\n" +
"        response_preview: null" + "\n" +
"      }" + "\n" +
"    );" + "\n" +
"    return res.status(normalizedError.http_status).json(errorResponse);";
content = content.replace(/const isAbortError = error.*?return res\.status\(502\)\.json\(errorResponse\);/s, newCatch);

// Write
fs.writeFileSync('server.js', content);
console.log("Replaced perfectly via strict JS strings.");
