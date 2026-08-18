const fs = require('fs');

const file = 'server.js';
let content = fs.readFileSync(file, 'utf8');

// 1. Añadir dependencias al inicio
if (!content.includes("@supabase/supabase-js")) {
  const requires = `const express = require("express");
const fs = require("fs");
const crypto = require("crypto");
const { createClient } = require('@supabase/supabase-js');
const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
let supabase = null;
if (SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY) {
  supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
}
`;
  content = content.replace(/const express = require\("express"\);\r?\nconst fs = require\("fs"\);\r?\nconst crypto = require\("crypto"\);/, requires);
}

// 2. Reemplazar recentRequests / addRecentRequest con nuevas funciones de DB
const addRecentRequestRegex = /const recentRequests = \[\];\r?\n\r?\nfunction addRecentRequest\(reqData\) {[\s\S]*?}\r?\n/;
const telemetryFuncs = `
function normalizeTelemetryIdentity(payload) {
  const traceId = payload?.metadata?.trace_id || payload?.trace_id || crypto.randomUUID();
  const tenantId = payload?.tenant_id;
  const conversationId = payload?.conversation?.conversation_id || payload?.conversation_id;
  const contactId = payload?.conversation?.contact_id || payload?.contact_id;
  
  const incomplete = !tenantId || !conversationId || !contactId;
  
  if (incomplete) {
    console.warn(\`[Adapter] TELEMETRY_IDENTITY_INCOMPLETE: traceId=\${traceId}\`);
  }
  
  return {
    trace_id: traceId,
    tenant_id: tenantId || 'unknown_tenant',
    conversation_id: conversationId || 'unknown_conversation',
    contact_id: contactId || 'unknown_contact'
  };
}

async function startAdapterEvent(payload) {
  try {
    const identity = normalizeTelemetryIdentity(payload);
    
    if (supabase) {
      const { data, error } = await supabase
        .from('helios_adapter_events')
        .insert({
          trace_id: identity.trace_id,
          tenant_id: identity.tenant_id,
          conversation_id: identity.conversation_id,
          contact_id: identity.contact_id,
          status: 'processing',
          started_at: new Date().toISOString()
        })
        .select('id')
        .single();
        
      if (error) throw error;
      return { eventId: data.id, identity, startedAt: Date.now() };
    } else {
       console.warn("[Adapter] Supabase not initialized. Skipping startAdapterEvent.");
       return { eventId: null, identity, startedAt: Date.now() };
    }
  } catch (err) {
    console.error('[Adapter] Fallo al iniciar telemetría:', err.message);
    return { eventId: null, identity: normalizeTelemetryIdentity(payload), startedAt: Date.now() };
  }
}

async function finishAdapterEvent(ctx, status, result, hermesDuration, tokenUsage) {
  if (!ctx || !ctx.eventId || !supabase) return;
  
  try {
    const toolsNames = [...new Set((tokenUsage?.tool_calls || []).map(t => t.name).filter(Boolean))];
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
        response_sent: isSent
      })
      .eq('id', ctx.eventId);
  } catch (err) {
    console.error('[Adapter] Fallo al finalizar telemetría:', err.message);
  }
}

async function failAdapterEvent(ctx, errorCode) {
  if (!ctx || !ctx.eventId || !supabase) return;
  
  try {
    const durationMs = Date.now() - ctx.startedAt;
    await supabase.from('helios_adapter_events')
      .update({
        status: 'error',
        finished_at: new Date().toISOString(),
        duration_ms: durationMs,
        error_code: errorCode,
        safe_to_send: false,
        response_sent: false
      })
      .eq('id', ctx.eventId);
  } catch (err) {
    console.error('[Adapter] Fallo al reportar error en telemetría:', err.message);
  }
}
`;
content = content.replace(addRecentRequestRegex, telemetryFuncs);

