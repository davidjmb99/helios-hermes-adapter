const express = require("express");
const fs = require("fs");
const crypto = require("crypto");

function withTimeout(promise, ms, fallbackValue) {
  const safePromise = promise.catch(err => {
    console.error("Secondary operation late rejection:", err.message);
    return fallbackValue;
  });
  
  return Promise.race([
    safePromise,
    new Promise(resolve => setTimeout(() => resolve(fallbackValue), ms))
  ]).catch(err => {
    console.error("Timeout/Error in secondary operation:", err.message);
    return fallbackValue;
  });
}

const { createClient } = require('@supabase/supabase-js');
const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
let supabase = null;
if (SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY) {
  supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
}

const app = reportExpressErrorsAndConfigure();

function reportExpressErrorsAndConfigure() {
  const expressApp = express();
  expressApp.use(express.json({ limit: "2mb" }));
  return expressApp;
}

const PORT = process.env.PORT || 3000;

const ADAPTER_API_KEY = process.env.HERMES_API_KEY || "";
const DEBUG_USERNAME = process.env.DEBUG_USERNAME || "";
const DEBUG_PASSWORD = process.env.DEBUG_PASSWORD || "";
const DEBUG_TOKEN = process.env.DEBUG_TOKEN || "";
const NODE_ENV = process.env.NODE_ENV || "development";
const TOKEN_ESTIMATION_ENABLED = process.env.TOKEN_ESTIMATION_ENABLED === "true";
const TOKEN_ESTIMATION_CHARS_PER_TOKEN = Number(process.env.TOKEN_ESTIMATION_CHARS_PER_TOKEN || 4);

const sessionSecret = crypto.randomBytes(32).toString('hex');

function getCookie(req, name) {
  const list = {};
  const rc = req.headers.cookie;
  if (rc) {
    rc.split(';').forEach(cookie => {
      const parts = cookie.split('=');
      list[parts.shift().trim()] = decodeURI(parts.join('='));
    });
  }
  return list[name];
}

const HERMES_PROFILE = process.env.HERMES_PROFILE || "helios";
const HERMES_CWD =
  process.env.HERMES_CWD ||
  "/home/hermeswebui/.hermes/profiles/helios/workspace/helios";

const HERMES_WEBUI_BASE_URL = (
  process.env.HERMES_WEBUI_BASE_URL || "https://hermes.servicios.escala365.com"
).replace(/\/+$/, "");

const HERMES_WEBUI_PASSWORD = process.env.HERMES_WEBUI_PASSWORD || "";
const HERMES_TIMEOUT_MS = Number(process.env.HERMES_TIMEOUT_MS || 30000);

const SESSION_STORE_PATH =
  process.env.HERMES_SESSION_STORE_PATH || "/tmp/helios-hermes-sessions.json";

// Opcional. Si no existen, Hermes usará el modelo principal del perfil helios.
const HERMES_MODEL = process.env.HERMES_MODEL || "";
const HERMES_MODEL_PROVIDER = process.env.HERMES_MODEL_PROVIDER || "";

let hermesCookie = "";
let sessionMap = {};


function normalizeTelemetryIdentity(payload) {
  const traceId = payload?.metadata?.trace_id || payload?.trace_id || crypto.randomUUID();
  const tenantId = payload?.tenant_id;
  const conversationId = payload?.conversation?.conversation_id || payload?.conversation_id;
  const contactId = payload?.conversation?.contact_id || payload?.contact_id;
  const incomplete = !tenantId || !conversationId || !contactId;
  if (incomplete) {
    console.warn(`[Adapter] TELEMETRY_IDENTITY_INCOMPLETE: traceId=${traceId}`);
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
      return { eventId: data.id, identity, startedAt: Date.now(), closed: false };
    } else {
       return { eventId: null, identity, startedAt: Date.now(), closed: false };
    }
  } catch (err) {
    console.error('[Adapter] Fallo al iniciar telemetría:', err.message);
    return { eventId: null, identity: normalizeTelemetryIdentity(payload), startedAt: Date.now(), closed: false };
  }
}

async function finishAdapterEvent(ctx, status, result, hermesDuration, tokenUsage, extra = {}) {
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
    let finalStatus = status;
    if (status !== 'buffered' && status !== 'error') {
      if (result?.safe_to_send === true && result?.response_sent === true) {
        finalStatus = 'ok';
      } else {
        finalStatus = 'error';
      }
    }
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
        phone: extra.phone || null,
        hermes_first_token_ms: extra.hermes_first_token_ms || null,
        tool_duration_ms: extra.tool_duration_ms || null,
          session_id: extra.session_id || null,
          stream_id: extra.stream_id || null,
          session_id: extra.session_id || null,
          stream_id: extra.stream_id || null,
        phone: extra.phone || null,
        hermes_first_token_ms: extra.hermes_first_token_ms || null,
        tool_duration_ms: extra.tool_duration_ms || null,
        display_name_source: extra.display_name_source || null,
        message_preview: extra.message_preview || null,
        message_count: extra.message_count || null,
        intent: extra.intent || null,
        response_preview: extra.response_preview || null,
          operation_type: extra.operation_type || null,
          operation_status: extra.operation_status || null,
          operation_summary: extra.operation_summary || null,
          has_profile_patch: extra.has_profile_patch || false,
          has_booking_patch: extra.has_booking_patch || false,
        route: extra.route || null,
        tool_status: toolStatus,
        tool_duration_ms: tokenUsage?.tool_duration_ms || null
      })
      .eq('id', ctx.eventId);
  } catch (err) {
    console.error('[Adapter] Fallo al finalizar telemetría:', err.message);
  }
}

async function failAdapterEvent(ctx, errorCode, hermesDuration = null, extra = {}) {
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


function loadSessionMap() {
  try {
    if (fs.existsSync(SESSION_STORE_PATH)) {
      sessionMap = JSON.parse(fs.readFileSync(SESSION_STORE_PATH, "utf8"));
    }
  } catch (error) {
    console.warn("No se pudo cargar sessionMap:", error.message);
    sessionMap = {};
  }
}

function saveSessionMap() {
  try {
    fs.writeFileSync(SESSION_STORE_PATH, JSON.stringify(sessionMap, null, 2));
  } catch (error) {
    console.warn("No se pudo guardar sessionMap:", error.message);
  }
}

loadSessionMap();

function getBearerToken(req) {
  const header = req.headers.authorization || "";
  if (!header.startsWith("Bearer ")) return "";
  return header.slice("Bearer ".length).trim();
}

function firstNonEmpty(...values) {
  for (const value of values) {
    if (value === undefined || value === null) continue;
    const text = String(value).trim();
    if (text) return text;
  }
  return "";
}

function hashShort(value) {
  return crypto
    .createHash("sha256")
    .update(String(value || ""))
    .digest("hex")
    .slice(0, 12);
}

function maskPhone(phone) {
  if (!phone) return "";
  const str = String(phone).trim();
  if (str.length <= 5) return "*****";
  const prefix = str.slice(0, 4);
  const suffix = str.slice(-4);
  return `${prefix}*****${suffix}`;
}

function maskEmail(email) {
  if (!email) return "";
  const str = String(email).trim();
  const parts = str.split("@");
  if (parts.length !== 2) return "*****";
  const name = parts[0];
  const domain = parts[1];
  if (name.length <= 2) {
    return name + "***@" + domain;
  }
  const prefix = name.slice(0, 2);
  return prefix + "***@" + domain;
}

function safeCompare(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  try {
    const aBuf = Buffer.from(a);
    const bBuf = Buffer.from(b);
    if (aBuf.length !== bBuf.length) {
      crypto.timingSafeEqual(aBuf, aBuf);
      return false;
    }
    return crypto.timingSafeEqual(aBuf, bBuf);
  } catch (_) {
    return false;
  }
}

function getBasicAuthCredentials(req) {
  const header = req.headers.authorization || "";
  if (!header.startsWith("Basic ")) return null;
  
  try {
    const credentialsBase64 = header.slice("Basic ".length).trim();
    const decoded = Buffer.from(credentialsBase64, 'base64').toString('utf8');
    const index = decoded.indexOf(':');
    if (index === -1) return null;
    return {
      username: decoded.slice(0, index),
      password: decoded.slice(index + 1)
    };
  } catch (_) {
    return null;
  }
}

function isDebugAuthorized(req) {
  // A) Verificar cookie de sesión personalizada
  if (DEBUG_USERNAME && DEBUG_PASSWORD) {
    const cookieToken = getCookie(req, "debug_token");
    const expectedToken = crypto.createHmac('sha256', sessionSecret)
      .update(`${DEBUG_USERNAME}:${DEBUG_PASSWORD}`)
      .digest('hex');
    if (cookieToken && safeCompare(cookieToken, expectedToken)) {
      return true;
    }
    
    // Mantener compatibilidad con Basic Auth si se provee
    const basic = getBasicAuthCredentials(req);
    if (basic && safeCompare(basic.username, DEBUG_USERNAME) && safeCompare(basic.password, DEBUG_PASSWORD)) {
      return true;
    }
  }

  // B y C) Verificar token Bearer o parámetro query
  if (DEBUG_TOKEN) {
    let token = getBearerToken(req);
    if (!token && req.query.token) {
      token = String(req.query.token).trim();
    }
    if (token && safeCompare(token, DEBUG_TOKEN)) {
      return true;
    }
  }

  // Si no hay configuración de debug en absoluto, permitir acceso solo en desarrollo
  if (!DEBUG_USERNAME && !DEBUG_PASSWORD && !DEBUG_TOKEN) {
    return NODE_ENV !== "production";
  }

  return false;
}

function requireDebugAuth(req, res, next) {
  if (isDebugAuthorized(req)) {
    return next();
  }

  const isProduction = NODE_ENV === "production";
  const hasCredsConfigured = Boolean(DEBUG_USERNAME && DEBUG_PASSWORD);
  const hasTokenConfigured = Boolean(DEBUG_TOKEN);

  // Si está en producción y no se ha configurado ninguna autenticación
  if (isProduction && !hasCredsConfigured && !hasTokenConfigured) {
    const status = 403;
    const errorMsg = "Dashboard protegido. Configura DEBUG_USERNAME y DEBUG_PASSWORD.";
    
    if (req.path === "/debug/events") {
      return res.status(status).json({ ok: false, error: errorMsg });
    } else {
      return res.status(status).send(`
        <html>
          <head><title>Acceso Prohibido</title></head>
          <body style="background:#09090b; color:#ef4444; font-family:sans-serif; display:flex; justify-content:center; align-items:center; height:100vh; margin:0;">
            <div style="text-align:center; border:1px solid #ef4444; padding:2rem; border-radius:8px; background:rgba(239,68,68,0.1); max-width: 500px; width: 90%;">
              <h2 style="margin: 0 0 0.5rem 0; font-size: 1.5rem;">403 - Acceso Prohibido</h2>
              <p style="color:#a1a1aa; margin: 0; font-size: 0.95rem;">${errorMsg}</p>
            </div>
          </body>
        </html>
      `);
    }
  }

  // Si es el endpoint de eventos JSON, devolvemos un 401 limpio
  if (req.path === "/debug/events") {
    return res.status(401).json({ ok: false, error: "No autorizado: Autenticación requerida." });
  }

  // Para las páginas html (/ o /debug), servimos la interfaz de Login personalizada
  return serveLoginPage(req, res);
}

function normalizeGatewayPayload(payload = {}) {
  const messageIsObject =
    payload.message &&
    typeof payload.message === "object" &&
    !Array.isArray(payload.message);

  const messageText = messageIsObject
    ? firstNonEmpty(payload.message.text, payload.text, payload.content, payload.body)
    : firstNonEmpty(payload.message, payload.text, payload.content, payload.body);

  const messageItems =
    messageIsObject && Array.isArray(payload.message.messages)
      ? payload.message.messages
      : [];

  const messageCount = messageIsObject
    ? Number(payload.message.message_count || messageItems.length || 1)
    : 1;

  return {
    event: payload.event || "patient_message_ready",

    trace_id: firstNonEmpty(payload.trace_id, payload.metadata?.trace_id),
    tenant_id: firstNonEmpty(payload.tenant_id),
    clinic_id: firstNonEmpty(payload.clinic_id),
    channel: firstNonEmpty(payload.channel),

    conversation_id: firstNonEmpty(
      payload.conversation_id,
      payload.conversation?.conversation_id
    ),

    contact_id: firstNonEmpty(
      payload.contact_id,
      payload.conversation?.contact_id
    ),

    inbox_id: firstNonEmpty(
      payload.inbox_id,
      payload.conversation?.inbox_id
    ),

    phone: firstNonEmpty(
      payload.phone,
      payload.conversation?.phone,
      payload.patient?.phone
    ),

    message_text: messageText,
    message_count: messageCount,
    message_items: messageItems,

    patient: payload.patient || {},
    state: payload.state || {},
    clinic_context: payload.clinic_context || {},
    signals: payload.signals || {},
    metadata: payload.metadata || {},

    raw: payload
  };
}

function getSessionIdentity(normalized) {
  if (normalized.conversation_id) {
    return `conversation:${normalized.conversation_id}:contact:${normalized.contact_id || "none"}`;
  }

  if (normalized.contact_id) {
    return `contact:${normalized.contact_id}`;
  }

  if (normalized.phone) {
    return `phone_hash:${hashShort(normalized.phone)}`;
  }

  if (normalized.trace_id) {
    return `trace:${normalized.trace_id}`;
  }

  return "";
}

function conversationKey(normalized) {
  const tenant = normalized.tenant_id || "default";
  const clinic = normalized.clinic_id || "default";
  const identity = getSessionIdentity(normalized);

  if (!identity) {
    throw new Error(
      "No se pudo construir session key: faltan conversation_id, contact_id, phone y trace_id"
    );
  }

  return `${tenant}:${clinic}:${identity}`;
}

function buildHermesMessage(normalized) {
  // IMPORTANTE: El adapter NO agrega instrucciones clínicas.
  return JSON.stringify(normalized.raw || {}, null, 2);
}

async function fetchWithTimeout(url, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), HERMES_TIMEOUT_MS);

  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal,
      redirect: "manual"
    });
  } finally {
    clearTimeout(timeout);
  }
}

