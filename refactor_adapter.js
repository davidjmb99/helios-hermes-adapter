const fs = require('fs');

let content = fs.readFileSync('server.js', 'utf8');

// 1. Añadir dependencias al inicio
if (!content.includes("@supabase/supabase-js")) {
  content = content.replace(/const express = require\("express"\);\r?\nconst fs = require\("fs"\);\r?\nconst crypto = require\("crypto"\);/,
    `const express = require("express");
const fs = require("fs");
const crypto = require("crypto");
const { createClient } = require('@supabase/supabase-js');
const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
let supabase = null;
if (SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY) {
  supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
}`);
}

// 2. Reemplazar recentRequests / addRecentRequest
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

// Stub function to replace original addRecentRequest so code doesn't break
let currentTelemetryCtx = null;
function addRecentRequest(reqData) {
   // reqData is debugEvent
   let finalStatus = 'ok';
   if (reqData.status === 'error') finalStatus = 'error';
   else if (reqData.status === 'buffered' || reqData.status === 'processing') finalStatus = 'buffered';
   
   if (finalStatus === 'error') {
      failAdapterEvent(currentTelemetryCtx, reqData.error_code || reqData.error_type || 'UNKNOWN_ERROR');
   } else {
      let mockResult = { safe_to_send: false, response_sent: false };
      if (reqData.sanitized_reply && finalStatus === 'ok') {
         mockResult.safe_to_send = true; 
         mockResult.response_sent = true;
      }
      finishAdapterEvent(currentTelemetryCtx, finalStatus, mockResult, reqData.duration_ms, reqData.token_usage);
   }
}
`;

content = content.replace(/\/\/ Memoria para Debugging \(Últimos 50 requests\)[\s\S]*?function addRecentRequest\(reqData\) \{[\s\S]*?\} catch \(_\) \{\}\r?\n\}/, telemetryFuncs);

// 3. Modificar app.post("/helios/message") para setear currentTelemetryCtx
content = content.replace(/app\.post\("\/helios\/message", async \(req, res\) => \{/,
  `app.post("/helios/message", async (req, res) => {\n  currentTelemetryCtx = await startAdapterEvent(req.body || {});`);


// 4. Refactor normalizeAdapterResponse
const normalizeOld = /function normalizeAdapterResponse\(result\) \{[\s\S]*?return \{\r?\n    ok: true,[\s\S]*?response_sent: parsedJson\?\.response_sent === true\r?\n  \};\r?\n\}/;
const normalizeNew = `function normalizeAdapterResponse(result) {
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
content = content.replace(normalizeOld, normalizeNew);


// 5. Refactor /debug/events
// Endpoint actual: app.get("/debug/events", requireDebugAuth, (req, res) => { ... });
const debugEventsOld = /app\.get\("\/debug\/events", requireDebugAuth, \(req, res\) => \{[\s\S]*?res\.status\(500\)\.json\(\{ error: true, message: err\.message \|\| "Error interno" \}\);\r?\n  \}\r?\n\}\);/;
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
content = content.replace(debugEventsOld, debugEventsNew);

fs.writeFileSync('server.js', content);
console.log('Update finished securely');
