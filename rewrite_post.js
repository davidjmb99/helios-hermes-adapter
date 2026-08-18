const fs = require('fs');

let content = fs.readFileSync('server.js', 'utf8');

// 1. Modify telemetry functions
content = content.replace(
  'async function finishAdapterEvent(ctx, status, result, hermesDuration, tokenUsage) {',
  \`async function finishAdapterEvent(ctx, status, result, hermesDuration, tokenUsage, extra = {}) {
  if (!ctx || !ctx.eventId || !supabase) return;
  try {
    const toolsNames = [...new Set((tokenUsage?.tool_calls || []).map(t => t.name).filter(Boolean))];
    let toolStatus = null;
    if (tokenUsage?.tool_calls && tokenUsage.tool_calls.length > 0) {
       const hasError = tokenUsage.tool_calls.some(t => t.status === 'error' || t.status === 'timeout');
       toolStatus = hasError ? 'error' : 'success';
    }

    const durationMs = Date.now() - ctx.startedAt;
    const finalStatus = status === 'buffered' ? 'buffered' : 'ok';
    const isSent = finalStatus === 'ok' && result?.response_sent === true;
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
      .eq('id', ctx.eventId);
  } catch (err) {
    console.error('[Adapter] Fallo al finalizar telemetría:', err.message);
  }
}
function NOOP_1() {\`
);

content = content.replace(
  'async function failAdapterEvent(ctx, errorCode) {',
  \`async function failAdapterEvent(ctx, errorCode, hermesDuration = null, extra = {}) {
  if (!ctx || !ctx.eventId || !supabase) return;
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
      .eq('id', ctx.eventId);
  } catch (err) {
    console.error('[Adapter] Fallo al reportar error en telemetría:', err.message);
  }
}
function NOOP_2() {\`
);

// Remove NOOPs
content = content.replace(/function NOOP_1\(\) {[\s\S]*?async function failAdapterEvent/, 'async function failAdapterEvent');
content = content.replace(/function NOOP_2\(\) {[\s\S]*?function loadSessionMap\(\) {/, 'function loadSessionMap() {');


// 2. Remove addRecentRequest entirely
content = content.replace(
  /let currentTelemetryCtx = null;[\s\S]*?function addRecentRequest\(reqData\) \{[\s\S]*?finishAdapterEvent\(currentTelemetryCtx, finalStatus, mockResult, reqData\.duration_ms, reqData\.token_usage\);\r?\n   \}\r?\n\}/,
  ''
);

// 3. Fix extractTokenUsage
content = content.replace(
  /token_lookup_attempts: attempts\r?\n  \};\r?\n\}/,
  \`token_lookup_attempts: attempts,
    tool_calls: (function(){
      let arr = [];
      try {
        const msgs = (sessionData.session || sessionData).messages || (sessionData.session || sessionData).history || [];
        for (const m of msgs) {
          if (m.tool_calls && Array.isArray(m.tool_calls)) m.tool_calls.forEach(tc => arr.push({name: tc.name || tc.tool_name || tc.function?.name, status: tc.status || 'success'}));
          if (m.tools && Array.isArray(m.tools)) m.tools.forEach(tc => arr.push({name: tc.name || tc.tool_name || tc.function?.name, status: tc.status || 'success'}));
        }
      }catch(e){}
      return arr;
    })()
  };
}\`
);


// 4. Update the POST route
content = content.replace(
  'currentTelemetryCtx = await startAdapterEvent(req.body || {});',
  'const telemetryCtx = await startAdapterEvent(req.body || {});'
);

content = content.replace(
  '  addRecentRequest(debugEvent);\n',
  ''
);

const oldConflict = 'return res.json(conflictResponse);';
const newConflict = \`await finishAdapterEvent(
      telemetryCtx,
      "handoff",
      conflictResponse,
      Date.now() - startTime,
      debugEvent.token_usage,
      {
        patient_display_name: normalized?.patient?.name,
        display_name_source: normalized?.patient?.chatwoot_display_name,
        message_preview: normalized?.message_text?.slice(0, 160),
        message_count: normalized?.message_count,
        intent: finalIntent,
        response_preview: conflictResponse.reply?.slice(0, 200),
        route: finalRoute,
      }
    );
    return res.json(conflictResponse);\`;
content = content.replace(oldConflict, newConflict);

const oldOk = 'return res.json(normalizedResponse);';
const newOk = \`await finishAdapterEvent(
      telemetryCtx,
      finalStatus,
      normalizedResponse,
      Date.now() - startTime,
      debugEvent.token_usage,
      {
        patient_display_name: normalized?.patient?.name,
        display_name_source: normalized?.patient?.chatwoot_display_name,
        message_preview: normalized?.message_text?.slice(0, 160),
        message_count: normalized?.message_count,
        intent: finalIntent,
        response_preview: finalReply?.slice(0, 200),
        route: finalRoute,
      }
    );
    return res.json(normalizedResponse);\`;
content = content.replace(oldOk, newOk);

// Now for the catch block
content = content.replace(
  /debugEvent\.final_reply_preview = "Ahora mismo tuve un problema.*?return res\.status\(\d+\)\.json\(errorResponse\);/s,
  \`debugEvent.final_reply_preview = null;
    debugEvent.sanitized_reply_preview = null;
    debugEvent.sanitized_reply = null;

    let errorResponse = {};
    if (isAbortError) {
      errorResponse = {
        ok: false,
        route: "error",
        intent: "provider_timeout",
        requires_handoff: false,
        safe_to_send: false,
        response_sent: false,
        recoverable: true,
        error_code: "HERMES_TIMEOUT"
      };
    } else {
      errorResponse = {
        ok: false,
        route: "error",
        intent: "error_tecnico",
        requires_handoff: false,
        safe_to_send: false,
        response_sent: false,
        recoverable: true,
        error_code: "ADAPTER_EXCEPTION",
        metadata: {
          error: error.message
        }
      };
    }

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
      isAbortError ? "HERMES_TIMEOUT" : "ADAPTER_EXCEPTION",
      Date.now() - startTime,
      {
        patient_display_name: normalized?.patient?.name,
        display_name_source: normalized?.patient?.chatwoot_display_name,
        message_preview: normalized?.message_text?.slice(0, 160),
        message_count: normalized?.message_count,
        intent: isAbortError ? "provider_timeout" : "error_tecnico",
        route: "error",
        provider_error_code: isAbortError ? "HERMES_TIMEOUT" : null,
      }
    );
    return res.status(isAbortError ? 408 : 502).json(errorResponse);\`
);

fs.writeFileSync('server.js', content);
console.log('Modified server.js completely');