function updateCookieFromResponse(response) {
  const setCookie = response.headers.get("set-cookie");
  if (!setCookie) return;

  const parts = setCookie
    .split(/,(?=[^;]+?=)/)
    .map((cookie) => cookie.split(";")[0].trim())
    .filter(Boolean);

  if (parts.length) {
    hermesCookie = parts.join("; ");
  }
}

async function hermesLogin() {
  if (!HERMES_WEBUI_PASSWORD) {
    throw new Error("HERMES_WEBUI_PASSWORD no está configurada");
  }

  const response = await fetchWithTimeout(
    `${HERMES_WEBUI_BASE_URL}/api/auth/login`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        password: HERMES_WEBUI_PASSWORD
      })
    }
  );

  updateCookieFromResponse(response);

  const text = await response.text();

  let data = {};
  try {
    data = JSON.parse(text);
  } catch (_) {}

  if (!response.ok || !data.ok) {
    throw new Error(
      `Login Hermes falló HTTP ${response.status}: ${text.slice(0, 300)}`
    );
  }

  if (!hermesCookie) {
    throw new Error("Login Hermes OK, pero no se recibió cookie de sesión");
  }

  return true;
}

function createHermesHttpError(path, response, text) {
  const error = new Error(
    `Hermes ${path} HTTP ${response.status}: ${String(text || "").slice(0, 500)}`
  );

  error.status = response.status;
  error.path = path;
  error.body = text || "";
  error.location = response.headers.get("location") || "";

  return error;
}

