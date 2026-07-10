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

function hashShort(value) {
  return crypto
    .createHash("sha256")
    .update(String(value || ""))
    .digest("hex")
    .slice(0, 12);
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
  // El adapter no agrega instrucciones clínicas.
  // Hermes perfil helios es el cerebro.
  // Aquí se pasa el payload original del gateway.
  return JSON.stringify(normalized.raw || {}, null, 2);
}

async function fetchWithTimeout(url, options = {}, timeoutMs = HERMES_TIMEOUT_MS) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

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

async function hermesPost(path, body, retryLogin = true) {
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
    return hermesPost(path, body, false);
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
  const data = await hermesPost(
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
    value.includes("the usage limit has been reached") ||
    value.includes("model is not supported") ||
    value.includes("provider") && value.includes("failed")
  );
}

function parseSseBlock(block) {
  const lines = String(block || "").split(/\r?\n/);

  let event = "message";
  const dataLines = [];

  for (const line of lines) {
    if (!line || line.startsWith(":")) continue;

    if (line.startsWith("event:")) {
      event = line.slice("event:".length).trim() || "message";
      continue;
    }

    if (line.startsWith("data:")) {
      dataLines.push(line.slice("data:".length).trimStart());
    }
  }

  const dataRaw = dataLines.join("\n");

  let data = dataRaw;
  try {
    data = JSON.parse(dataRaw);
  } catch (_) {}

  return {
    event,
    dataRaw,
    data
  };
}

function extractTextFromSseEvent(parsed) {
  const data = parsed.data;

  if (typeof data === "string") {
    return data;
  }

  if (data && typeof data === "object") {
    return String(
      data.text ||
        data.content ||
        data.delta ||
        data.message ||
        data.answer ||
        data.final_response ||
        ""
    );
  }

  return "";
}

async function readHermesSseStream(streamId) {
  if (!hermesCookie) {
    await hermesLogin();
  }

  const streamTimeoutMs = Math.max(HERMES_TIMEOUT_MS, 90000);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), streamTimeoutMs);

  let response;

  try {
    response = await fetch(`${HERMES_WEBUI_BASE_URL}/api/chat/stream?stream_id=${encodeURIComponent(streamId)}`, {
      method: "GET",
      headers: {
        cookie: hermesCookie,
        accept: "text/event-stream"
      },
      redirect: "manual",
      signal: controller.signal
    });

    updateCookieFromResponse(response);

    if (!response.ok) {
      const text = await response.text();
      throw createHermesHttpError("/api/chat/stream", response, text);
    }

    if (!response.body) {
      throw new Error("Hermes stream no devolvió body");
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();

    let buffer = "";
    let answer = "";
    let terminalEvent = "";
    let lastError = "";

    while (true) {
      const { value, done } = await reader.read();

      if (done) {
        break;
      }

      buffer += decoder.decode(value, { stream: true });

      const parts = buffer.split(/\r?\n\r?\n/);
      buffer = parts.pop() || "";

      for (const block of parts) {
        const parsed = parseSseBlock(block);

        if (!parsed.event) continue;

        if (parsed.event === "token") {
          answer += extractTextFromSseEvent(parsed);
          continue;
        }

        if (parsed.event === "interim_assistant") {
          const visible = extractTextFromSseEvent(parsed).trim();
          const alreadyStreamed =
            parsed.data &&
            typeof parsed.data === "object" &&
            parsed.data.already_streamed;

          if (visible && !alreadyStreamed) {
            answer += answer ? `\n\n${visible}` : visible;
          }

          continue;
        }

        if (parsed.event === "error") {
          lastError =
            extractTextFromSseEvent(parsed) ||
            parsed.dataRaw ||
            "Hermes stream error";
          terminalEvent = "error";
          break;
        }

        if (
          parsed.event === "done" ||
          parsed.event === "complete" ||
          parsed.event === "completed"
        ) {
          terminalEvent = parsed.event;
          break;
        }
      }

      if (terminalEvent) {
        break;
      }
    }

    if (lastError) {
      const error = new Error(lastError);
      error.provider_error = isProviderErrorText(lastError);
      throw error;
    }

    return {
      answer: answer.trim(),
      terminal_event: terminalEvent || "stream_closed"
    };
  } catch (error) {
    if (error.name === "AbortError") {
      throw new Error(`Hermes stream timeout después de ${streamTimeoutMs}ms`);
    }

    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function startHermesChat(sessionId, normalized) {
  return hermesPost(
    "/api/chat/start",
    withOptionalModel({
      session_id: sessionId,
      workspace: HERMES_CWD,
      profile: HERMES_PROFILE,
      message: buildHermesMessage(normalized)
    })
  );
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

  let startData;

  try {
    startData = await startHermesChat(sessionId, normalized);
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
    startData = await startHermesChat(sessionId, normalized);
  }

  const streamId = startData?.stream_id;

  if (!streamId) {
    throw new Error(
      `Hermes /api/chat/start no devolvió stream_id: ${JSON.stringify(startData).slice(0, 500)}`
    );
  }

  const streamResult = await readHermesSseStream(streamId);

  if (sessionMap[key]) {
    sessionMap[key].updated_at = new Date().toISOString();
    saveSessionMap();
  }

  return {
    sessionId,
    streamId,
    answer: streamResult.answer,
    raw: {
      start: startData,
      stream: streamResult
    }
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
        hermes_stream_id: result.streamId,
        provider_error: true
      }
    };
  }

  if (!reply) {
    return {
      ok: false,
      reply:
        "Ahora mismo no pude generar una respuesta completa. Te voy a derivar con el equipo para ayudarte mejor.",
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
        hermes_session_id: result.sessionId,
        hermes_stream_id: result.streamId,
        empty_response: true
      }
    };
  }

  return {
    ok: true,
    reply,
    route: "hermes",
    intent: "respuesta_hermes",
    requires_handoff: false,
    tool_calls: [],
    case_tracking: {
      requires_case_tracking: false
    },
    metadata: {
      profile: HERMES_PROFILE,
      hermes_session_id: result.sessionId,
      hermes_stream_id: result.streamId
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
    version: "2.3.0",
    profile: HERMES_PROFILE,
    mode: "HERMES_WEBUI_STREAM_API",
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
  console.log(`helios-hermes-adapter v2.3 listening on port ${PORT}`);
});
