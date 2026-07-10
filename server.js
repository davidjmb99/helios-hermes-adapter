const express = require("express");
const fs = require("fs");
const crypto = require("crypto");

const app = express();
app.use(express.json({ limit: "2mb" }));

const PORT = process.env.PORT || 3000;

const ADAPTER_API_KEY = process.env.HERMES_API_KEY || "";

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

// Opcionales. Si no existen, Hermes usa el modelo por defecto del perfil helios.
const HERMES_MODEL = process.env.HERMES_MODEL || "";
const HERMES_MODEL_PROVIDER = process.env.HERMES_MODEL_PROVIDER || "";

let hermesCookie = "";
let sessionMap = {};

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

function hashShort(value) {
  return crypto
    .createHash("sha256")
    .update(String(value || ""))
    .digest("hex")
    .slice(0, 12);
}

function conversationKey(normalized) {
  const tenant = normalized.tenant_id || "default";
  const clinic = normalized.clinic_id || "default";

  const conversation =
    normalized.conversation_id ||
    normalized.contact_id ||
    normalized.phone ||
    normalized.trace_id;

  if (!conversation) {
    throw new Error(
      "No se pudo construir session key: faltan conversation_id, contact_id, phone y trace_id"
    );
  }

  return `${tenant}:${clinic}:${conversation}`;
}

function buildHermesMessage(normalized) {
  const eventPayload = {
    source: "helios_gateway",
    event: normalized.event,
    trace_id: normalized.trace_id,
    tenant_id: normalized.tenant_id,
    clinic_id: normalized.clinic_id,
    channel: normalized.channel,

    conversation: {
      conversation_id: normalized.conversation_id,
      contact_id: normalized.contact_id,
      inbox_id: normalized.inbox_id,
      phone: normalized.phone
    },

    patient: normalized.patient,
    state: normalized.state,

    message: {
      text: normalized.message_text,
      message_count: normalized.message_count,
      messages: normalized.message_items
    },

    clinic_context: normalized.clinic_context,
    signals: normalized.signals,
    metadata: normalized.metadata
  };

  // IMPORTANTE:
  // El adapter NO agrega instrucciones clínicas.
  // Hermes perfil helios es el cerebro. Aquí solo pasamos el evento estructurado.
  return JSON.stringify(eventPayload, null, 2);
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
    throw new Error(`Hermes ${path} HTTP ${response.status}: ${text.slice(0, 500)}`);
  }

  return data;
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

function isProviderErrorText(text) {
  const value = String(text || "").toLowerCase();

  return (
    value.startsWith("api call failed") ||
    value.includes("api call failed after") ||
    value.includes("http 429") ||
    value.includes("the usage limit has been reached")
  );
}

async function sendMessageToHermes(payload) {
  const normalized = normalizeGatewayPayload(payload);
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
      session_key_hash: hashShort(conversationKey(normalized)),
      hermes_session_id: sessionId,
      using_model_override: Boolean(HERMES_MODEL || HERMES_MODEL_PROVIDER)
    })
  );

  const body = withOptionalModel({
    session_id: sessionId,
    workspace: HERMES_CWD,
    profile: HERMES_PROFILE,
    message: buildHermesMessage(normalized)
  });

  let data = await hermesRequest("/api/chat", body);

  if (data?.error && String(data.error).toLowerCase().includes("session")) {
    sessionId = await createHermesSession(normalized);

    data = await hermesRequest("/api/chat", {
      ...body,
      session_id: sessionId
    });
  }

  const key = conversationKey(normalized);

  if (sessionMap[key]) {
    sessionMap[key].updated_at = new Date().toISOString();
    saveSessionMap();
  }

  return {
    sessionId,
    answer: data.answer || data?.result?.final_response || "",
    raw: data
  };
}

function normalizeAdapterResponse(result) {
  const reply = String(result.answer || "").trim();

  if (isProviderErrorText(reply)) {
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

  return {
    ok: true,
    reply:
      reply || "Hola, encantado de ayudarte. ¿En qué puedo ayudarte hoy?",
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

app.get("/", (req, res) => {
  res.json({
    ok: true,
    service: "helios-hermes-adapter",
    routes: ["/health", "POST /helios/message"]
  });
});

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    service: "helios-hermes-adapter",
    version: "2.1.0",
    profile: HERMES_PROFILE,
    mode: "HERMES_WEBUI_API",
    hermes_webui_base_url_configured: Boolean(HERMES_WEBUI_BASE_URL),
    hermes_webui_password_configured: Boolean(HERMES_WEBUI_PASSWORD),
    using_model_override: Boolean(HERMES_MODEL || HERMES_MODEL_PROVIDER),
    session_count: Object.keys(sessionMap).length
  });
});

app.post("/helios/message", async (req, res) => {
  try {
    if (!ADAPTER_API_KEY) {
      return res.status(500).json({
        ok: false,
        error: "HERMES_API_KEY no está configurada en el adapter"
      });
    }

    const receivedToken = getBearerToken(req);

    if (receivedToken !== ADAPTER_API_KEY) {
      return res.status(401).json({
        ok: false,
        error: "Unauthorized"
      });
    }

    const payload = req.body || {};
    const result = await sendMessageToHermes(payload);

    return res.json(normalizeAdapterResponse(result));
  } catch (error) {
    console.error("Adapter error:", error);

    return res.status(502).json({
      ok: false,
      reply:
        "Ahora mismo tuve un problema técnico para procesar tu mensaje. Te voy a derivar con el equipo para ayudarte mejor.",
      route: "handoff",
      intent: "error_tecnico",
      requires_handoff: true,
      tool_calls: [],
      case_tracking: {
        requires_case_tracking: true,
        reason: "adapter_error"
      },
      metadata: {
        profile: HERMES_PROFILE,
        error: error.message
      }
    });
  }
});

app.listen(PORT, () => {
  console.log(`helios-hermes-adapter v2.1 listening on port ${PORT}`);
});