async function hermesRequest(path, body, retryLogin = true) {
  if (!hermesCookie) {
    await hermesLogin();
  }

  const response = await fetchWithTimeout(`${HERMES_WEBUI_BASE_URL}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      cookie: hermesCookie
    },
    body: JSON.stringify(body)
  });

  updateCookieFromResponse(response);

  const text = await response.text();

  if (
    retryLogin &&
    (response.status === 401 ||
      response.status === 403 ||
      response.status === 302 ||
      (response.headers.get("location") || "").includes("login"))
  ) {
    hermesCookie = "";
    await hermesLogin();
    return hermesRequest(path, body, false);
  }

  let data = {};
  try {
    data = JSON.parse(text);
  } catch (_) {
    data = { raw: text };
  }

  if (!response.ok) {
    throw createHermesHttpError(path, response, text);
  }

  return data;
}

async function hermesGetRequest(path, retryLogin = true) {
  if (!hermesCookie) {
    await hermesLogin();
  }

  const response = await fetchWithTimeout(`${HERMES_WEBUI_BASE_URL}${path}`, {
    method: "GET",
    headers: {
      cookie: hermesCookie
    }
  });

  updateCookieFromResponse(response);

  const text = await response.text();

  if (
    retryLogin &&
    (response.status === 401 ||
      response.status === 403 ||
      response.status === 302 ||
      (response.headers.get("location") || "").includes("login"))
  ) {
    hermesCookie = "";
    await hermesLogin();
    return hermesGetRequest(path, false);
  }

  let data;
  try {
    data = JSON.parse(text);
  } catch (_) {
    data = { raw: text };
  }

  if (!response.ok) {
    throw createHermesHttpError(path, response, text);
  }

  return data;
}

async function fetchHermesSessionData(sessionId) {
  if (!sessionId) return { sessionData: null, attempts: [] };

  const pathsToTry = [
    `/api/session?session_id=${encodeURIComponent(sessionId)}&messages=0&resolve_model=1`,
    `/api/session?session_id=${encodeURIComponent(sessionId)}&messages=1&resolve_model=1&msg_limit=5`,
    `/api/sessions/${encodeURIComponent(sessionId)}?profile=${encodeURIComponent(HERMES_PROFILE)}`,
    `/api/sessions/${encodeURIComponent(sessionId)}`
  ];

  const attempts = [];

  for (const path of pathsToTry) {
    try {
      const data = await hermesGetRequest(path);
      const isSuccess = data && (data.session || data.session_id || data.id);
      
      attempts.push({
        path,
        status: 200,
        found_tokens: Boolean(isSuccess)
      });
      
      if (isSuccess) {
        return { sessionData: data, attempts };
      }
    } catch (err) {
      console.warn(`Falló GET ${path}:`, err.message);
      attempts.push({
        path,
        status: err.status || 500,
        found_tokens: false
      });
    }
  }
  return { sessionData: null, attempts };
}

function extractTokenUsage(sessionData, attempts = []) {
  const fallback = {
    exact: false,
    model: null,
    model_provider: null,
    input_tokens: null,
    output_tokens: null,
    total_tokens: null,
    cache_read_tokens: null,
    cache_write_tokens: null,
    estimated_cost: null,
    token_source: "not_available_from_hermes",
    cost_source: "not_available_from_hermes",
    token_lookup_attempts: attempts
  };

  if (!sessionData) return fallback;

  const session = sessionData.session || sessionData;
  
  const input_tokens = Number.isFinite(session.input_tokens) ? session.input_tokens : null;
  const output_tokens = Number.isFinite(session.output_tokens) ? session.output_tokens : null;

  const hasInputTokens = typeof input_tokens === 'number' && input_tokens > 0;
  const hasOutputTokens = typeof output_tokens === 'number' && output_tokens > 0;

  if (!hasInputTokens && !hasOutputTokens) {
    fallback.token_source = "webui_session_no_token_usage";
    fallback.cost_source = "webui_session_no_token_usage";
    return fallback;
  }

  const total_tokens = (input_tokens !== null && output_tokens !== null)
    ? input_tokens + output_tokens
    : null;

  const estimated_cost = Number.isFinite(session.estimated_cost)
    ? session.estimated_cost
    : Number.isFinite(session.estimated_cost_usd)
      ? session.estimated_cost_usd
      : null;

  return {
    exact: true,
    model: session.model || null,
    model_provider: session.model_provider || session.billing_provider || null,
    input_tokens,
    output_tokens,
    total_tokens,
    cache_read_tokens: Number.isFinite(session.cache_read_tokens) ? session.cache_read_tokens : null,
    cache_write_tokens: Number.isFinite(session.cache_write_tokens) ? session.cache_write_tokens : null,
    estimated_cost,
    token_source: "hermes_webui_session_endpoint",
    cost_source: "hermes_webui_session_endpoint",
    tool_duration_ms: (function() {
      try {
         const msgs = session.messages || session.history || [];
         let total = 0;
         for (const m of msgs) {
            const arr = m.tool_calls || m.tools || [];
            for (const t of arr) {
               total += (t.duration_ms || t.execution_time_ms || 0);
            }
         }
         return total > 0 ? total : null;
      } catch(e) { return null; }
    })(),
    token_lookup_attempts: attempts,
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
            const duration = tc.duration_ms || tc.execution_time_ms || null;
            extractedToolCalls.push({ name, status, duration });
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
      } catch(e) {}
      return extractedToolCalls;
    })()
  };
}

function withOptionalModel(body) {
  const next = { ...body };

  if (HERMES_MODEL) {
    next.model = HERMES_MODEL;
  }

  if (HERMES_MODEL_PROVIDER) {
    next.model_provider = HERMES_MODEL_PROVIDER;
  }

  return next;
}

async function createHermesSession(normalized) {
  const data = await hermesRequest(
    "/api/session/new",
    withOptionalModel({
      workspace: HERMES_CWD,
      profile: HERMES_PROFILE
    })
  );

  const sessionId = data?.session?.session_id;

  if (!sessionId) {
    throw new Error("Hermes no devolvió session_id al crear sesión");
  }

  const key = conversationKey(normalized);

  sessionMap[key] = {
    session_id: sessionId,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  };

  saveSessionMap();

  return sessionId;
}

async function getHermesSessionId(normalized) {
  const key = conversationKey(normalized);

  if (sessionMap[key]?.session_id) {
    return sessionMap[key].session_id;
  }

  return createHermesSession(normalized);
}

function isSessionMissingError(errorOrData) {
  const text = String(
    errorOrData?.body ||
      errorOrData?.message ||
      errorOrData?.error ||
      ""
  ).toLowerCase();

  return (
    errorOrData?.status === 404 ||
    text.includes("session not found") ||
    text.includes("session_not_found") ||
    text.includes("not found") ||
    text.includes("no such session") ||
    text.includes("missing session")
  );
}

function isProviderErrorText(text) {
  const value = String(text || "").toLowerCase();

  return (
    value.startsWith("api call failed") ||
    value.includes("api call failed after") ||
    value.includes("http 429") ||
    value.includes("the usage limit has been reached")
  );
}

async function startHermesStream(sessionId, normalized) {
  const body = withOptionalModel({
    session_id: sessionId,
    workspace: HERMES_CWD,
    profile: HERMES_PROFILE,
    message: buildHermesMessage(normalized)
  });

  return hermesRequest("/api/chat/start", body);
}

async function consumeHermesStream(streamId) {
  if (!hermesCookie) {
    await hermesLogin();
  }

  const url = `${HERMES_WEBUI_BASE_URL}/api/chat/stream?stream_id=${streamId}`;
  
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), HERMES_TIMEOUT_MS);

  let response;
  try {
    response = await fetch(url, {
      method: "GET",
      headers: {
        cookie: hermesCookie
      },
      signal: controller.signal
    });
  } catch (error) {
    clearTimeout(timeout);
    throw error;
  }

  if (!response.ok) {
    clearTimeout(timeout);
    const text = await response.text();
    throw new Error(`Hermes stream connection failed HTTP ${response.status}: ${text.slice(0, 300)}`);
  }

  let streamedContent = "";
  let completedContent = "";
  let assistantCompletedReceived = false;
  let reasoningContent = "";
  let toolEvents = [];
  let firstTokenTime = null;
  let sessionId = null;
  let tokenUsage = null;

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let currentEvent = "";

  const processEvent = (eventName, dataStr) => {
    let parsed = {};
    let isJson = false;
    try { parsed = JSON.parse(dataStr); isJson = true; } catch (_) {}
    const evName = eventName || (isJson ? parsed.event : "") || "";

    if (isJson) {
      if (parsed.session_id) sessionId = parsed.session_id;
      if (parsed.usage || parsed.token_usage) tokenUsage = parsed.usage || parsed.token_usage;
    }

    if (evName === "assistant.delta" || evName === "token") {
      const token = isJson ? (parsed.text || parsed.token || parsed.content || "") : dataStr;
      if (!firstTokenTime) firstTokenTime = Date.now();
      streamedContent += token;
    } else if (evName === "reasoning_delta" || evName === "reasoning_content" || evName === "reasoning") {
      const token = isJson ? (parsed.text || parsed.token || parsed.content || "") : dataStr;
      reasoningContent += token;
    } else if (evName === "tool.progress" || evName === "tool" || evName === "tool_call") {
      if (isJson) {
        const toolName = parsed.tool_name || parsed.name || "";
        if (toolName !== "_thinking") {
          toolEvents.push({
            name: toolName,
            status: parsed.status || "started",
            duration_ms: parsed.duration_ms || null,
            result_code: parsed.result_code || null
          });
        }
      }
    } else if (evName === "assistant.completed") {
      let contentToSave = null;
      if (isJson && typeof parsed.content === "string") {
        contentToSave = parsed.content;
      } else if (isJson && parsed.message && typeof parsed.message.content === "string") {
        contentToSave = parsed.message.content;
      } else if (!isJson && dataStr.trim() !== "") {
        contentToSave = dataStr;
      }
      
      if (typeof contentToSave === "string" && contentToSave.trim()) {
        completedContent = contentToSave.trim();
        assistantCompletedReceived = true;
      }
    } else if (evName === "error") {
      const errorMsg = isJson ? (parsed.error || parsed.message || dataStr) : dataStr;
      throw new Error(`Hermes stream reported error: ${errorMsg}`);
    } else if (["run.completed", "done", "complete", "completed"].includes(evName)) {
      return true;
    }
    return false;
  };

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop(); // Mantener línea incompleta en el buffer

      let shouldBreak = false;
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        if (trimmed.startsWith("event:")) {
          currentEvent = trimmed.slice("event:".length).trim();
        } else if (trimmed.startsWith("data:")) {
          const dataStr = trimmed.slice("data:".length).trim();
          if (dataStr === "[DONE]" || dataStr === "done") { shouldBreak = true; break; }
          if (processEvent(currentEvent, dataStr)) { shouldBreak = true; break; }
        }
      }
      if (shouldBreak) break;
    }

    if (buffer.trim()) {
      const trimmed = buffer.trim();
      if (trimmed.startsWith("data:")) {
        const dataStr = trimmed.slice("data:".length).trim();
        if (dataStr !== "[DONE]" && dataStr !== "done") {
          processEvent(currentEvent, dataStr);
        }
      }
    }
  } finally {
    clearTimeout(timeout);
    try { reader.cancel(); } catch (_) {}
  }

  const rawReply = completedContent.trim() !== "" ? completedContent.trim() : streamedContent.trim();
  console.log("SSE_STATS:", { streamedContentLen: streamedContent.length, completedContentLen: completedContent.length, assistantCompletedReceived });
  return { 
    answer: rawReply,
    firstTokenTime,
    assistantCompletedReceived,
    sessionId,
    streamId,
    tokenUsage,
    toolCalls: toolEvents
  };
}

async function consumeHermesStreamWithRetry(streamId) {
  try {
    return await consumeHermesStream(streamId);
  } catch (error) {
    if (error.message.includes("HTTP 401") || error.message.includes("HTTP 403")) {
      console.warn("Stream connection returned unauthorized/forbidden, retrying login...");
      hermesCookie = "";
      await hermesLogin();
      return await consumeHermesStream(streamId);
    }
    throw error;
  }
}

async function sendMessageToHermes(payload) {
  const normalized = normalizeGatewayPayload(payload);
  const key = conversationKey(normalized);

  let sessionId = await getHermesSessionId(normalized);

  console.log(
    JSON.stringify({
      event: "adapter_payload_normalized",
      normalized_trace_id: normalized.trace_id || null,
      normalized_tenant_id: normalized.tenant_id || null,
      normalized_clinic_id: normalized.clinic_id || null,
      normalized_conversation_id: normalized.conversation_id || null,
      normalized_contact_id: normalized.contact_id || null,
      normalized_phone_exists: Boolean(normalized.phone),
      message_count: normalized.message_count,
      session_key_hash: hashShort(key),
      hermes_session_id: sessionId,
      using_model_override: Boolean(HERMES_MODEL || HERMES_MODEL_PROVIDER)
    })
  );

  let streamId = "";
  let answer = "";
  let conflict = false;
  let activeStreamId = "";

  const runStreamFlow = async (sid) => {
    let startData;
    try {
      startData = await startHermesStream(sid, normalized);
    } catch (error) {
      if (error.status === 409) {
        console.error(
          JSON.stringify({
            event: "active_stream_conflict_detected",
            hermes_session_id: sid,
            status: error.status,
            error_body: error.body
          })
        );
        let activeId = "";
        try {
          const parsedBody = JSON.parse(error.body);
          activeId = parsedBody.active_stream_id || parsedBody.stream_id || "";
        } catch (_) {}
        
        conflict = true;
        activeStreamId = activeId;
        return;
      }
      throw error;
    }

    if (startData?.error && isSessionMissingError(startData)) {
      throw createHermesHttpError("/api/chat/start", { status: 404, headers: new Headers() }, JSON.stringify(startData));
    }

    streamId = startData?.stream_id;
    if (!streamId) {
      throw new Error("Hermes did not return stream_id on chat start");
    }

    const streamStartedAt = Date.now();
    const resStream = await consumeHermesStreamWithRetry(streamId);
      answer = resStream.answer;
      
      try {
        if (
          typeof resStream.firstTokenTime === "number" &&
          Number.isFinite(resStream.firstTokenTime)
        ) {
          firstTokenMs = Math.max(
            0,
            resStream.firstTokenTime - streamStartedAt
          );
        } else {
          firstTokenMs = null;
        }
      } catch (_) {
        firstTokenMs = null;
      }

      if (resStream.sessionId) sessionId = resStream.sessionId;
  };

  try {
    await runStreamFlow(sessionId);
  } catch (error) {
    if (!isSessionMissingError(error)) {
      throw error;
    }

    console.warn(
      JSON.stringify({
        event: "hermes_session_missing_recreate",
        session_key_hash: hashShort(key),
        old_hermes_session_id: sessionId,
        reason: error.message
      })
    );

    delete sessionMap[key];
    saveSessionMap();

    sessionId = await createHermesSession(normalized);
    await runStreamFlow(sessionId);
  }

  if (sessionMap[key]) {
    sessionMap[key].updated_at = new Date().toISOString();
    saveSessionMap();
  }

  return {
    sessionId,
    streamId,
    answer,
    conflict,
    activeStreamId
  };
}

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

function extractLastPatientFacingReply(text) {
  if (!text) return "";

  // 1. Quitar bloques de pensamiento tipo <think>...</think>
  let cleaned = text.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();

  // Si no tiene razonamiento interno, devolverlo tal cual
  if (!containsInternalReasoning(cleaned)) {
    return cleaned;
  }

  const priorityTriggers = [
    "¡hola", "hola,", "hola ", "buenos días", "buenos dias", "buenas tardes", "buenas noches", "claro", "con gusto", "perfecto", "entiendo", "gracias", "para ayudarte", "te ayudo", "me alegra"
  ];

  const lowercaseCleaned = cleaned.toLowerCase();
  const candidates = [];

  for (const trigger of priorityTriggers) {
    let pos = lowercaseCleaned.indexOf(trigger);
    while (pos !== -1) {
      candidates.push(pos);
      pos = lowercaseCleaned.indexOf(trigger, pos + 1);
    }
  }

  candidates.sort((a, b) => a - b);

  for (const index of candidates) {
    const substring = cleaned.substring(index).trim();
    if (!containsInternalReasoning(substring) && substring.length >= 5) {
      return substring;
    }
  }

  return "";
}

function sanitizePatientReply(text) {
  if (!text) return "";
  const extracted = extractLastPatientFacingReply(text);
  if (extracted) return extracted;
  
  // Fallback: si no se pudo extraer nada inteligente, devolver el texto original
  return text;
}

function normalizeAdapterResponse(result) {
  const rawReply = result.answer || "";
  
  let parsedJson = null;
  let isStrictJson = false;

  const trimmed = rawReply.trim();
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
    try {
      parsedJson = JSON.parse(trimmed);
      isStrictJson = true;
    } catch (e) {}
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

  if (!isStrictJson || !isValidContract) {
    return {
      ok: false, reply: "", message_for_client: "",
      operation: { type: "technical_error", status: "failed", summary: "Respuesta final de Hermes rechazada por contrato inválido." },
      profile_patch: {}, state_patch: {}, booking_patch: {}, tool_calls: [],
      safe_to_send: false, response_sent: false, requires_handoff: false, recoverable: true, error_code: "INVALID_HERMES_CONTRACT"
    };
  }

  return {
    ok: true,
    reply: parsedJson.message_for_client,
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

  app.get("/health", (req, res) => {
  res.json({
    ok: true,
    service: "helios-hermes-adapter",
    version: "2.4.14",
    token_estimation_enabled: TOKEN_ESTIMATION_ENABLED,
    profile: HERMES_PROFILE,
    mode: "HERMES_WEBUI_STREAM_API",
    hermes_webui_base_url_configured: Boolean(HERMES_WEBUI_BASE_URL),
    hermes_webui_password_configured: Boolean(HERMES_WEBUI_PASSWORD),
    using_model_override: Boolean(HERMES_MODEL || HERMES_MODEL_PROVIDER),
    session_count: Object.keys(sessionMap).length,
    debug_credentials_configured: Boolean(DEBUG_USERNAME && DEBUG_PASSWORD),
    debug_token_configured: Boolean(DEBUG_TOKEN)
  });
});

// Endpoint para procesar el Login (POST)
app.post("/debug/logout", (req, res) => {
    res.setHeader('Set-Cookie', 'debug_token=; Path=/; HttpOnly; Max-Age=0');
    res.json({ ok: true });
});

app.post("/login", (req, res) => {
  const { username, password } = req.body || {};
  
  if (!DEBUG_USERNAME || !DEBUG_PASSWORD) {
    return res.status(403).json({ ok: false, error: "Servicio no configurado para autenticación." });
  }

  if (safeCompare(username, DEBUG_USERNAME) && safeCompare(password, DEBUG_PASSWORD)) {
    const expectedToken = crypto.createHmac('sha256', sessionSecret)
      .update(`${DEBUG_USERNAME}:${DEBUG_PASSWORD}`)
      .digest('hex');
    
    const isHttps = req.secure || req.headers['x-forwarded-proto'] === 'https';
    res.setHeader("Set-Cookie", `debug_token=${expectedToken}; Path=/; HttpOnly; ${isHttps ? "Secure;" : ""} SameSite=Lax; Max-Age=604800`);
    
    return res.json({ ok: true });
  }

  return res.status(401).json({ ok: false, error: "Usuario o contraseña incorrectos." });
});

// Endpoint para cerrar sesión (GET)
app.get("/logout", (req, res) => {
  res.setHeader("Set-Cookie", "debug_token=; Path=/; HttpOnly; Max-Age=0");
  res.json({ ok: true });
});

// Servir la página de inicio de sesión personalizada
function serveLoginPage(req, res) {
  res.send(`<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Helios Hermes Adapter - Login</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;500;600;700&display=swap" rel="stylesheet">
  <style>
    :root {
      --bg: #09090b;
      --card-bg: rgba(20, 20, 25, 0.6);
      --border: rgba(255, 255, 255, 0.08);
      --text: #f4f4f5;
      --text-muted: #a1a1aa;
      --primary: #6366f1;
      --primary-glow: rgba(99, 102, 241, 0.15);
      --danger: #ef4444;
    }
    
    * {
      box-sizing: border-box;
      margin: 0;
      padding: 0;
    }
    
    body {
      background-color: var(--bg);
      color: var(--text);
      font-family: 'Outfit', sans-serif;
      min-height: 100vh;
      display: flex;
      justify-content: center;
      align-items: center;
      background-image: 
        radial-gradient(at 0% 0%, rgba(99, 102, 241, 0.1) 0px, transparent 50%),
        radial-gradient(at 100% 0%, rgba(16, 185, 129, 0.05) 0px, transparent 50%);
      padding: 1rem;
    }

    .login-card {
      background: var(--card-bg);
      border: 1px solid var(--border);
      border-radius: 16px;
      padding: 2.5rem;
      width: 100%;
      max-width: 420px;
      backdrop-filter: blur(12px);
      box-shadow: 0 8px 32px rgba(0, 0, 0, 0.4);
    }

    .logo-area {
      text-align: center;
      margin-bottom: 2rem;
    }

    .logo-area h1 {
      font-size: 1.6rem;
      font-weight: 700;
      letter-spacing: -0.02em;
      background: linear-gradient(to right, #ffffff, var(--text-muted));
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
      margin-bottom: 0.5rem;
    }

    .logo-area p {
      color: var(--text-muted);
      font-size: 0.9rem;
    }

    .form-group {
      margin-bottom: 1.25rem;
      position: relative;
    }

    .form-group label {
      display: block;
      color: var(--text-muted);
      font-size: 0.85rem;
      margin-bottom: 0.5rem;
      font-weight: 500;
    }

    .input-wrapper {
      position: relative;
      display: flex;
      align-items: center;
    }

    .form-control {
      width: 100%;
      background: rgba(0, 0, 0, 0.3);
      border: 1px solid var(--border);
      color: var(--text);
      font-family: inherit;
      font-size: 0.95rem;
      padding: 0.75rem 1rem;
      border-radius: 8px;
      transition: border-color 0.2s, box-shadow 0.2s;
    }

    .form-control:focus {
      outline: none;
      border-color: var(--primary);
      box-shadow: 0 0 0 3px var(--primary-glow);
    }

    .eye-btn {
      position: absolute;
      right: 1rem;
      background: none;
      border: none;
      color: var(--text-muted);
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 0.25rem;
      transition: color 0.2s;
    }

    .eye-btn:hover {
      color: var(--text);
    }

    .btn-submit {
      width: 100%;
      background: var(--primary);
      color: #ffffff;
      border: none;
      font-family: inherit;
      font-size: 1rem;
      font-weight: 600;
      padding: 0.85rem;
      border-radius: 8px;
      cursor: pointer;
      margin-top: 1rem;
      transition: opacity 0.2s, box-shadow 0.2s;
      box-shadow: 0 4px 14px rgba(99, 102, 241, 0.4);
    }

    .btn-submit:hover {
      opacity: 0.9;
    }

    .error-msg {
      background: rgba(239, 68, 68, 0.1);
      border: 1px solid rgba(239, 68, 68, 0.2);
      color: var(--danger);
      padding: 0.75rem;
      border-radius: 8px;
      font-size: 0.85rem;
      margin-bottom: 1.5rem;
      text-align: center;
      display: none;
    }
  </style>
</head>
<body>

  <div class="login-card">
    <div class="logo-area">
      <h1>Panel de Debug</h1>
      <p>Inicia sesión para acceder al monitoreo</p>
    </div>

    <div class="error-msg" id="error-box"></div>

    <form id="login-form">
      <div class="form-group">
        <label for="username">Usuario</label>
        <input type="text" id="username" class="form-control" placeholder="Ingresa tu usuario" autocomplete="username" required>
      </div>

      <div class="form-group">
        <label for="password">Contraseña</label>
        <div class="input-wrapper">
          <input type="password" id="password" class="form-control" placeholder="Ingresa tu contraseña" autocomplete="current-password" required>
          <button type="button" class="eye-btn" id="toggle-password" aria-label="Mostrar contraseña">
            <svg id="eye-icon" xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path>
              <circle cx="12" cy="12" r="3"></circle>
            </svg>
          </button>
        </div>
      </div>

      <button type="submit" class="btn-submit">Iniciar Sesión</button>
    </form>
  </div>

  <script>
    const passwordInput = document.getElementById('password');
    const togglePasswordBtn = document.getElementById('toggle-password');
    const eyeIcon = document.getElementById('eye-icon');
    const form = document.getElementById('login-form');
    const errorBox = document.getElementById('error-box');

    // Toggle de visibilidad de contraseña (ojito)
    togglePasswordBtn.addEventListener('click', () => {
      const type = passwordInput.getAttribute('type') === 'password' ? 'text' : 'password';
      passwordInput.setAttribute('type', type);
      
      if (type === 'text') {
        eyeIcon.innerHTML =
          '<path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"></path>' +
          '<line x1="1" y1="1" x2="23" y2="23"></line>';
      } else {
        eyeIcon.innerHTML =
          '<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path>' +
          '<circle cx="12" cy="12" r="3"></circle>';
      }
    });

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      errorBox.style.display = 'none';

      const username = document.getElementById('username').value;
      const password = passwordInput.value;

      try {
        const response = await fetch('/login', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({ username, password })
        });

        const data = await response.json();

        if (response.ok && data.ok) {
          window.location.reload();
        } else {
          errorBox.textContent = data.error || 'Credenciales inválidas.';
          errorBox.style.display = 'block';
        }
      } catch (err) {
        errorBox.textContent = 'Error de conexión con el servidor.';
        errorBox.style.display = 'block';
      }
    });
  </script>
