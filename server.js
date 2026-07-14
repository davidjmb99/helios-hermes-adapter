const express = require("express");
const fs = require("fs");
const crypto = require("crypto");

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

// Memoria para Debugging (Últimos 50 requests)
const recentRequests = [];

function addRecentRequest(reqData) {
  recentRequests.unshift(reqData);
  if (recentRequests.length > 50) {
    recentRequests.length = 50;
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
  if (!sessionId) return null;
  
  const pathsToTry = [
    `/api/session?session_id=${encodeURIComponent(sessionId)}`,
    `/api/session/${encodeURIComponent(sessionId)}`,
    `/api/sessions/${encodeURIComponent(sessionId)}`
  ];

  for (const path of pathsToTry) {
    try {
      const data = await hermesGetRequest(path);
      if (data && (data.session || data.session_id || data.id)) {
        return data;
      }
    } catch (err) {
      console.warn(`Falló GET ${path}:`, err.message);
    }
  }
  return null;
}

function extractTokenUsage(sessionData) {
  if (!sessionData) return null;

  const s = sessionData.session || sessionData;
  const tokenUsage = s.token_usage || {};
  const model = s.model || s.model_id || null;
  const model_provider = s.model_provider || null;

  const input_tokens = typeof tokenUsage.input_tokens === 'number' ? tokenUsage.input_tokens : 
                       (typeof tokenUsage.prompt_tokens === 'number' ? tokenUsage.prompt_tokens : null);
  const output_tokens = typeof tokenUsage.output_tokens === 'number' ? tokenUsage.output_tokens : 
                        (typeof tokenUsage.completion_tokens === 'number' ? tokenUsage.completion_tokens : null);
  const total_tokens = typeof tokenUsage.total_tokens === 'number' ? tokenUsage.total_tokens : 
                       (input_tokens !== null && output_tokens !== null ? input_tokens + output_tokens : null);
  const cache_read_tokens = typeof tokenUsage.cache_read_tokens === 'number' ? tokenUsage.cache_read_tokens : null;
  const cache_write_tokens = typeof tokenUsage.cache_write_tokens === 'number' ? tokenUsage.cache_write_tokens : null;
  const estimated_cost = typeof tokenUsage.estimated_cost === 'number' ? tokenUsage.estimated_cost : null;

  if (input_tokens === null && output_tokens === null) {
    return null;
  }

  return {
    model,
    model_provider,
    input_tokens,
    output_tokens,
    total_tokens,
    cache_read_tokens,
    cache_write_tokens,
    estimated_cost,
    token_source: "hermes_session_api",
    cost_source: estimated_cost !== null ? "hermes_session_api" : "not_calculated"
  };
}

function estimateTokensLocally(inputText, outputText) {
  if (!TOKEN_ESTIMATION_ENABLED) {
    return {
      model: null,
      model_provider: null,
      input_tokens: null,
      output_tokens: null,
      total_tokens: null,
      cache_read_tokens: null,
      cache_write_tokens: null,
      estimated_cost: null,
      token_source: "not_available_from_hermes",
      cost_source: "not_available_from_hermes"
    };
  }

  const estimated_input_tokens = Math.ceil((inputText || "").length / TOKEN_ESTIMATION_CHARS_PER_TOKEN);
  const estimated_output_tokens = Math.ceil((outputText || "").length / TOKEN_ESTIMATION_CHARS_PER_TOKEN);
  const estimated_total_tokens = estimated_input_tokens + estimated_output_tokens;

  return {
    model: HERMES_MODEL || null,
    model_provider: HERMES_MODEL_PROVIDER || null,
    input_tokens: estimated_input_tokens,
    output_tokens: estimated_output_tokens,
    total_tokens: estimated_total_tokens,
    cache_read_tokens: null,
    cache_write_tokens: null,
    estimated_cost: null,
    token_source: "local_estimate_chars_per_token",
    cost_source: "not_calculated"
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

  let accumulatedAnswer = "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let currentEvent = "";

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop(); // Mantener línea incompleta en el buffer

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        if (trimmed.startsWith("event:")) {
          currentEvent = trimmed.slice("event:".length).trim();
        } else if (trimmed.startsWith("data:")) {
          const dataStr = trimmed.slice("data:".length).trim();
          if (dataStr === "[DONE]" || dataStr === "done") {
            break;
          }

          let parsed = {};
          let isJson = false;
          try {
            parsed = JSON.parse(dataStr);
            isJson = true;
          } catch (_) {}

          const eventName = currentEvent || (isJson ? parsed.event : "") || "";

          if (eventName === "token") {
            const token = isJson ? (parsed.text || parsed.token || parsed.content || "") : dataStr;
            accumulatedAnswer += token;
          } else if (eventName === "reasoning") {
            // Ignorar razonamiento
          } else if (eventName === "error") {
            const errorMsg = isJson ? (parsed.error || parsed.message || dataStr) : dataStr;
            throw new Error(`Hermes stream reported error: ${errorMsg}`);
          } else if (["done", "complete", "completed"].includes(eventName)) {
            break;
          }
        }
      }
    }

    // Procesar buffer restante
    if (buffer.trim()) {
      const trimmed = buffer.trim();
      if (trimmed.startsWith("data:")) {
        const dataStr = trimmed.slice("data:".length).trim();
        if (dataStr !== "[DONE]" && dataStr !== "done") {
          let parsed = {};
          let isJson = false;
          try {
            parsed = JSON.parse(dataStr);
            isJson = true;
          } catch (_) {}
          const eventName = currentEvent || (isJson ? parsed.event : "") || "";
          if (eventName === "token") {
            const token = isJson ? (parsed.text || parsed.token || parsed.content || "") : dataStr;
            accumulatedAnswer += token;
          }
        }
      }
    }
  } finally {
    clearTimeout(timeout);
    try {
      reader.cancel();
    } catch (_) {}
  }

  return accumulatedAnswer;
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

    answer = await consumeHermesStreamWithRetry(streamId);
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
    "el token de ghl",
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
  return extractLastPatientFacingReply(text);
}