// 3. /debug/events refactor
const debugEventsRegex = /app\.get\("\/debug\/events", requireDebugAuth, \(req, res\) => {[\s\S]*?\}\);/;
const debugEventsNew = `app.get("/debug/events", requireDebugAuth, async (req, res) => {
  try {
    if (!supabase) throw new Error("Supabase is not initialized.");
    
    const { status, trace_id, conversation_id, limit = '50' } = req.query;
    
    const allowlistStatus = ['processing', 'ok', 'buffered', 'error'];
    if (status && !allowlistStatus.includes(status)) {
      return res.status(400).json({ error: true, error_code: "INVALID_STATUS_FILTER" });
    }
    
    if (trace_id && trace_id.length > 50) return res.status(400).json({ error: true, error_code: "TRACE_ID_TOO_LONG" });
    if (conversation_id && conversation_id.length > 50) return res.status(400).json({ error: true, error_code: "CONV_ID_TOO_LONG" });
    
    const queryLimit = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 100);

    let query = supabase
      .from('helios_adapter_events')
      .select('trace_id, tenant_id, conversation_id, contact_id, status, started_at, finished_at, duration_ms, hermes_duration_ms, input_tokens, output_tokens, total_tokens, model, tool_names, attempt_count, safe_to_send, response_sent, error_code')
      .order('created_at', { ascending: false })
      .limit(queryLimit);

    if (status) query = query.eq('status', status);
    if (trace_id) query = query.eq('trace_id', trace_id);
    if (conversation_id) query = query.eq('conversation_id', conversation_id);

    const { data, error } = await query;
    if (error) {
      console.error("[Dashboard] Supabase Query Error:", error.message);
      return res.status(500).json({ error: true, error_code: "ADAPTER_EVENTS_QUERY_FAILED" });
    }

    res.json({ count: data.length, events: data });
  } catch (err) {
    console.error("[Dashboard] Exception:", err.message);
    res.status(500).json({ error: true, error_code: "ADAPTER_EVENTS_QUERY_FAILED" });
  }
});`;
content = content.replace(debugEventsRegex, debugEventsNew);

// 4. Refactor normalizeAdapterResponse
const oldNormalizeContent = `function normalizeAdapterResponse(result) {
  let parsedJson = null;
  let rawReply = "";

  if (typeof result === "object" && result !== null) {
    parsedJson = result;
  } else if (typeof result === "string") {
    rawReply = result;
    try {
      parsedJson = JSON.parse(result);
    } catch (_) {}
  }

  let finalReply = sanitizePatientReply(
    parsedJson && (parsedJson.reply_text || parsedJson.reply)
      ? parsedJson.reply_text || parsedJson.reply
      : rawReply
  );

  const textToLower = finalReply.toLowerCase();
  if (
    textToLower.includes("perfil sigue incompleto") ||
    textToLower.includes("display_name") ||
    textToLower.includes("según las reglas") ||
    textToLower.includes("mensaje de la misma conversación") ||
    containsInternalReasoning(finalReply) ||
    textToLower.includes("razonamiento") ||
    textToLower.includes("\`\`\`json") ||
    textToLower.includes("tool")
  ) {
    return {
      ok: false,
      reply: finalReply,
      route: "error",
      intent: "invalid_client_message",
      profile_patch: null,
      state_patch: null,
      tool_calls: [],
      requires_handoff: false,
      safe_to_send: false,
      response_sent: false,
      error_code: "INVALID_CLIENT_MESSAGE"
    };
  }

  return {
    ok: true,
    reply: finalReply,
    route: parsedJson?.route || "hermes",
    intent: parsedJson?.intent || "respuesta_hermes",
    profile_patch: parsedJson?.profile_patch || null,
    state_patch: parsedJson?.state_patch || null,
    tool_calls: parsedJson?.tool_calls || [],
    requires_handoff: parsedJson?.requires_handoff === true,
    safe_to_send: parsedJson?.safe_to_send === true,
    response_sent: parsedJson?.response_sent === true
  };
}`;
const newNormalizeContent = `function normalizeAdapterResponse(result) {
  let parsedJson = null;

  if (typeof result === "object" && result !== null) {
    parsedJson = result;
  } else if (typeof result === "string") {
    try {
      parsedJson = JSON.parse(result);
    } catch (_) {}
  }

  let messageForClient = parsedJson && typeof parsedJson.message_for_client === "string" 
    ? parsedJson.message_for_client.trim() 
    : "";

  if (!messageForClient && parsedJson && typeof parsedJson.reply_text === "string") {
    messageForClient = parsedJson.reply_text.trim();
  }
  
  if (!messageForClient && parsedJson && typeof parsedJson.reply === "string") {
    messageForClient = parsedJson.reply.trim();
  }

  if (!messageForClient) {
    return {
      ok: false,
      reply: "",
      route: "error",
      intent: "invalid_client_message",
      profile_patch: null,
      state_patch: null,
      tool_calls: [],
      requires_handoff: false,
      safe_to_send: false,
      response_sent: false,
      error_code: "INVALID_CLIENT_MESSAGE"
    };
  }

  messageForClient = sanitizePatientReply(messageForClient);

  const forbiddenPhrases = [
    "perfil sigue incompleto", "display_name", "según las reglas",
    "mensaje de la misma conversación", "razonamiento", "tool", "\`\`\`json"
  ];
  const textToLower = messageForClient.toLowerCase();
  
  if (forbiddenPhrases.some(phrase => textToLower.includes(phrase)) || containsInternalReasoning(messageForClient)) {
    return {
      ok: false,
      reply: "", 
      route: "error",
      intent: "invalid_client_message",
      profile_patch: null,
      state_patch: null,
      tool_calls: [],
      requires_handoff: false,
      safe_to_send: false,
      response_sent: false,
      error_code: "INVALID_CLIENT_MESSAGE"
    };
  }

  return {
    ok: true,
    reply: messageForClient,
    route: parsedJson?.route || "hermes",
    intent: parsedJson?.intent || "respuesta_hermes",
    profile_patch: parsedJson?.profile_patch || null,
    state_patch: parsedJson?.state_patch || null,
    tool_calls: parsedJson?.tool_calls || [],
    requires_handoff: parsedJson?.requires_handoff === true,
    safe_to_send: parsedJson?.safe_to_send === true,
    response_sent: parsedJson?.response_sent === true
  };
}`;
if (content.includes("function normalizeAdapterResponse(result)")) {
   // Regular replace might fail if the function changed slightly, so let's use a regex replace for the whole function
   const normalizeRegex = /function normalizeAdapterResponse\(result\) \{[\s\S]*?\n\}\n/g;
   // Let's check if we can find it
   const match = content.match(/function normalizeAdapterResponse\(result\) \{[\s\S]*?\n\}/);
   if (match) {
     content = content.replace(match[0], newNormalizeContent);
   } else {
     console.error("Could not find normalizeAdapterResponse function to replace!");
   }
}