</body>
</html>`);
}
// Endpoint para el historial de eventos recientes en JSON
app.get("/debug/events", requireDebugAuth, async (req, res) => {
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
      .select('id, created_at, trace_id, tenant_id, conversation_id, contact_id, status, started_at, finished_at, duration_ms, hermes_duration_ms, input_tokens, output_tokens, total_tokens, model, tool_names, attempt_count, safe_to_send, response_sent, error_code, phone, session_id, stream_id, patient_display_name, display_name_source')
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

    const maskedEvents = data.map(ev => ({
        ...ev,
        phone: ev.phone ? maskPhone(ev.phone) : 'N/A'
      }));
      res.json({ count: maskedEvents.length, events: maskedEvents });
  } catch (err) {
    console.error("[Dashboard] Exception:", err.message);
    res.status(500).json({ error: true, error_code: "ADAPTER_EVENTS_QUERY_FAILED" });
  }
});

// Servir Dashboard HTML común
function serveDashboard(req, res) {
  res.send(`<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Helios Hermes Adapter - Tracing Panel</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
  <style>
    :root {
      --bg: #09090b;
      --card-bg: rgba(20, 20, 25, 0.6);
      --border: rgba(255, 255, 255, 0.08);
      --text: #f4f4f5;
      --text-muted: #a1a1aa;
      --primary: #6366f1;
      --primary-glow: rgba(99, 102, 241, 0.15);
      --success: #10b981;
      --success-glow: rgba(16, 185, 129, 0.1);
      --warning: #f59e0b;
      --warning-glow: rgba(245, 158, 11, 0.1);
      --danger: #ef4444;
      --danger-glow: rgba(239, 68, 68, 0.1);
    }
    
    * {
      box-sizing: border-box;
      margin: 0;
      padding: 0;
    }
    
    body {
      background-color: var(--bg);
      color: var(--text);
      font-family: 'Outfit', sans-serif;
      padding: 2rem;
      min-height: 100vh;
      background-image: 
        radial-gradient(at 0% 0%, rgba(99, 102, 241, 0.1) 0px, transparent 50%),
        radial-gradient(at 100% 0%, rgba(16, 185, 129, 0.05) 0px, transparent 50%);
    }

    header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 2rem;
      border-bottom: 1px solid var(--border);
      padding-bottom: 1.5rem;
    }

    .title-area h1 {
      font-size: 1.8rem;
      font-weight: 700;
      letter-spacing: -0.02em;
      background: linear-gradient(to right, #ffffff, var(--text-muted));
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
      margin-bottom: 0.25rem;
    }

    .title-area p {
      color: var(--text-muted);
      font-size: 0.9rem;
    }

    .status-badge {
      display: inline-flex;
      align-items: center;
      gap: 0.5rem;
      background: var(--success-glow);
      border: 1px solid var(--success);
      color: var(--success);
      padding: 0.4rem 1rem;
      border-radius: 9999px;
      font-size: 0.85rem;
      font-weight: 600;
    }

    .pulse {
      width: 8px;
      height: 8px;
      background-color: var(--success);
      border-radius: 50%;
      box-shadow: 0 0 0 0 rgba(16, 185, 129, 0.7);
      animation: pulse 1.6s infinite;
    }

    @keyframes pulse {
      0% {
        transform: scale(0.95);
        box-shadow: 0 0 0 0 rgba(16, 185, 129, 0.7);
      }
      70% {
        transform: scale(1);
        box-shadow: 0 0 0 6px rgba(16, 185, 129, 0);
      }
      100% {
        transform: scale(0.95);
        box-shadow: 0 0 0 0 rgba(16, 185, 129, 0);
      }
    }

    .stats-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
      gap: 1.5rem;
      margin-bottom: 2.5rem;
    }

    .stat-card {
      background: var(--card-bg);
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 1.25rem;
      backdrop-filter: blur(10px);
      box-shadow: 0 4px 30px rgba(0, 0, 0, 0.2);
    }

    .stat-label {
      color: var(--text-muted);
      font-size: 0.85rem;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      margin-bottom: 0.5rem;
    }

    .stat-value {
      font-size: 1.6rem;
      font-weight: 600;
      font-family: 'JetBrains Mono', monospace;
    }

    .stat-detail {
      font-size: 0.8rem;
      color: var(--text-muted);
      margin-top: 0.25rem;
    }

    /* Barra de filtros y buscador */
    .filter-bar {
      display: flex;
      flex-direction: column;
      gap: 1rem;
      background: var(--card-bg);
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 1.25rem;
      margin-bottom: 1.5rem;
      backdrop-filter: blur(10px);
    }

    @media (min-width: 768px) {
      .filter-bar {
        flex-direction: row;
        align-items: center;
        justify-content: space-between;
      }
    }

    .search-input-wrapper {
      position: relative;
      flex: 1;
      max-width: 450px;
    }

    .search-input {
      width: 100%;
      background: rgba(0, 0, 0, 0.3);
      border: 1px solid var(--border);
      color: var(--text);
      font-family: inherit;
      font-size: 0.9rem;
      padding: 0.5rem 1rem;
      border-radius: 6px;
      outline: none;
      transition: border-color 0.2s;
    }

    .search-input:focus {
      border-color: var(--primary);
    }

    .filter-buttons {
      display: flex;
      gap: 0.5rem;
      flex-wrap: wrap;
    }

    .section-title {
      font-size: 1.2rem;
      font-weight: 600;
      margin-bottom: 1rem;
      display: flex;
      align-items: center;
      justify-content: space-between;
    }

    .controls {
      display: flex;
      gap: 0.75rem;
    }

    .btn {
      background: rgba(255, 255, 255, 0.05);
      border: 1px solid var(--border);
      color: var(--text);
      padding: 0.4rem 0.8rem;
      border-radius: 6px;
      cursor: pointer;
      font-family: inherit;
      font-size: 0.85rem;
      transition: all 0.2s;
    }

    .btn:hover {
      background: rgba(255, 255, 255, 0.1);
      border-color: rgba(255, 255, 255, 0.2);
    }

    .btn.active {
      background: var(--primary-glow);
      border-color: var(--primary);
      color: #a5b4fc;
    }

    .requests-list {
      display: flex;
      flex-direction: column;
      gap: 1rem;
    }

    .request-card {
      background: var(--card-bg);
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 1.25rem 1.5rem;
      transition: border-color 0.2s, transform 0.2s;
      position: relative;
      overflow: hidden;
      cursor: pointer;
    }

    .request-card:hover {
      border-color: rgba(255, 255, 255, 0.18);
      transform: translateY(-2px);
      background: rgba(25, 25, 30, 0.7);
    }

    .request-card.status-ok {
      border-left: 4px solid var(--success);
    }

    .request-card.status-started {
      border-left: 4px solid var(--primary);
    }

    .request-card.status-handoff {
      border-left: 4px solid var(--warning);
    }

    .request-card.status-error {
      border-left: 4px solid var(--danger);
    }

    .card-header {
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      margin-bottom: 0.75rem;
      flex-wrap: wrap;
      gap: 0.5rem;
    }

    .card-meta {
      display: flex;
      gap: 0.75rem;
      align-items: center;
      flex-wrap: wrap;
    }

    .timestamp {
      color: var(--text-muted);
      font-size: 0.8rem;
      font-family: 'JetBrains Mono', monospace;
    }

    .badge {
      font-size: 0.75rem;
      font-weight: 600;
      padding: 0.2rem 0.5rem;
      border-radius: 4px;
      text-transform: uppercase;
      font-family: 'JetBrains Mono', monospace;
    }

    .badge-started {
      background: var(--primary-glow);
      color: var(--primary);
      border: 1px solid rgba(99, 102, 241, 0.3);
    }

    .badge-ok {
      background: var(--success-glow);
      color: var(--success);
      border: 1px solid rgba(16, 185, 129, 0.3);
    }

    .badge-handoff {
      background: var(--warning-glow);
      color: var(--warning);
      border: 1px solid rgba(245, 158, 11, 0.3);
    }

    .badge-error {
      background: var(--danger-glow);
      color: var(--danger);
      border: 1px solid rgba(239, 68, 68, 0.3);
    }

    .card-grid-info {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
      gap: 0.5rem;
      font-size: 0.8rem;
      color: var(--text-muted);
      margin-bottom: 0.75rem;
    }

    .info-line span {
      font-weight: 500;
    }

    .info-line code {
      font-family: 'JetBrains Mono', monospace;
      color: #e4e4e7;
    }

    .card-message-previews {
      background: rgba(0, 0, 0, 0.2);
      padding: 0.75rem;
      border-radius: 6px;
      font-size: 0.85rem;
      display: flex;
      flex-direction: column;
      gap: 0.5rem;
      border: 1px solid rgba(255, 255, 255, 0.02);
    }

    .preview-box {
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      color: #d4d4d8;
    }

    .preview-box strong {
      font-size: 0.75rem;
      text-transform: uppercase;
      color: var(--text-muted);
      margin-right: 0.5rem;
    }

    .empty-state {
      text-align: center;
      padding: 4rem;
      color: var(--text-muted);
      border: 1px dashed var(--border);
      border-radius: 12px;
      background: var(--card-bg);
    }

    /* Estilos del Drawer */
    .drawer-overlay {
      position: fixed;
      top: 0;
      left: 0;
      width: 100%;
      height: 100%;
      background: rgba(0, 0, 0, 0.5);
      backdrop-filter: blur(4px);
      z-index: 999;
      display: none;
    }
    .drawer-overlay.open {
      display: block;
    }

    .drawer {
      position: fixed;
      top: 0;
      right: 0;
      width: 100%;
      max-width: 650px;
      height: 100%;
      background: #09090b;
      border-left: 1px solid var(--border);
      box-shadow: -10px 0 35px rgba(0, 0, 0, 0.6);
      z-index: 1000;
      transform: translateX(100%);
      transition: transform 0.3s cubic-bezier(0.4, 0, 0.2, 1);
      display: flex;
      flex-direction: column;
      backdrop-filter: blur(20px);
    }

    .drawer.open {
      transform: translateX(0);
    }

    .drawer-header {
      padding: 1.5rem;
      border-bottom: 1px solid var(--border);
      display: flex;
      justify-content: space-between;
      align-items: center;
      background: rgba(20, 20, 25, 0.4);
    }

    .drawer-title {
      font-size: 1.25rem;
      font-weight: 700;
      color: #fff;
      display: flex;
      align-items: center;
      gap: 0.75rem;
    }

    .drawer-close-btn {
      background: none;
      border: none;
      color: var(--text-muted);
      cursor: pointer;
      font-size: 1.75rem;
      display: flex;
      align-items: center;
      transition: color 0.2s;
    }

    .drawer-close-btn:hover {
      color: #fff;
    }

    .drawer-body {
      padding: 1.5rem;
      overflow-y: auto;
      flex: 1;
      display: flex;
      flex-direction: column;
      gap: 1.5rem;
    }

    .detail-section {
      background: rgba(255, 255, 255, 0.02);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 1.25rem;
      position: relative;
    }

    .detail-section-title {
      font-size: 0.8rem;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      color: var(--primary);
      margin-bottom: 0.75rem;
      display: flex;
      justify-content: space-between;
      align-items: center;
    }

    .btn-copy {
      background: rgba(255, 255, 255, 0.05);
      border: 1px solid var(--border);
      color: var(--text-muted);
      padding: 0.2rem 0.5rem;
      border-radius: 4px;
      font-size: 0.7rem;
      cursor: pointer;
      transition: all 0.2s;
    }

    .btn-copy:hover {
      background: var(--primary-glow);
      color: var(--primary);
      border-color: var(--primary);
    }

    .detail-pre {
      background: #040405;
      border: 1px solid rgba(255, 255, 255, 0.03);
      padding: 0.75rem;
      border-radius: 6px;
      font-family: 'JetBrains Mono', monospace;
      font-size: 0.75rem;
      white-space: pre-wrap;
      word-break: break-all;
      color: #e2e2e7;
      max-height: 250px;
      overflow-y: auto;
    }

    .grid-2col {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
      gap: 0.75rem;
    }

    .grid-item {
      display: flex;
      flex-direction: column;
      gap: 0.25rem;
    }

    .grid-item span {
      font-size: 0.75rem;
      color: var(--text-muted);
      text-transform: uppercase;
      letter-spacing: 0.02em;
    }

    .grid-item div {
      font-family: 'JetBrains Mono', monospace;
      font-size: 0.85rem;
      color: #fff;
    }
  </style>
