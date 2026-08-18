const crypto = require('crypto');

// 1. normalizeTelemetryIdentity
function normalizeTelemetryIdentity(payload) {
  const traceId = payload?.metadata?.trace_id || payload?.trace_id || crypto.randomUUID();
  const tenantId = payload?.tenant_id;
  const conversationId = payload?.conversation?.conversation_id || payload?.conversation_id;
  const contactId = payload?.conversation?.contact_id || payload?.contact_id;
  const incomplete = !tenantId || !conversationId || !contactId;
  return {
    trace_id: traceId,
    tenant_id: tenantId || 'unknown_tenant',
    conversation_id: conversationId || 'unknown_conversation',
    contact_id: contactId || 'unknown_contact',
    incomplete
  };
}

// 2. normalizeAdapterResponse
function sanitizePatientReply(reply) {
  if (typeof reply !== 'string') return '';
  return reply.replace(/<\/?(thought|thinking)>/gi, '').trim();
}

function containsInternalReasoning(text) {
  if (typeof text !== 'string') return false;
  return text.toLowerCase().includes('thinking') || text.toLowerCase().includes('reasoning');
}

function normalizeAdapterResponse(result) {
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
      error_code: "INVALID_CLIENT_MESSAGE"
    };
  }

  return {
    ok: true,
    reply: messageForClient,
    route: parsedJson?.route || "hermes",
    intent: parsedJson?.intent || "respuesta_hermes"
  };
}


let allPass = true;

// Test A
const testA = normalizeTelemetryIdentity({ metadata: { trace_id: "test-trace-123" } });
if (testA.trace_id === "test-trace-123") console.log("✅ Prueba A PASS");
else { console.log("❌ Prueba A FAIL"); allPass = false; }

// Test B
const testB = normalizeTelemetryIdentity({ conversation: { contact_id: "contact-456" } });
if (testB.contact_id === "contact-456") console.log("✅ Prueba B PASS");
else { console.log("❌ Prueba B FAIL"); allPass = false; }

// Test L
const testL1 = normalizeAdapterResponse("esto es un string plano");
const testL2 = normalizeAdapterResponse({ rawReply: "esto es un objeto sin reply" });
const testL3 = normalizeAdapterResponse({ message_for_client: "Hola paciente" });
if (testL1.ok === false && testL2.ok === false && testL3.ok === true) console.log("✅ Prueba L PASS");
else { console.log("❌ Prueba L FAIL"); allPass = false; }

// Bloqueo de razonamiento
const testBlock = normalizeAdapterResponse({ message_for_client: "Hola, <thought>razonamiento</thought> como estas" });
if (testBlock.ok === false) console.log("✅ Prueba Bloqueo Razonamiento PASS");
else { console.log("❌ Prueba Bloqueo Razonamiento FAIL"); allPass = false; }

if (allPass) process.exit(0);
else process.exit(1);