function normalizeAdapterResponse(result) {
  const rawReply = result.answer || "";
  
  if (isProviderErrorText(rawReply)) {
    return {
      ok: false,
      reply:
        "Ahora mismo tuve un problema técnico para procesar tu mensaje. Te voy a derivar con el equipo para ayudarte mejor.",
      route: "handoff",
      intent: "provider_error",
      requires_handoff: true,
      tool_calls: [],
      case_tracking: {
        requires_case_tracking: true,
        reason: "provider_limit_or_model_error"
      },
      metadata: {
        profile: HERMES_PROFILE,
        hermes_session_id: result.sessionId,
        provider_error: true
      }
    };
  }

  const sanitizedReply = sanitizePatientReply(rawReply);

  // Verificar si hay razonamiento interno bloqueado
  if (containsInternalReasoning(rawReply) && (!sanitizedReply || containsInternalReasoning(sanitizedReply))) {
    return {
      ok: false,
      reply:
        "Ahora mismo no pude generar una respuesta adecuada. Te voy a derivar con el equipo para ayudarte mejor.",
      route: "handoff",
      intent: "internal_reasoning_blocked",
      requires_handoff: true,
      tool_calls: [],
      case_tracking: {
        requires_case_tracking: true,
        reason: "internal_reasoning_blocked"
      },
      metadata: {
        profile: HERMES_PROFILE,
        hermes_session_id: result.sessionId,
        internal_reasoning_blocked: true
      }
    };
  }

  if (!sanitizedReply) {
    return {
      ok: false,
      reply:
        "Ahora mismo tuve un problema técnico para procesar tu mensaje. Te voy a derivar con el equipo para ayudarte mejor.",
      route: "handoff",
      intent: "empty_hermes_response",
      requires_handoff: true,
      tool_calls: [],
      case_tracking: {
        requires_case_tracking: true,
        reason: "empty_hermes_response"
      },
      metadata: {
        profile: HERMES_PROFILE,
        hermes_session_id: result.sessionId
      }
    };
  }

  return {
    ok: true,
    reply: sanitizedReply,
    route: "hermes",
    intent: "respuesta_hermes",
    requires_handoff: false,
    tool_calls: [],
    case_tracking: {
      requires_case_tracking: false
    },
    metadata: {
      profile: HERMES_PROFILE,
      hermes_session_id: result.sessionId
    }
  };
}

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    service: "helios-hermes-adapter",
    version: "2.4.8",
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
app.post("/login", (req, res) => {
  const { username, password } = req.body || {};
  
  if (!DEBUG_USERNAME || !DEBUG_PASSWORD) {
    return res.status(403).json({ ok: false, error: "Servicio no configurado para autenticación." });
  }

  if (safeCompare(username, DEBUG_USERNAME) && safeCompare(password, DEBUG_PASSWORD)) {
    const expectedToken = crypto.createHmac('sha256', sessionSecret)
      .update(`${DEBUG_USERNAME}:${DEBUG_PASSWORD}`)
      .digest('hex');
    
    const isProd = NODE_ENV === "production";
    res.setHeader("Set-Cookie", `debug_token=${expectedToken}; Path=/; HttpOnly; ${isProd ? "Secure;" : ""} SameSite=Lax; Max-Age=86400`);
    
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
        eyeIcon.innerHTML = \`
          <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"></path>
          <line x1="1" y1="1" x2="23" y2="23"></line>
        \`;
      } else {
        eyeIcon.innerHTML = \`
          <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path>
          <circle cx="12" cy="12" r="3"></circle>
        \`;
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
app.get("/debug/events", requireDebugAuth, (req, res) => {
  res.json({
    events: recentRequests,
    count: recentRequests.length
  });
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
      <div class="stat-value" style="color: var(--primary);">2.4.8</div>
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
      <button class="btn" id="filter-started" onclick="setFilter('started')">Procesando</button>
      <button class="btn" id="filter-handoff" onclick="setFilter('handoff')">Derivados</button>
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

  <div class="requests-list" id="requests-container">
    <div class="empty-state">Cargando eventos...</div>
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

    const btnAuto = document.getElementById('btn-auto');
    const btnManual = document.getElementById('btn-manual');
    const container = document.getElementById('requests-container');
    const sessionCountEl = document.getElementById('session-count');
    const lastEventTimeEl = document.getElementById('last-event-time');
    const searchBox = document.getElementById('search-box');

    const urlParams = new URLSearchParams(window.location.search);
    const token = urlParams.get('token') || '';

    function logout() {
      document.cookie = "debug_token=; Path=/; Expires=Thu, 01 Jan 1970 00:00:01 GMT;";
      fetch('/logout').then(() => {
        window.location.href = "/";
      });
    }

    async function loadData() {
      try {
        const queryParam = token ? '?token=' + encodeURIComponent(token) : '';
        
        const healthRes = await fetch('/health' + queryParam);
        if (healthRes.ok) {
          const healthData = await healthRes.json();
          sessionCountEl.textContent = healthData.session_count || 0;
        }

        const res = await fetch('/debug/events' + queryParam, { credentials: 'include' });
        if (res.status === 401 || res.status === 403 || res.status === 500) {
          container.innerHTML = '<div class="empty-state" style="color: var(--danger); border-color: rgba(239, 68, 68, 0.2); background: rgba(239, 68, 68, 0.05);">' +
            'Error cargando eventos: HTTP ' + res.status +
            '</div>';
          return;
        }

        if (!res.ok) {
          throw new Error('HTTP ' + res.status);
        }

        const contentType = res.headers.get("content-type") || "";
        if (!contentType.includes("application/json")) {
          throw new Error('La respuesta no es JSON válido');
        }

        const data = await res.json();
        
        if (Array.isArray(data)) {
          rawEventsList = data;
        } else if (data && Array.isArray(data.events)) {
          rawEventsList = data.events;
        } else {
          rawEventsList = [];
        }

        applyFiltersAndSearch();
      } catch (err) {
        console.error(err);
        container.innerHTML = '<div class="empty-state" style="color: var(--danger); border-color: rgba(239, 68, 68, 0.2); background: rgba(239, 68, 68, 0.05);">' +
          'Error cargando eventos: ' + err.message +
          '</div>';
      }
    }

    function setFilter(filterType) {
      currentFilter = filterType;
      
      const buttons = ['all', 'ok', 'started', 'handoff', 'error'];
      buttons.forEach(b => {
        const btn = document.getElementById('filter-' + b);
        if (b === filterType) {
          btn.classList.add('active');
        } else {
          btn.classList.remove('active');
        }
      });

      applyFiltersAndSearch();
    }

    function applyFiltersAndSearch() {
      const searchTerm = searchBox.value.trim().toLowerCase();
      
      let filtered = rawEventsList;

      // Aplicar filtro de estado
      if (currentFilter !== 'all') {
        filtered = filtered.filter(ev => ev.status === currentFilter);
      }

      // Aplicar búsqueda
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
        container.innerHTML = '<div class="empty-state">No se encontraron eventos con los filtros seleccionados.</div>';
        return;
      }

      const date = new Date(rawEventsList[0].timestamp);
      lastEventTimeEl.textContent = date.toLocaleTimeString();

      container.innerHTML = events.map(ev => {
        const statusClass = 'status-' + ev.status;
        const badgeClass = 'badge-' + ev.status;
        const formattedDate = new Date(ev.timestamp).toLocaleString();
        const durationText = ev.duration_ms !== null && ev.duration_ms !== undefined ? ev.duration_ms + 'ms' : 'N/A';
        const traceShort = ev.trace_id ? ev.trace_id.slice(0, 8) + '...' : 'N/A';
        
        const usage = ev.token_usage || {};
        const tokenText = (usage.input_tokens !== null ? usage.input_tokens.toLocaleString() : 'N/A') + ' / ' +
                          (usage.output_tokens !== null ? usage.output_tokens.toLocaleString() : 'N/A') + ' / ' +
                          (usage.total_tokens !== null ? usage.total_tokens.toLocaleString() : 'N/A');

        return '<div class="request-card ' + statusClass + '" onclick="openEventDetail(\'' + ev.id + '\')">' +
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
            '<div class="info-line">Conv: <code>' + (ev.conversation_id || 'N/A') + '</code></div>' +
            '<div class="info-line">Contact: <code>' + (ev.contact_id || 'N/A') + '</code></div>' +
            '<div class="info-line">Tel: <code>' + (ev.phone_masked || 'N/A') + '</code></div>' +
            '<div class="info-line">Sesión: <code>' + (ev.hermes_session_id ? ev.hermes_session_id.slice(0, 12) + '...' : 'N/A') + '</code></div>' +
            '<div class="info-line">Stream: <code>' + (ev.hermes_stream_id ? ev.hermes_stream_id.slice(0, 12) + '...' : 'N/A') + '</code></div>' +
          '</div>' +
          '<div class="card-message-previews">' +
            '<div class="preview-box"><strong>Entrada:</strong>' + escapeHtml(ev.input_preview || '(Vacío)') + '</div>' +
            '<div class="preview-box"><strong style="color: #a5b4fc;">Salida:</strong>' + escapeHtml(ev.final_reply_preview || '(Vacío)') + '</div>' +
          '</div>' +
          (ev.error ? '<div class="error-msg" style="margin-top: 0.5rem; padding: 0.5rem;"><strong>Error:</strong> ' + escapeHtml(ev.error) + '</div>' : '') +
        '</div>';
      }).join('');
    }

    function openEventDetail(eventId) {
      const ev = rawEventsList.find(e => e.id === eventId);
      if (!ev) return;

      const overlay = document.getElementById('drawer-overlay');
      const drawer = document.getElementById('drawer');
      const titleArea = document.getElementById('drawer-title-area');
      const bodyArea = document.getElementById('drawer-body-area');

      const badgeClass = 'badge-' + ev.status;
      titleArea.innerHTML = '<span class="badge ' + badgeClass + '">' + ev.status + '</span> <span>Detalle de Traza</span>';

      let bodyHtml = '';

      // A. Resumen Grid
      bodyHtml += '<div class="detail-section">' +
        '<div class="detail-section-title">A. Resumen de la Traza</div>' +
        '<div class="grid-2col">' +
          '<div class="grid-item"><span>Timestamp</span><div>' + new Date(ev.timestamp).toLocaleString() + '</div></div>' +
          '<div class="grid-item"><span>Trace ID Completo</span><div>' + (ev.trace_id || 'N/A') + '</div></div>' +
          '<div class="grid-item"><span>Tenant ID</span><div>' + (ev.tenant_id || 'N/A') + '</div></div>' +
          '<div class="grid-item"><span>Clinic ID</span><div>' + (ev.clinic_id || 'N/A') + '</div></div>' +
          '<div class="grid-item"><span>Conv ID</span><div>' + (ev.conversation_id || 'N/A') + '</div></div>' +
          '<div class="grid-item"><span>Contact ID</span><div>' + (ev.contact_id || 'N/A') + '</div></div>' +
          '<div class="grid-item"><span>Teléfono</span><div>' + (ev.phone_masked || 'N/A') + '</div></div>' +
          '<div class="grid-item"><span>Duración</span><div>' + (ev.duration_ms !== null ? ev.duration_ms + ' ms' : 'N/A') + '</div></div>' +
          '<div class="grid-item"><span>Ruta</span><div>' + (ev.route || 'N/A') + '</div></div>' +
          '<div class="grid-item"><span>Intent</span><div>' + (ev.intent || 'N/A') + '</div></div>' +
          '<div class="grid-item"><span>Requiere Derivación</span><div>' + (ev.requires_handoff ? 'SÍ' : 'NO') + '</div></div>' +
          '<div class="grid-item"><span>Razonamiento Detectado</span><div>' + (ev.internal_reasoning_detected ? 'SÍ' : 'NO') + '</div></div>' +
          '<div class="grid-item"><span>Respuesta Extraída</span><div>' + (ev.patient_reply_extracted ? 'SÍ' : 'NO') + '</div></div>' +
          '<div class="grid-item"><span>Razonamiento Bloqueado</span><div>' + (ev.blocked_internal_reasoning ? 'SÍ' : 'NO') + '</div></div>' +
          '<div class="grid-item"><span>Estrategia Extracción</span><div>' + (ev.extraction_strategy || 'N/A') + '</div></div>' +
          '<div class="grid-item"><span>Sesión Hermes</span><div>' + (ev.hermes_session_id || 'N/A') + '</div></div>' +
          '<div class="grid-item"><span>Stream Hermes</span><div>' + (ev.hermes_stream_id || 'N/A') + '</div></div>' +
        '</div>' +
      '</div>';

      // H. Uso de tokens
      const usage = ev.token_usage || {};
      bodyHtml += '<div class="detail-section" style="border-color: rgba(99, 102, 241, 0.2);">' +
        '<div class="detail-section-title" style="color: #818cf8;">H. Uso de Tokens</div>' +
        '<div class="grid-2col">' +
          '<div class="grid-item"><span>Modelo</span><div>' + (usage.model || 'N/A') + '</div></div>' +
          '<div class="grid-item"><span>Model Provider</span><div>' + (usage.model_provider || 'N/A') + '</div></div>' +
          '<div class="grid-item"><span>Input Tokens</span><div>' + (usage.input_tokens !== null ? usage.input_tokens.toLocaleString() : 'N/A') + '</div></div>' +
          '<div class="grid-item"><span>Output Tokens</span><div>' + (usage.output_tokens !== null ? usage.output_tokens.toLocaleString() : 'N/A') + '</div></div>' +
          '<div class="grid-item"><span>Total Tokens</span><div>' + (usage.total_tokens !== null ? usage.total_tokens.toLocaleString() : 'N/A') + '</div></div>' +
          '<div class="grid-item"><span>Cache Read Tokens</span><div>' + (usage.cache_read_tokens !== null ? usage.cache_read_tokens.toLocaleString() : 'N/A') + '</div></div>' +
          '<div class="grid-item"><span>Cache Write Tokens</span><div>' + (usage.cache_write_tokens !== null ? usage.cache_write_tokens.toLocaleString() : 'N/A') + '</div></div>' +
          '<div class="grid-item"><span>Costo Estimado</span><div>' + (usage.estimated_cost !== null ? '$' + usage.estimated_cost.toFixed(6) : 'N/A') + '</div></div>' +
          '<div class="grid-item"><span>Fuente Medición Tokens</span><div>' + (usage.token_source || 'not_available_from_hermes') + '</div></div>' +
          '<div class="grid-item"><span>Fuente Medición Costos</span><div>' + (usage.cost_source || 'not_available_from_hermes') + '</div></div>' +
        '</div>' +
      '</div>';

      // B. Entrada Gateway
      bodyHtml += '<div class="detail-section">' +
        '<div class="detail-section-title">' +
          '<span>B. Entrada Gateway → Adapter</span>' +
          '<button class="btn-copy" onclick="copyContent(\'payload-gate\')">Copiar</button>' +
        '</div>' +
        '<pre class="detail-pre" id="payload-gate">' + escapeHtml(ev.input_detail || 'N/A') + '</pre>' +
      '</div>';

      // C. Adapter a Hermes
      bodyHtml += '<div class="detail-section">' +
        '<div class="detail-section-title">' +
          '<span>C. Adapter → Hermes</span>' +
          '<button class="btn-copy" onclick="copyContent(\'payload-herm-req\')">Copiar</button>' +
        '</div>' +
        '<pre class="detail-pre" id="payload-herm-req">' + escapeHtml(ev.hermes_request_detail || 'N/A') + '</pre>' +
      '</div>';

      // D. Respuesta Cruda Hermes
      bodyHtml += '<div class="detail-section">' +
        '<div class="detail-section-title">' +
          '<span>D. Hermes → Adapter / Crudo</span>' +
          '<button class="btn-copy" onclick="copyContent(\'payload-herm-raw\')">Copiar</button>' +
        '</div>' +
        '<pre class="detail-pre" id="payload-herm-raw">' + escapeHtml(ev.raw_hermes_detail || 'N/A') + '</pre>' +
      '</div>';

      // E. Respuesta Sanitizada
      bodyHtml += '<div class="detail-section">' +
        '<div class="detail-section-title">' +
          '<span>E. Respuesta Sanitizada</span>' +
          '<button class="btn-copy" onclick="copyContent(\'payload-sanit\')">Copiar</button>' +
        '</div>' +
        '<pre class="detail-pre" id="payload-sanit" style="color: #a5b4fc; font-weight: 500;">' + escapeHtml(ev.sanitized_reply || 'N/A') + '</pre>' +
      '</div>';

      // F. Respuesta enviada al Gateway
      bodyHtml += '<div class="detail-section">' +
        '<div class="detail-section-title">' +
          '<span>F. Adapter → Gateway</span>' +
          '<button class="btn-copy" onclick="copyContent(\'payload-out-gate\')">Copiar</button>' +
        '</div>' +
        '<pre class="detail-pre" id="payload-out-gate">' + escapeHtml(ev.adapter_response_detail || 'N/A') + '</pre>' +
      '</div>';

      // G. Errores (si existe)
      if (ev.status === 'error' || ev.error) {
        bodyHtml += '<div class="detail-section" style="background: rgba(239, 68, 68, 0.05); border-color: rgba(239, 68, 68, 0.2);">' +
          '<div class="detail-section-title" style="color: var(--danger);">G. Errores</div>' +
          '<div class="grid-2col">' +
            '<div class="grid-item"><span>Mensaje Error</span><div style="color: var(--danger);">' + escapeHtml(ev.error || 'N/A') + '</div></div>' +
            '<div class="grid-item"><span>Error Type</span><div>' + escapeHtml(ev.error_type || 'N/A') + '</div></div>' +
            '<div class="grid-item"><span>Timeout Configurado</span><div>' + (ev.timeout_ms ? ev.timeout_ms + ' ms' : 'N/A') + '</div></div>' +
          '</div>' +
        '</div>';
      }

      bodyArea.innerHTML = bodyHtml;

      overlay.classList.add('open');
      drawer.classList.add('open');
    }

    function closeDrawer() {
      document.getElementById('drawer-overlay').classList.remove('open');
      document.getElementById('drawer').classList.remove('open');
    }

    function copyContent(elementId) {
      const text = document.getElementById(elementId).textContent;
      navigator.clipboard.writeText(text).then(() => {
        const btn = document.querySelector('[onclick="copyContent(\'' + elementId + '\')"]');
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
      if (autoRefresh) {
        btnAuto.classList.add('active');
        btnAuto.textContent = 'Auto-refrescar (5s)';
        startInterval();
      } else {
        btnAuto.classList.remove('active');
        btnAuto.textContent = 'Auto-refrescar (Apagado)';
        stopInterval();
      }
    });

    btnManual.addEventListener('click', () => {
      loadData();
    });

    // Iniciar
    loadData();
    startInterval();
  </script>
</body>
</html>`);
}

// Rutas protegidas para servir el Dashboard y los Eventos
app.get("/", requireDebugAuth, serveDashboard);

app.post("/helios/message", async (req, res) => {
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
      model: null,
      model_provider: null,
      input_tokens: null,
      output_tokens: null,
      total_tokens: null,
      cache_read_tokens: null,
      cache_write_tokens: null,
      estimated_cost: null,
      token_source: "not_available_from_hermes",
      cost_source: "not_available_from_hermes"
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

  addRecentRequest(debugEvent);

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
      
      const configErrorResponse = { ok: false, error: errText };
      debugEvent.adapter_response_preview = JSON.stringify(configErrorResponse).slice(0, 1000);
      debugEvent.adapter_response_detail = JSON.stringify(configErrorResponse, null, 2);

      // Calcular tokens localmente si aplica
      debugEvent.token_usage = estimateTokensLocally(normalized.message_text, "");

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

      const authErrorResponse = { ok: false, error: "Unauthorized" };
      debugEvent.adapter_response_preview = JSON.stringify(authErrorResponse).slice(0, 1000);
      debugEvent.adapter_response_detail = JSON.stringify(authErrorResponse, null, 2);

      // Calcular tokens localmente si aplica
      debugEvent.token_usage = estimateTokensLocally(normalized.message_text, "");

      return res.status(401).json(authErrorResponse);
    }

    const result = await sendMessageToHermes(payload);
    sessionId = result.sessionId || "";
    streamId = result.streamId || "";
    rawResponseText = result.answer || "";

    debugEvent.hermes_session_id = sessionId;
    debugEvent.hermes_stream_id = streamId;

    if (result.conflict) {
      finalStatus = "handoff";
      finalRoute = "handoff";
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
        intent: finalIntent,
        requires_handoff: true,
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

      // Consultar tokens finales de Hermes o estimar localmente
      let tokenUsageData = null;
      if (sessionId) {
        try {
          const sessionData = await fetchHermesSessionData(sessionId);
          tokenUsageData = extractTokenUsage(sessionData);
        } catch (_) {}
      }
      if (!tokenUsageData) {
        tokenUsageData = estimateTokensLocally(normalized.message_text, debugEvent.final_reply_preview);
      }
      debugEvent.token_usage = tokenUsageData;

      return res.json(conflictResponse);
    }

    const normalizedResponse = normalizeAdapterResponse(result);
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

    // Consultar tokens finales de Hermes o estimar localmente
    let tokenUsageData = null;
    if (sessionId) {
      try {
        const sessionData = await fetchHermesSessionData(sessionId);
        tokenUsageData = extractTokenUsage(sessionData);
      } catch (_) {}
    }
    if (!tokenUsageData) {
      tokenUsageData = estimateTokensLocally(normalized.message_text, finalReply);
    }
    debugEvent.token_usage = tokenUsageData;

    return res.json(normalizedResponse);

  } catch (error) {
    console.error("Adapter error:", error);
    finalStatus = "error";
    finalRoute = "handoff";
    finalIntent = "error_tecnico";
    errorMsg = error.message;

    const isAbortError = error.name === "AbortError" || error.message.includes("aborted") || error.message.includes("AbortError");

    debugEvent.status = finalStatus;
    debugEvent.route = finalRoute;
    debugEvent.intent = finalIntent;
    debugEvent.requires_handoff = true;
    debugEvent.duration_ms = Date.now() - startTime;
    debugEvent.error = errorMsg.slice(0, 500);
    debugEvent.error_type = isAbortError ? "timeout_or_stream_abort" : "exception";
    debugEvent.timeout_ms = isAbortError ? HERMES_TIMEOUT_MS : null;
    debugEvent.raw_hermes_preview = rawResponseText.slice(0, 1000);
    debugEvent.raw_hermes_detail = rawResponseText;
    debugEvent.final_reply_preview = "Ahora mismo tuve un problema técnico para procesar tu mensaje. Te voy a derivar con el equipo para ayudarte mejor.";
    debugEvent.sanitized_reply_preview = debugEvent.final_reply_preview;
    debugEvent.sanitized_reply = debugEvent.final_reply_preview;

    const errorResponse = {
      ok: false,
      reply: debugEvent.final_reply_preview,
      route: finalRoute,
      intent: finalIntent,
      requires_handoff: true,
      tool_calls: [],
      case_tracking: {
        requires_case_tracking: true,
        reason: "adapter_error"
      },
      metadata: {
        profile: HERMES_PROFILE,
        error: error.message,
        ...(isAbortError ? {
          error_type: "timeout_or_stream_abort",
          timeout_ms: HERMES_TIMEOUT_MS,
          reason: "Hermes stream or request aborted"
        } : {})
      }
    };

    const hasReasoningErr = containsInternalReasoning(rawResponseText);
    const wasBlockedErr = hasReasoningErr && (!finalReply || containsInternalReasoning(finalReply) || finalIntent === "internal_reasoning_blocked");
    const wasExtractedErr = hasReasoningErr && !wasBlockedErr && finalReply.length > 0;

    debugEvent.internal_reasoning_detected = hasReasoningErr;
    debugEvent.patient_reply_extracted = wasExtractedErr;
    debugEvent.blocked_internal_reasoning = wasBlockedErr;
    debugEvent.extraction_strategy = "last_patient_facing_start";

    debugEvent.adapter_response_preview = JSON.stringify(errorResponse).slice(0, 1000);
    debugEvent.adapter_response_detail = JSON.stringify(errorResponse, null, 2);

    // Consultar tokens finales de Hermes o estimar localmente
    let tokenUsageData = null;
    if (sessionId) {
      try {
        const sessionData = await fetchHermesSessionData(sessionId);
        tokenUsageData = extractTokenUsage(sessionData);
      } catch (_) {}
    }
    if (!tokenUsageData) {
      tokenUsageData = estimateTokensLocally(normalized.message_text, debugEvent.final_reply_preview);
    }
    debugEvent.token_usage = tokenUsageData;

    return res.status(502).json(errorResponse);
  }
});

app.listen(PORT, () => {
  console.log(`helios-hermes-adapter v2.4.8 listening on port ${PORT}`);
});
