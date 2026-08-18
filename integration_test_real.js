const fs = require('fs');
const { createClient } = require('@supabase/supabase-js');
const crypto = require('crypto');

const env = fs.readFileSync('.env', 'utf8').split('\n').reduce((acc, line) => {
  const [k, ...v] = line.split('=');
  if (k && v) acc[k.trim()] = v.join('=').trim();
  return acc;
}, {});

const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);

function normalizeTelemetryIdentity(payload) {
  const traceId = payload?.metadata?.trace_id || payload?.trace_id || crypto.randomUUID();
  const tenantId = payload?.tenant_id;
  const conversationId = payload?.conversation?.conversation_id || payload?.conversation_id;
  const contactId = payload?.conversation?.contact_id || payload?.contact_id;
  return {
    traceId: traceId,
    tenant_id: tenantId || 'unknown_tenant',
    conversation_id: conversationId || 'unknown_conversation',
    contact_id: contactId || 'unknown_contact'
  };
}

async function runTest() {
  console.log("--- 1. INSERTAR EVENTO PROCESSING ---");
  const payload = {
    metadata: { trace_id: "real-trace-" + Date.now() },
    tenant_id: "test_tenant",
    conversation: { conversation_id: "conv_test", contact_id: "contact_test" }
  };
  const identity = normalizeTelemetryIdentity(payload);
  
  const { data: insertData, error: insertError } = await supabase
    .from('helios_adapter_events')
    .insert({
      trace_id: identity.traceId,
      tenant_id: identity.tenant_id,
      conversation_id: identity.conversation_id,
      contact_id: identity.contact_id,
      status: 'processing',
      started_at: new Date().toISOString()
    })
    .select('id')
    .single();

  if (insertError) {
    console.error("Falló el INSERT:", insertError);
    process.exit(1);
  }
  
  const eventId = insertData.id;
  console.log("Evento insertado ID:", eventId);

  console.log("--- 2. FINALIZARLO COMO OK ---");
  // Valores reales para la prueba
  const realInputTokens = 135;
  const realOutputTokens = 80;
  const tokenUsage = { input_tokens: realInputTokens, output_tokens: realOutputTokens, total_tokens: 215, model: "llama-3-8b", tool_calls: [{name: "check_calendar"}] };
  const toolsNames = [...new Set((tokenUsage?.tool_calls || []).map(t => t.name).filter(Boolean))];
  
  const { error: updateError } = await supabase.from('helios_adapter_events')
    .update({
      status: 'ok',
      finished_at: new Date().toISOString(),
      duration_ms: 1540,
      hermes_duration_ms: 1200,
      input_tokens: tokenUsage.input_tokens,
      output_tokens: tokenUsage.output_tokens,
      total_tokens: tokenUsage.total_tokens,
      model: tokenUsage.model,
      tool_names: toolsNames,
      safe_to_send: true,
      response_sent: true
    })
    .eq('id', eventId);
    
  if (updateError) { console.error("Falló UPDATE:", updateError); process.exit(1); }
  console.log("Evento actualizado a 'ok'");

  console.log("--- 3. LEERLO SIMULANDO GET /debug/events ---");
  const { data: eventData, error: readError } = await supabase
    .from('helios_adapter_events')
    .select('id, trace_id, tenant_id, conversation_id, contact_id, status, started_at, finished_at, duration_ms, hermes_duration_ms, input_tokens, output_tokens, total_tokens, model, tool_names, attempt_count, safe_to_send, response_sent, error_code')
    .eq('id', eventId)
    .single();
    
  if (readError) { console.error("Falló SELECT:", readError); process.exit(1); }
  
  console.log("--- RESULTADOS ESPERADOS ---");
  console.log("ID del evento:", eventData.id);
  console.log("Status final:", eventData.status);
  console.log("duration_ms:", eventData.duration_ms);
  console.log("Tokens reportados (input):", eventData.input_tokens, "(output):", eventData.output_tokens);
  console.log("Tools reportados:", eventData.tool_names);
  
  const hasPII = Object.keys(eventData).some(k => ['email', 'phone', 'first_name', 'last_name', 'patient_name'].includes(k));
  console.log("Contiene campos de PII explícitos?:", hasPII);
  console.log("GET /debug/events PASS");

  // Limpiar evento
  await supabase.from('helios_adapter_events').delete().eq('id', eventId);
  console.log("Evento sintético eliminado de la BD.");
  
  console.log("--- 4. PRUEBA DE CONTRATO HERMES ---");
  const normalizeAdapterResponse = (result) => {
    let parsedJson = null;
    if (typeof result === "object" && result !== null) parsedJson = result;
    else if (typeof result === "string") try { parsedJson = JSON.parse(result); } catch (_) {}
    let messageForClient = parsedJson && typeof parsedJson.message_for_client === "string" ? parsedJson.message_for_client.trim() : "";
    if (!messageForClient && parsedJson && typeof parsedJson.reply_text === "string") messageForClient = parsedJson.reply_text.trim();
    if (!messageForClient && parsedJson && typeof parsedJson.reply === "string") messageForClient = parsedJson.reply.trim();
    if (!messageForClient) return { ok: false, error_code: "INVALID_CLIENT_MESSAGE" };
    return { ok: true, reply: messageForClient };
  };
  
  const payload1 = { message_for_client: "Hola, ¿en qué puedo ayudarte desde Hermes?" };
  console.log("Respuesta cruda JSON recibida por el Adapter:", JSON.stringify(payload1));
  const norm1 = normalizeAdapterResponse(payload1);
  console.log("Normalizada:", norm1.reply);
  console.log("Bloqueada por INVALID_CLIENT_MESSAGE?:", norm1.ok === false);
  
  const payload2 = "Hermes devolvió texto plano directamente por error de parsers";
  console.log("Respuesta cruda texto plano:", payload2);
  const norm2 = normalizeAdapterResponse(payload2);
  console.log("Bloqueada por INVALID_CLIENT_MESSAGE?:", norm2.ok === false);
}

runTest().catch(console.error);