</head>
<body>

  <header>
    <div class="title-area">
      <h1>Helios Hermes Adapter</h1>
      <p>Panel de Control y Monitoreo de Trazas</p>
    </div>
    <div style="display: flex; align-items: center; gap: 1rem;">
      <div class="status-badge">
        <div class="pulse"></div>
        Servicio Activo
      </div>
      <button class="btn" onclick="logout()" style="background: rgba(239, 68, 68, 0.1); border: 1px solid rgba(239, 68, 68, 0.3); color: var(--danger); font-weight: 500;">
        Cerrar Sesión
      </button>
    </div>
  </header>

  <div class="stats-grid">
    <div class="stat-card">
      <div class="stat-label">Versión</div>
      <div class="stat-value" style="color: var(--primary);">2.4.14</div>
      <div class="stat-detail">Node.js 20+</div>
    </div>
    <div class="stat-card">
      <div class="stat-label">Modo</div>
      <div class="stat-value" style="font-size: 1.1rem; padding-top: 0.5rem; word-break: break-all;">STREAM_API</div>
      <div class="stat-detail">Conexión directa SSE</div>
    </div>
    <div class="stat-card">
      <div class="stat-label">Sesiones Hermes</div>
      <div class="stat-value" id="session-count">-</div>
      <div class="stat-detail">Mapeadas en memoria</div>
    </div>
    <div class="stat-card">
      <div class="stat-label">Último Evento</div>
      <div class="stat-value" id="last-event-time" style="font-size: 0.95rem; padding-top: 0.5rem;">Ninguno</div>
      <div class="stat-detail">Procesado recientemente</div>
    </div>
  </div>

  <!-- Barra de Filtros y Búsqueda -->
  <div class="filter-bar">
    <div class="search-input-wrapper">
      <input type="text" id="search-box" class="search-input" placeholder="Buscar por Trace ID, Conv ID, Contact ID..." oninput="applyFiltersAndSearch()">
    </div>
    <div class="filter-buttons">
      <button class="btn active" id="filter-all" onclick="setFilter('all')">Todos</button>
      <button class="btn" id="filter-ok" onclick="setFilter('ok')">OK</button>
      <button class="btn" id="filter-processing" onclick="setFilter('processing')">Procesando</button>
      <button class="btn" id="filter-buffered" onclick="setFilter('buffered')">Derivados</button>
      <button class="btn" id="filter-error" onclick="setFilter('error')">Errores</button>
    </div>
  </div>

  <div class="section-title">
    <span>Historial Reciente (Últimos 50 Requests)</span>
    <div class="controls">
      <button class="btn active" id="btn-auto">Auto-refrescar (5s)</button>
      <button class="btn" id="btn-manual">Refrescar Ahora</button>
    </div>
  </div>

  <!-- Panel de diagnóstico pequeño -->
  <div id="diag-panel" style="margin: 0 0 1rem 0; padding: 0.75rem 1rem; background: rgba(20,20,25,0.4); border: 1px solid rgba(255,255,255,0.06); border-radius: 8px; font-family: 'JetBrains Mono', monospace;"></div>

  <div class="requests-list" id="requests-container">
    <div class="empty-state" id="initial-loading-msg">Iniciando carga de eventos...</div>
  </div>

  <!-- Estructura del Drawer Lateral -->
  <div class="drawer-overlay" id="drawer-overlay" onclick="closeDrawer()"></div>
  <div class="drawer" id="drawer">
    <div class="drawer-header">
      <div class="drawer-title" id="drawer-title-area">
        <span>Detalle de Traza</span>
      </div>
      <button class="drawer-close-btn" onclick="closeDrawer()">&times;</button>
    </div>
    <div class="drawer-body" id="drawer-body-area">
      <!-- Se llena dinámicamente -->
    </div>
  </div>