// 5. Replace addRecentRequest calls with finishAdapterEvent, etc.
// In processRequest, we need to inject startAdapterEvent and finish/failAdapterEvent.
// Since processRequest is huge and complex, we'll write a more precise injection.

// Replace processRequest signature and initial tracking
const processRegex = /async function processRequest\(payload\) {[\s\S]*?const trace_id = payload\.trace_id \|\| payload\.metadata\?\.trace_id \|\| crypto\.randomUUID\(\);/m;
const newProcessStart = `async function processRequest(payload) {
  const telemetryCtx = await startAdapterEvent(payload);
  const trace_id = telemetryCtx.identity.trace_id;`;

if (processRegex.test(content)) {
  content = content.replace(processRegex, newProcessStart);
} else {
  console.error("Could not find processRequest start signature!");
}

// Instead of rewriting the whole logic of addRecentRequest, we can define a proxy addRecentRequest that redirects to finish/fail
// No, the user said "Replace addRecentRequest". Let's define the proxy if it's easier, or replace the actual calls.
// Where is addRecentRequest used?
// Line 2561: addRecentRequest(debugEvent);
// Let's replace addRecentRequest(debugEvent) with finishAdapterEvent(telemetryCtx, status, result, hermesDuration, debugEvent.token_usage)
// Wait, `debugEvent` has `status`, `decision`, `token_usage`, `actionsExecuted`.
// So we can do:
const debugEventReplace = /addRecentRequest\(debugEvent\);/g;
const newDebugEventCall = `
  let finalStatus = 'ok';
  if (debugEvent.decision === 'error') finalStatus = 'error';
  else if (debugEvent.decision === 'buffered' || debugEvent.decision === 'processing') finalStatus = 'buffered';
  
  if (finalStatus === 'error') {
     await failAdapterEvent(telemetryCtx, debugEvent.error_code || 'UNKNOWN_ERROR');
  } else {
     let mockResult = { safe_to_send: false, response_sent: false };
     if (debugEvent.normalizedPayload) {
        mockResult.safe_to_send = true; 
        const replyAction = debugEvent.actionsExecuted?.find(a => a.action === 'reply_sent_to_chatwoot' || a.action === 'tool:chatwoot.send_message');
        if (replyAction && replyAction.success) mockResult.response_sent = true;
     }
     await finishAdapterEvent(telemetryCtx, finalStatus, mockResult, null, debugEvent.token_usage);
  }
`;
content = content.replace(debugEventReplace, newDebugEventCall);

fs.writeFileSync(file, content);
console.log('Update complete.');