<script>
    let autoRefresh = true;
    let refreshInterval = null;
    let currentFilter = 'all';
    let rawEventsList = [];
    let lastEventsJson = '';
    let currentOpenEventId = null;
    let firstLoadDone = false;
    let lastLoadStatus = null;
    let lastLoadTime = null;
    let lastLoadCount = 0;
    let lastLoadError = null;

    const btnAuto = document.getElementById('btn-auto');
    const btnManual = document.getElementById('btn-manual');
    const container = document.getElementById('requests-container');
    const sessionCountEl = document.getElementById('session-count');
    const lastEventTimeEl = document.getElementById('last-event-time');
    const searchBox = document.getElementById('search-box');

    const urlParams = new URLSearchParams(window.location.search);
    const token = urlParams.get('token') || '';

    function logout() {
      const isSecure = window.location.protocol === 'https:' || window.location.hostname === 'localhost';
      const cookieOptions = isSecure ? '; Path=/; Secure; SameSite=Lax' : '; Path=/; SameSite=Lax';
      document.cookie = 'debug_token=; Expires=Thu, 01 Jan 1970 00:00:01 GMT' + cookieOptions;
      
      fetch('/logout', { credentials: 'include' }).catch(() => {}).finally(() => {
        window.location.replace('/');
      });
    }

    function showDiagnosticPanel() {
      const panel = document.getElementById('diag-panel');
      if (!panel) return;
      const ts = lastLoadTime ? new Date(lastLoadTime).toLocaleTimeString() : 'N/A';
      panel.innerHTML =
        '<strong style="color: var(--text-muted); font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.05em;">Diagnóstico</strong>' +
        '<div style="margin-top: 0.4rem; display: grid; grid-template-columns: 1fr 1fr; gap: 0.3rem 1rem; font-size: 0.8rem;">' +
          '<span style="color: var(--text-muted);">Ultima carga:</span><span>' + ts + '</span>' +
          '<span style="color: var(--text-muted);">HTTP Status:</span><span style="color: ' + (lastLoadStatus === 200 ? 'var(--success)' : 'var(--danger)') + '">' + (lastLoadStatus || 'N/A') + '</span>' +
          '<span style="color: var(--text-muted);">Eventos recibidos:</span><span>' + lastLoadCount + '</span>' +
          '<span style="color: var(--text-muted);">Error:</span><span style="color: var(--danger);">' + (lastLoadError || 'Ninguno') + '</span>' +
        '</div>';
    }

    async function loadData() {
      lastLoadError = null;
      try {
        const queryParam = token ? '?token=' + encodeURIComponent(token) : '';

        try {
          const healthRes = await fetch('/health', { credentials: 'include' });
          if (healthRes.ok) {
            const healthData = await healthRes.json();
            sessionCountEl.textContent = healthData.session_count || 0;
          }
        } catch (_) {}

        const eventsUrl = '/debug/events' + queryParam;
        const res = await fetch(eventsUrl, { credentials: 'include' });

        lastLoadStatus = res.status;
        lastLoadTime = Date.now();

        if (res.status === 401) {
          lastLoadError = 'No autorizado (401)';
          container.innerHTML = '<div class="empty-state" style="color: var(--danger); border-color: rgba(239,68,68,0.2); background: rgba(239,68,68,0.05);">No autorizado para cargar eventos. Vuelve a iniciar sesión.</div>';
          showDiagnosticPanel();
          return;
        }
        if (res.status === 403) {
          lastLoadError = 'Acceso denegado (403)';
          container.innerHTML = '<div class="empty-state" style="color: var(--danger); border-color: rgba(239,68,68,0.2); background: rgba(239,68,68,0.05);">Acceso denegado para cargar eventos.</div>';
          showDiagnosticPanel();
          return;
        }
        if (res.status === 500) {
          lastLoadError = 'Error interno del servidor (500)';
          container.innerHTML = '<div class="empty-state" style="color: var(--danger); border-color: rgba(239,68,68,0.2); background: rgba(239,68,68,0.05);">Error interno cargando eventos (500).</div>';
          showDiagnosticPanel();
          return;
        }
        if (!res.ok) {
          lastLoadError = 'HTTP ' + res.status;
          throw new Error('HTTP ' + res.status);
        }

        const contentType = res.headers.get('content-type') || '';
        if (!contentType.includes('application/json')) {
          lastLoadError = 'Respuesta no es JSON (content-type: ' + contentType + ')';
          throw new Error('Respuesta inválida de /debug/events: no es JSON');
        }

        const data = await res.json();
        if (data && data.error) {
          lastLoadError = data.message || 'Error desconocido del servidor';
          throw new Error(lastLoadError);
        }

        let events = [];
        if (Array.isArray(data)) {
          events = data;
        } else if (data && Array.isArray(data.events)) {
          events = data.events;
        }

        const newEventsJson = JSON.stringify(events);
        lastLoadCount = events.length;
        firstLoadDone = true;
        showDiagnosticPanel();

        if (lastEventsJson !== newEventsJson) {
          rawEventsList = events;
          lastEventsJson = newEventsJson;
          applyFiltersAndSearch();
          
          if (currentOpenEventId && document.getElementById('drawer').classList.contains('open')) {
            openEventDetail(currentOpenEventId);
          }
        }
      } catch (err) {
        console.error('[dashboard] Error cargando eventos:', err.message);
        lastLoadError = err.message;
        lastLoadTime = Date.now();
        showDiagnosticPanel();
        container.innerHTML = '<div class="empty-state" style="color: var(--danger); border-color: rgba(239,68,68,0.2); background: rgba(239,68,68,0.05);">Error cargando eventos: ' + escapeHtml(err.message) + '</div>';
      } finally {
        const loadingMsg = document.getElementById('initial-loading-msg');
        if (loadingMsg) loadingMsg.style.display = 'none';
      }
    }

    function setFilter(filterType) {
      currentFilter = filterType;
      
      const buttons = ['all', 'ok', 'processing', 'buffered', 'error'];
      buttons.forEach(b => {
        const btn = document.getElementById('filter-' + b);
        if (btn) {
          if (b === filterType) {
            btn.classList.add('active');
          } else {
            btn.classList.remove('active');
          }
        }
      });

      applyFiltersAndSearch();
    }

    function applyFiltersAndSearch() {
      const searchTerm = searchBox.value.trim().toLowerCase();
      
      let filtered = rawEventsList;

      if (currentFilter !== 'all') {
        filtered = filtered.filter(ev => ev.status === currentFilter);
      }

      if (searchTerm) {
        filtered = filtered.filter(ev => {
          return (ev.trace_id && ev.trace_id.toLowerCase().includes(searchTerm)) ||
                 (ev.conversation_id && ev.conversation_id.toString().toLowerCase().includes(searchTerm)) ||
                 (ev.contact_id && ev.contact_id.toString().toLowerCase().includes(searchTerm));
        });
      }

      renderList(filtered);
    }

    function renderList(events) {
      if (events.length === 0) {
        if (!firstLoadDone) {
          container.innerHTML = '<div class="empty-state">No se encontraron eventos todavía. El adapter responderá aquí cuando procese mensajes.</div>';
        } else {
          container.innerHTML = '<div class="empty-state">No hay eventos con los filtros seleccionados.</div>';
        }
        return;
      }

      if (rawEventsList.length > 0) {
        const latestEv = rawEventsList[0];
        const latestTime = latestEv.started_at || latestEv.created_at;
        if (latestTime) {
          const date = new Date(latestTime);
          if (!isNaN(date)) lastEventTimeEl.textContent = date.toLocaleTimeString();
        }
      }

      container.innerHTML = events.map(ev => {
        const statusClass = 'status-' + ev.status;
        const badgeClass = 'badge-' + ev.status;
        const evTime = ev.started_at || ev.created_at;
        const formattedDate = evTime ? new Date(evTime).toLocaleString() : 'N/A';
        const durationText = ev.duration_ms !== null && ev.duration_ms !== undefined ? ev.duration_ms + 'ms' : 'N/A';
        const traceShort = ev.trace_id ? ev.trace_id.slice(0, 8) + '...' : 'N/A';
        
        let detailToolsList = 'Ninguna';
        if (ev.tool_names) {
          let dt = ev.tool_names;
          try { if (typeof dt === 'string') dt = JSON.parse(dt); } catch(e){}
          if (Array.isArray(dt) && dt.length > 0) detailToolsList = escapeHtml(dt.join(', '));
        }
        
        const tokenText = (ev.input_tokens !== null ? ev.input_tokens.toLocaleString() : 'N/A') + ' / ' +
                          (ev.output_tokens !== null ? ev.output_tokens.toLocaleString() : 'N/A') + ' / ' +
                          (ev.total_tokens !== null ? ev.total_tokens.toLocaleString() : 'N/A');
        
        let toolsList = 'Ninguna';
        if (ev.tool_names) {
          let t = ev.tool_names;
          try { if (typeof t === 'string') t = JSON.parse(t); } catch(e){}
          if (Array.isArray(t) && t.length > 0) toolsList = escapeHtml(t.join(', '));
        }

        return '<div class="request-card ' + statusClass + '" data-id="' + escapeHtml(ev.id) + '">' +
          '<div class="card-header">' +
            '<div class="card-meta">' +
              '<span class="badge ' + badgeClass + '">' + ev.status + '</span>' +
              '<span class="timestamp">' + formattedDate + '</span>' +
              '<span class="timestamp" style="color: var(--primary); font-weight: 500;">⏱️ ' + durationText + '</span>' +
              '<span class="timestamp" style="color: #818cf8; font-weight: 500;">🪙 Tokens: ' + tokenText + '</span>' +
            '</div>' +
            '<div style="font-size: 0.8rem; color: var(--text-muted);">' +
              'Trace: <code style="font-family: monospace; color: #fff;">' + traceShort + '</code>' +
            '</div>' +
          '</div>' +
          '<div class="card-grid-info">' +
            '<div class="info-line" style="grid-column: 1 / -1;">Nombre: <code>' + escapeHtml(ev.patient_display_name || 'N/A') + '</code></div>' +
            '<div class="info-line">Tel: <code>' + escapeHtml(ev.phone || 'N/A') + '</code></div>' +
            '<div class="info-line">Conv: <code>' + escapeHtml(ev.conversation_id || 'N/A') + '</code></div>' +
            '<div class="info-line">Contact: <code>' + escapeHtml(ev.contact_id || 'N/A') + '</code></div>' +
            '<div class="info-line">Session: <code>' + escapeHtml(ev.session_id ? ev.session_id.slice(0, 12) + '...' : 'N/A') + '</code></div>' +
            '<div class="info-line">Stream: <code>' + escapeHtml(ev.stream_id ? ev.stream_id.slice(0, 12) + '...' : 'N/A') + '</code></div>' +
          '</div>' +
          (ev.error_code ? '<div class="error-msg" style="margin-top: 0.5rem; padding: 0.5rem;"><strong>Error:</strong> ' + escapeHtml(ev.error_code) + '</div>' : '') +
        '</div>';
      }).join('');
    }

    function openEventDetail(eventId) {
      currentOpenEventId = eventId;
      const ev = rawEventsList.find(e => String(e.id) === String(eventId));
      if (!ev) return;

      const overlay = document.getElementById('drawer-overlay');
      const drawer = document.getElementById('drawer');
      const titleArea = document.getElementById('drawer-title-area');
      const bodyArea = document.getElementById('drawer-body-area');

      const badgeClass = 'badge-' + ev.status;
      titleArea.innerHTML = '<span class="badge ' + badgeClass + '">' + ev.status + '</span> <span>Detalle de Traza</span>';

      const evTime = ev.started_at || ev.created_at;

      let bodyHtml = '';
      bodyHtml += '<div class="detail-section">' +
        '<div class="detail-section-title">A. Resumen de la Traza</div>' +
        '<div class="grid-2col">' +
          '<div class="grid-item"><span>Timestamp</span><div>' + (evTime ? new Date(evTime).toLocaleString() : 'N/A') + '</div></div>' +
          '<div class="grid-item"><span>Nombre</span><div>' + escapeHtml(ev.patient_display_name || 'N/A') + '</div></div>' +
          '<div class="grid-item"><span>Teléfono</span><div>' + escapeHtml(ev.phone || 'N/A') + '</div></div>' +
          '<div class="grid-item"><span>Session ID</span><div>' + escapeHtml(ev.session_id || 'N/A') + '</div></div>' +
          '<div class="grid-item"><span>Stream ID</span><div>' + escapeHtml(ev.stream_id || 'N/A') + '</div></div>' +
          '<div class="grid-item"><span>Trace ID Completo</span><div>' + escapeHtml(ev.trace_id || 'N/A') + '</div></div>' +
          '<div class="grid-item"><span>Tenant ID</span><div>' + escapeHtml(ev.tenant_id || 'N/A') + '</div></div>' +
          '<div class="grid-item"><span>Conv ID</span><div>' + escapeHtml(ev.conversation_id || 'N/A') + '</div></div>' +
          '<div class="grid-item"><span>Contact ID</span><div>' + escapeHtml(ev.contact_id || 'N/A') + '</div></div>' +
          '<div class="grid-item"><span>Duración</span><div>' + (ev.duration_ms !== null && ev.duration_ms !== undefined ? ev.duration_ms + ' ms' : 'N/A') + '</div></div>' +
          '<div class="grid-item"><span>Hermes Duración</span><div>' + (ev.hermes_duration_ms !== null && ev.hermes_duration_ms !== undefined ? ev.hermes_duration_ms + ' ms' : 'N/A') + '</div></div>' +
          '<div class="grid-item"><span>Intentos</span><div>' + (ev.attempt_count || '1') + '</div></div>' +
          '<div class="grid-item"><span>Safe to Send</span><div>' + (ev.safe_to_send ? 'SÍ' : 'NO') + '</div></div>' +
          '<div class="grid-item"><span>Response Sent</span><div>' + (ev.response_sent ? 'SÍ' : 'NO') + '</div></div>' +
        '</div>' +
      '</div>';

      bodyHtml += '<div class="detail-section" style="border-color: rgba(99, 102, 241, 0.2);">' +
        '<div class="detail-section-title" style="color: #818cf8;">H. Uso de Tokens</div>' +
        '<div class="grid-2col">' +
          '<div class="grid-item"><span>Modelo</span><div>' + (ev.model || 'N/A') + '</div></div>' +
          '<div class="grid-item"><span>Input Tokens</span><div>' + (ev.input_tokens !== null ? ev.input_tokens.toLocaleString() : 'N/A') + '</div></div>' +
          '<div class="grid-item"><span>Output Tokens</span><div>' + (ev.output_tokens !== null ? ev.output_tokens.toLocaleString() : 'N/A') + '</div></div>' +
          '<div class="grid-item"><span>Total Tokens</span><div>' + (ev.total_tokens !== null ? ev.total_tokens.toLocaleString() : 'N/A') + '</div></div>' +
          '<div class="grid-item"><span>Herramientas Usadas</span><div>' + (function(t){if(!t)return 'Ninguna';try{if(typeof t==='string')t=JSON.parse(t);}catch(e){}if(Array.isArray(t)&&t.length>0)return escapeHtml(t.join(', '));return 'Ninguna'})(ev.tool_names) + '</div></div>' +
        '</div>' +
      '</div>';

      // Payload details were omitted for privacy.

      if (ev.status === 'error' || ev.error_code) {
        bodyHtml += '<div class="detail-section" style="background: rgba(239, 68, 68, 0.05); border-color: rgba(239, 68, 68, 0.2);">' +
          '<div class="detail-section-title" style="color: var(--danger);">G. Errores</div>' +
          '<div class="grid-2col">' +
            '<div class="grid-item"><span>Error Code</span><div style="color: var(--danger);">' + escapeHtml(ev.error_code || 'N/A') + '</div></div>' +
          '</div>' +
        '</div>';
      }

      bodyArea.innerHTML = bodyHtml;

      overlay.classList.add('open');
      drawer.classList.add('open');
    }

    function closeDrawer() {
      currentOpenEventId = null;
      document.getElementById('drawer').classList.remove('open');
      document.getElementById('drawer-overlay').classList.remove('open');
    }

    function copyContent(elementId) {
      const text = document.getElementById(elementId).textContent;
      navigator.clipboard.writeText(text).then(() => {
        const btn = document.querySelector('[data-copy="' + elementId + '"]');
        if (!btn) return;
        const origText = btn.textContent;
        btn.textContent = '¡Copiado!';
        btn.style.color = 'var(--success)';
        btn.style.borderColor = 'var(--success)';
        setTimeout(() => {
          btn.textContent = origText;
          btn.style.color = '';
          btn.style.borderColor = '';
        }, 1500);
      });
    }

    document.addEventListener('click', function(e) {
      const card = e.target.closest('.request-card');
      if (card && card.dataset.id) {
        openEventDetail(card.dataset.id);
      }
      const copyBtn = e.target.closest('.btn-copy');
      if (copyBtn && copyBtn.dataset.copy) {
        copyContent(copyBtn.dataset.copy);
      }
    });

    function escapeHtml(text) {
      if (!text) return '';
      return text
        .toString()
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
    }

    function startInterval() {
      if (refreshInterval) clearInterval(refreshInterval);
      refreshInterval = setInterval(loadData, 5000);
    }
    
    function stopInterval() {
      if (refreshInterval) clearInterval(refreshInterval);
      refreshInterval = null;
    }

    btnAuto.addEventListener('click', () => {
      autoRefresh = !autoRefresh;
      if (!autoRefresh) {
        stopInterval();
        btnAuto.classList.remove('active');
        btnAuto.textContent = 'Auto-refrescar (Apagado)';
      } else {
        startInterval();
        loadData();
        btnAuto.classList.add('active');
        btnAuto.textContent = 'Auto-refrescar (5s)';
      }
    });

    btnManual.addEventListener('click', () => {
      loadData();
    });

    if (autoRefresh) {
      btnAuto.classList.add('active');
      btnAuto.textContent = 'Auto-refrescar (5s)';
      startInterval();
    }

    loadData();
  </script>
</body>
</html>`);
}

// Rutas protegidas para servir el Dashboard y los Eventos
app.get("/", requireDebugAuth, serveDashboard);

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
  let masked = text.replace(/([a-zA-Z0-9._-]+@[a-zA-Z0-9._-]+\.[a-zA-Z0-9._-]+)/gi, "[EMAIL]");
  masked = masked.replace(/(\+?\d{7,15})/g, "[PHONE]");
  return masked.slice(0, 160);
}

function extractResponsePreview(responseObj) {
  if (!responseObj) return "";
  let reply = "";
  if (typeof responseObj === 'string') {
    reply = responseObj;
  } else {
    reply = responseObj.message_for_client || responseObj.reply_text || responseObj.reply || "";
  }
  
  if (!reply) return "";

  const lowerReply = reply.toLowerCase();
  const forbiddenPhrases = [
    "pensando",
    "razonamiento",
    "el paciente ha dado",
    "según las reglas",
    "perfil incompleto",
    "display_name",
    "buffer",
    "tool",
    "{"
  ];

  const containsForbidden = forbiddenPhrases.some(phrase => lowerReply.includes(phrase));
  const hasReasoning = lowerReply.includes("<think>") || lowerReply.includes("```json") || containsForbidden;

  // We can also call the existing containsInternalReasoning if it's hoisted, but 
  // since order of definitions might be tricky, we just use our strict check.
  if (hasReasoning) {
    return "";
  }

  return reply.replace(/<think>[\s\S]*?<\/think>/gi, "").replace(/```json[\s\S]*?```/gi, "").trim().slice(0, 200);
}

function extractPhone(normalized, payload, input) {
  return normalized?.conversation?.phone || normalized?.patient?.phone || payload?.conversation?.phone || payload?.patient?.phone || input?.conversation?.phone || input?.patient?.phone || null;
}

function getPatientDisplayName(patient) {
  if (!patient) return "Contacto sin identificar";
  if (patient.profile_complete === true && patient.first_name && patient.last_name) {
    return patient.first_name + " " + patient.last_name;
  }
  if (patient.chatwoot_display_name) return patient.chatwoot_display_name;
  
  return "Contacto sin identificar";
}

function getDisplayNameSource(patient) {
  if (!patient) return "unknown";
  if (patient.profile_complete === true && patient.first_name && patient.last_name) return "verified_profile";
  if (patient.chatwoot_display_name) return "chatwoot";
  return "unknown";
}

app.post("/helios/message", async (req, res) => {
  let processingStage = "request_received";
  let requestPhone = null;
  let requestPatientDisplayName = "Contacto sin identificar";
  processingStage = "telemetry_started";
  const telemetryCtx = await startAdapterEvent(req.body || {});
  const startTime = Date.now();
  const uniqueEventId = crypto.randomUUID();
  const payload = req.body || {};
  
  let normalized;
  try {
    normalized = normalizeGatewayPayload(payload);
  } catch (err) {
    normalized = { raw: payload };
  }

  // Crear debugEvent al inicio y agregarlo inmediatamente
  const debugEvent = {
    id: uniqueEventId,
    timestamp: new Date().toISOString(),
    trace_id: normalized.trace_id || "",
    tenant_id: normalized.tenant_id || "",
    clinic_id: normalized.clinic_id || "",
    conversation_id: normalized.conversation_id || "",
    contact_id: normalized.contact_id || "",
    phone_masked: maskPhone(normalized.phone),
    status: "started",
    route: null,
    intent: null,
    hermes_session_id: null,
    hermes_stream_id: null,
    requires_handoff: false,
    duration_ms: null,

    input_preview: normalized.message_text ? normalized.message_text.slice(0, 1000) : "",
    input_detail: null,

    hermes_request_preview: null,
    hermes_request_detail: null,

    raw_hermes_preview: null,
    raw_hermes_detail: null,

    sanitized_reply_preview: null,
    sanitized_reply: null,

    adapter_response_preview: null,
    adapter_response_detail: null,

    error: null,
    error_type: null,
    timeout_ms: null,

    internal_reasoning_detected: false,
    patient_reply_extracted: false,
    blocked_internal_reasoning: false,
    extraction_strategy: null,
 
    token_usage: {
      exact: false,
      model: null,
      model_provider: null,
      input_tokens: null,
      output_tokens: null,
      total_tokens: null,
      cache_read_tokens: null,
      cache_write_tokens: null,
      estimated_cost: null,
      token_source: "not_available_from_hermes",
      cost_source: "not_available_from_hermes",
      token_lookup_attempts: [],
      tool_calls: []
    }
  };

  try {
    const input_detail = {
      event: normalized.event,
      tenant_id: normalized.tenant_id,
      clinic_id: normalized.clinic_id,
      channel: normalized.channel,
      conversation: {
        conversation_id: normalized.conversation_id,
        contact_id: normalized.contact_id,
        inbox_id: normalized.inbox_id,
        phone: maskPhone(normalized.phone)
      },
      patient: {
        profile_exists: normalized.patient?.profile_exists,
        profile_complete: normalized.patient?.profile_complete,
        name: normalized.patient?.name,
        email: normalized.patient?.email ? maskEmail(normalized.patient.email) : undefined
      },
      state: normalized.state,
      message: {
        text: normalized.message_text,
        message_count: normalized.message_count,
        messages: normalized.message_items
      }
    };
    debugEvent.input_detail = JSON.stringify(input_detail, null, 2);

    const messageToHermes = buildHermesMessage(normalized);
    debugEvent.hermes_request_preview = messageToHermes.slice(0, 1000);
    debugEvent.hermes_request_detail = messageToHermes;
  } catch (_) {}

  let sessionId = "";
  let streamId = "";
  let rawResponseText = "";
  let finalReply = "";
  let finalStatus = "ok";
  let errorMsg = "";
  let finalRoute = "hermes";
  let finalIntent = "respuesta_hermes";

  try {
    if (!ADAPTER_API_KEY) {
      const errText = "HERMES_API_KEY no está configurada en el adapter";
      debugEvent.status = "error";
      debugEvent.route = "handoff";
      debugEvent.intent = "error_configuracion";
      debugEvent.error = errText.slice(0, 500);
      debugEvent.duration_ms = Date.now() - startTime;
      
      const configErrorResponse = {
        ok: false,
        route: "error",
        intent: "error_configuracion",
        requires_handoff: false,
        safe_to_send: false,
        response_sent: false,
        recoverable: true,
        error_code: "HERMES_API_KEY_MISSING",
        metadata: { error_code: "HERMES_API_KEY_MISSING" },
        error: errText
      };
      debugEvent.adapter_response_preview = JSON.stringify(configErrorResponse).slice(0, 1000);
      debugEvent.adapter_response_detail = JSON.stringify(configErrorResponse, null, 2);

      return res.status(500).json(configErrorResponse);
    }

    const receivedToken = getBearerToken(req);
    if (receivedToken !== ADAPTER_API_KEY) {
      const errText = "Unauthorized access attempt";
      debugEvent.status = "error";
      debugEvent.route = "handoff";
      debugEvent.intent = "unauthorized";
      debugEvent.error = errText;
      debugEvent.duration_ms = Date.now() - startTime;

      const authErrorResponse = {
        ok: false,
        route: "error",
        intent: "unauthorized",
        requires_handoff: false,
        safe_to_send: false,
        response_sent: false,
        recoverable: true,
        error_code: "UNAUTHORIZED",
        metadata: { error_code: "UNAUTHORIZED" },
        error: "Unauthorized"
      };
      debugEvent.adapter_response_preview = JSON.stringify(authErrorResponse).slice(0, 1000);
      debugEvent.adapter_response_detail = JSON.stringify(authErrorResponse, null, 2);

      return res.status(401).json(authErrorResponse);
    }

const hermesStartTime = Date.now();
    let hermesDurationMs = null;
    let result;
    try {
      processingStage = "message_sent";
      result = await sendMessageToHermes(payload);
      hermesDurationMs = Date.now() - hermesStartTime;
    } catch(err) {
      hermesDurationMs = Date.now() - hermesStartTime;
      throw err;
    }
    sessionId = result.sessionId || "";
    streamId = result.streamId || "";
    rawResponseText = result.answer || "";

    debugEvent.hermes_session_id = sessionId;
    debugEvent.hermes_stream_id = streamId;

    if (result.conflict) {
      finalStatus = "error";
      finalRoute = "error";
      finalIntent = "active_stream_conflict";
      errorMsg = "session already has an active stream conflict";

      debugEvent.status = finalStatus;
      debugEvent.route = finalRoute;
      debugEvent.intent = finalIntent;
      debugEvent.error = errorMsg;
      debugEvent.duration_ms = Date.now() - startTime;
      debugEvent.final_reply_preview = "Ahora mismo tuve un problema técnico para procesar tu mensaje. Te voy a derivar con el equipo para ayudarte mejor.";
      debugEvent.sanitized_reply_preview = debugEvent.final_reply_preview;
      debugEvent.sanitized_reply = debugEvent.final_reply_preview;

      const conflictResponse = {
        ok: false,
        reply: debugEvent.final_reply_preview,
        route: finalRoute,
          operation_type: normalizedResponse.operation?.type || null,
          operation_status: normalizedResponse.operation?.status || null,
          operation_summary: normalizedResponse.operation?.summary || null,
          has_profile_patch: Object.keys(normalizedResponse.profile_patch || {}).length > 0,
          has_booking_patch: Object.keys(normalizedResponse.booking_patch || {}).length > 0,
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

      await failAdapterEvent(
        telemetryCtx,
        "ACTIVE_STREAM_CONFLICT",
        hermesDurationMs,
        {
          patient_display_name: requestPatientDisplayName,
          phone: requestPhone,
          hermes_first_token_ms: typeof hermesFirstTokenMs !== 'undefined' ? hermesFirstTokenMs : null,
          session_id: sessionId,
          stream_id: streamId,
          processing_stage: processingStage,
          display_name_source: getDisplayNameSource(normalized?.patient),
          message_preview: maskPreview(normalized?.message_text),
          message_count: normalized?.message_count,
          intent: finalIntent,
          route: finalRoute,
          provider_error_code: "ACTIVE_STREAM_CONFLICT",
          response_preview: extractResponsePreview(conflictResponse)
        }
      );
      
      // Consultar tokens exactos de Hermes
      if (sessionId) {
        try {
          const { sessionData, attempts } = await fetchHermesSessionData(sessionId);
          debugEvent.token_usage = extractTokenUsage(sessionData, attempts);
        } catch (_) {}
      }

      return res.json(conflictResponse);
    }

    processingStage = "contract_parsing";
    const normalizedResponse = normalizeAdapterResponse(result);
    processingStage = "contract_validated";
    finalReply = normalizedResponse.reply || "";
    finalStatus = normalizedResponse.ok ? "ok" : "handoff";
    finalRoute = normalizedResponse.route || "hermes";
    finalIntent = normalizedResponse.intent || "respuesta_hermes";

    debugEvent.status = finalStatus;
    debugEvent.route = finalRoute;
    debugEvent.intent = finalIntent;
    debugEvent.requires_handoff = !normalizedResponse.ok;
    debugEvent.duration_ms = Date.now() - startTime;
    debugEvent.raw_hermes_preview = rawResponseText.slice(0, 1000);
    debugEvent.raw_hermes_detail = rawResponseText;
    debugEvent.sanitized_reply_preview = finalReply.slice(0, 1000);
    debugEvent.sanitized_reply = finalReply;
    debugEvent.final_reply_preview = finalReply.slice(0, 1000);
    if (!normalizedResponse.ok) {
      debugEvent.error = normalizedResponse.intent;
    }

    const hasReasoning = containsInternalReasoning(rawResponseText);
    const wasBlocked = hasReasoning && (!finalReply || containsInternalReasoning(finalReply) || finalIntent === "internal_reasoning_blocked");
    const wasExtracted = hasReasoning && !wasBlocked && finalReply.length > 0;

    debugEvent.internal_reasoning_detected = hasReasoning;
    debugEvent.patient_reply_extracted = wasExtracted;
    debugEvent.blocked_internal_reasoning = wasBlocked;
    debugEvent.extraction_strategy = "last_patient_facing_start";

    debugEvent.adapter_response_preview = JSON.stringify(normalizedResponse).slice(0, 1000);
    debugEvent.adapter_response_detail = JSON.stringify(normalizedResponse, null, 2);

    // Enviar respuesta al Gateway INMEDIATAMENTE
    processingStage = "response_returned";
    res.json(normalizedResponse);

    if (sessionId) {
      try {
        const result = await withTimeout(
          fetchHermesSessionData(sessionId),
          3000,
          { sessionData: null, attempts: [] }
        );
        debugEvent.token_usage = extractTokenUsage(result.sessionData, result.attempts);
      } catch (_) {}
    }

    try {
      await withTimeout(
        finishAdapterEvent(
          telemetryCtx,
          finalStatus,
          { ...normalizedResponse, response_sent: false },
          hermesDurationMs,
          debugEvent.token_usage,
          {
            patient_display_name: requestPatientDisplayName,
              phone: requestPhone,
              hermes_first_token_ms: typeof hermesFirstTokenMs !== 'undefined' ? hermesFirstTokenMs : null,
              session_id: sessionId,
              stream_id: streamId,
              processing_stage: processingStage,
            display_name_source: getDisplayNameSource(normalized?.patient),
            message_preview: maskPreview(normalized?.message_text),
            message_count: normalized?.message_count,
            intent: finalIntent,
            response_preview: extractResponsePreview(normalizedResponse),
            route: finalRoute,
          }
        ),
        3000,
        null
      );
    } catch (_) {}

  } catch (error) {
    if (res.headersSent) {
      console.error("Secondary error after response sent:", {
        name: error?.name || "Error",
        code: error?.code || null,
        message: error?.message || "unknown"
      });
      return;
    }
    
    console.error("Adapter error:", error);
    finalStatus = "error";
    finalRoute = "error";
    finalIntent = "error_tecnico";
    errorMsg = error.message;

    let normalizedError = normalizeProviderError(error);
    if (["assistant_completed_received", "contract_parsing", "contract_validated"].includes(processingStage) && (error.name === "SyntaxError" || error.message.includes("JSON") || error.message.includes("contrato"))) {
      normalizedError = {
        ok: false,
        intent: "technical_error",
        requires_handoff: false,
        safe_to_send: false,
        response_sent: false,
        recoverable: true,
        error_code: "INVALID_HERMES_CONTRACT"
      };
    }
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
        error_code: normalizedError.error_code
      }
    };

    debugEvent.status = finalStatus;
    debugEvent.route = finalRoute;
    debugEvent.intent = finalIntent;
    debugEvent.requires_handoff = normalizedError.requires_handoff;
    debugEvent.duration_ms = Date.now() - startTime;
    debugEvent.error = errorMsg.slice(0, 500);
    debugEvent.error_type = normalizedError.error_code;
    debugEvent.timeout_ms = normalizedError.error_code === 'HERMES_TIMEOUT' ? HERMES_TIMEOUT_MS : null;
    debugEvent.raw_hermes_preview = rawResponseText.slice(0, 1000);
    debugEvent.raw_hermes_detail = rawResponseText;
    debugEvent.final_reply_preview = null;
    debugEvent.sanitized_reply_preview = null;
    debugEvent.sanitized_reply = null;

    const hasReasoningErr = containsInternalReasoning(rawResponseText);
    const wasBlockedErr = hasReasoningErr && (!finalReply || containsInternalReasoning(finalReply) || finalIntent === 'internal_reasoning_blocked');
    const wasExtractedErr = hasReasoningErr && !wasBlockedErr && finalReply.length > 0;

    debugEvent.internal_reasoning_detected = hasReasoningErr;
    debugEvent.patient_reply_extracted = wasExtractedErr;
    debugEvent.blocked_internal_reasoning = wasBlockedErr;
    debugEvent.extraction_strategy = 'last_patient_facing_start';

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
        patient_display_name: requestPatientDisplayName,
          phone: requestPhone,
          hermes_first_token_ms: typeof hermesFirstTokenMs !== 'undefined' ? hermesFirstTokenMs : null,
          session_id: sessionId,
          stream_id: streamId,
          processing_stage: processingStage,
        display_name_source: getDisplayNameSource(normalized?.patient),
        message_preview: maskPreview(normalized?.message_text),
        message_count: normalized?.message_count,
        intent: normalizedError.intent,
        route: "error",
        provider_error_code: normalizedError.error_code,
        response_preview: null
      }
    );
    return res.status(normalizedError.http_status).json(errorResponse);
  }
});

app.listen(PORT, () => {
  console.log(`helios-hermes-adapter v2.4.14 listening on port ${PORT}`);
});
