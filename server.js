const express = require("express");
const fs = require("fs");
const crypto = require("crypto");
const { validateTenantContext } = require("./tenant-context");
const { createHermesAgentClient } = require("./hermes-agent-client");
const { createStableRequestIdentity } = require("./request-identity");
const { calcularCoste, formatearUsd, formatearUsdFino, modeloConTarifa } = require("./pricing");
const {
  PERIODOS, esPeriodoValido, inicioDelPeriodo, resumirEventos, resumirMedia
} = require("./metricas");
const { calcularDesgloseDeCache, leerAcumuladosDelContrato } = require("./cache-delta.js");
const { esRepeticionDeLaAnterior } = require("./respuesta-repetida.js");

/**
 * Modelo que se usa SOLO para calcular el coste, cuando Hermes no lo reporta.
 *
 * Va aparte de HERMES_AGENT_MODEL a propósito, y la diferencia importa: aquella
 * viaja en el cuerpo de la petición a Hermes y cambiarla puede alterar a qué
 * modelo se llama. Esta no sale de aquí: solo sirve para buscar la tarifa en el
 * catálogo. Si Hermes acaba reportando el modelo real, ese gana y esta se ignora.
 */
const HELIOS_BILLING_MODEL = (process.env.HELIOS_BILLING_MODEL || "").trim() || null;
const { createExecutionStore } = require("./execution-store");
const { assertSupabaseSuccess } = require("./supabase-assert");
const { decidirSesion } = require("./sesiones.js");
const { crearAlmacenDeSesiones, conversacionDeHermes } = require("./almacen-sesiones.js");
const {
  buildProcessingTelemetry,
  classifyPostProcessingError,
  derivePersistedResultMetadata
} = require("./processing-diagnostics");
const { version: PACKAGE_VERSION } = require("./package.json");
const {
  findBalancedJsonObjects,
  buildHermesContractInput,
  isValidHermesContract,
  extractLastValidHermesContract,
  normalizeAdapterResponse
} = require("./contract-parser");

const TELEMETRY_TIMEOUT = Symbol("telemetry_timeout");

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
app.use((req, res, next) => {
  if (req.path === "/" || req.path.startsWith("/debug")) {
    res.setHeader("Cache-Control", "no-store, private, max-age=0");
    res.setHeader("Pragma", "no-cache");
    res.setHeader("X-Robots-Tag", "noindex, nofollow, noarchive");
  }
  next();
});

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
const HELIOS_ADMIN_SHOW_PII = process.env.HELIOS_ADMIN_SHOW_PII === "true";
const ADAPTER_EXECUTION_LEASE_MS_CONFIGURED = Number(process.env.ADAPTER_EXECUTION_LEASE_MS || 180000);
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
/**
 * Transportes que este Adapter sabe hablar. `webui` es el viejo, que se conserva
 * solo para poder volver atras; produccion usa `agent_api`.
 */
const TRANSPORTES_VALIDOS = ["agent_api", "webui"];

/**
 * EL TRANSPORTE SE EXIGE EXPLICITO. NO HAY VALOR POR DEFECTO.
 *
 * Antes esto era `process.env.HERMES_TRANSPORT || "webui"`, y esa linea tenia dos
 * formas de arruinar un despliegue sin que nadie se enterase:
 *
 *   - Si la variable FALTABA, el Adapter arrancaba tan feliz hablando por el
 *     transporte VIEJO. El servicio se veia sano, el health decia OK, y los
 *     mensajes iban por un camino que ya no es el de produccion.
 *   - Si la variable tenia un typo -«agent-api» con guion, por ejemplo-, el error
 *     no salia al arrancar sino en CADA peticion, una por una. El contenedor
 *     pasaba el healthcheck y fallaba con todos los pacientes.
 *
 * Las dos cosas son fallos silenciosos, que es justo el patron que este sistema
 * lleva una semana pagando. Ahora el proceso se niega a arrancar y lo dice.
 *
 * Un arranque que falla se ve en el log del despliegue en diez segundos. Un
 * transporte equivocado se descubre cuando un paciente no recibe respuesta.
 */
const HERMES_TRANSPORT = String(process.env.HERMES_TRANSPORT || "").trim().toLowerCase();
if (!TRANSPORTES_VALIDOS.includes(HERMES_TRANSPORT)) {
  const comoLlego = process.env.HERMES_TRANSPORT === undefined
    ? "no esta definida"
    : `vale "${process.env.HERMES_TRANSPORT}"`;
  console.error(JSON.stringify({
    event: "arranque_abortado",
    motivo: "HERMES_TRANSPORT_INVALIDO",
    variable: "HERMES_TRANSPORT",
    estado: comoLlego,
    valores_admitidos: TRANSPORTES_VALIDOS,
    que_hacer: "Definir HERMES_TRANSPORT=agent_api en las variables del servicio. "
      + "Sin esto el Adapter hablaria por el transporte viejo sin avisar."
  }));
  process.exit(1);
}
const HERMES_CWD =
  process.env.HERMES_CWD ||
  "/home/hermeswebui/.hermes/profiles/helios/workspace/helios";

const HERMES_WEBUI_BASE_URL = (
  process.env.HERMES_WEBUI_BASE_URL || "https://hermes.servicios.escala365.com"
).replace(/\/+$/, "");

const HERMES_WEBUI_PASSWORD = process.env.HERMES_WEBUI_PASSWORD || "";
const HERMES_AGENT_API_BASE_URL = (
  process.env.HERMES_AGENT_API_BASE_URL || ""
).replace(/\/+$/, "");
const HERMES_AGENT_API_KEY = process.env.HERMES_AGENT_API_KEY || "";
// OJO: esto NO es el nombre del modelo de IA, es lo que se manda como campo
// `model` en la petición a Hermes, que usa el perfil cuando no hay otra cosa. El
// modelo REAL lo devuelve Hermes en la telemetría y se guarda aparte: mezclarlos
// hacía que el panel mostrara «Modelo: helios», que es un perfil, no un modelo.
const HERMES_AGENT_MODEL = process.env.HERMES_AGENT_MODEL || HERMES_PROFILE;
const HERMES_TIMEOUT_MS = Number(process.env.HERMES_TIMEOUT_MS || 30000);
const ADAPTER_EXECUTION_LEASE_MS = Math.max(
  ADAPTER_EXECUTION_LEASE_MS_CONFIGURED,
  HERMES_TIMEOUT_MS + 60000
);

const SESSION_STORE_PATH =
  process.env.HERMES_SESSION_STORE_PATH || "/tmp/helios-hermes-sessions.json";

// Opcional. Si no existen, Hermes usará el modelo principal del perfil helios.
const HERMES_MODEL = process.env.HERMES_MODEL || "";
const HERMES_MODEL_PROVIDER = process.env.HERMES_MODEL_PROVIDER || "";

let hermesCookie = "";

/**
 * Las sesiones, en Supabase.
 *
 * Sustituye al mapa en /tmp, que se borraba en cada redeploy, no se podia consultar
 * desde ningun sitio y —lo que mas costo— vivia en memoria del proceso, asi que
 * editar el archivo no hacia absolutamente nada.
 */
const almacenDeSesiones = crearAlmacenDeSesiones({
  supabase,
  log: (linea) => console.warn(JSON.stringify(linea))
});

let sessionMap = {};
const hermesAgentClient = createHermesAgentClient({
  baseUrl: HERMES_AGENT_API_BASE_URL,
  apiKey: HERMES_AGENT_API_KEY,
  model: HERMES_AGENT_MODEL,
  timeoutMs: HERMES_TIMEOUT_MS
});
const executionStore = createExecutionStore({
  supabase,
  leaseMs: ADAPTER_EXECUTION_LEASE_MS
});
let lastHermesResponseCompletedAt = null;

// Ultimo titulo aplicado a cada sesion en esta vida del proceso, para no repetir
// el PATCH en cada turno pero si permitir el retitulado cuando llega la identidad.
const hermesSessionTitles = new Map();

// En el turno en que el paciente facilita sus datos, el payload de la peticion
// todavia llega con first_name y last_name en null: el perfil se persiste despues.
// La identidad buena de ese turno viene en el profile_patch de la respuesta.
function resolveEventIdentity(normalized, normalizedResponse) {
  const requestPatient = normalized?.patient || {};
  const patch = normalizedResponse?.profile_patch || {};
  const merged = {
    ...requestPatient,
    first_name: patch.first_name || requestPatient.first_name || null,
    last_name: patch.last_name || requestPatient.last_name || null
  };
  return {
    first_name: merged.first_name || null,
    last_name: merged.last_name || null,
    display_name: getPatientDisplayName(merged)
  };
}

// Hermes crea las sesiones de Agent API sin titulo, y el WebUI las muestra todas
// como "Api_Server Session", indistinguibles entre si. Les ponemos el numero de
// conversacion de Chatwoot, y el nombre del paciente en cuanto se conoce.
// Nunca lanza ni bloquea: si falla, se registra y el paciente recibe su respuesta.
async function ensureHermesSessionTitle(sessionId, normalized, normalizedResponse) {
  if (HERMES_TRANSPORT !== "agent_api") return;
  const conversationId = normalized?.conversation_id;
  if (!sessionId || !conversationId) return;

  const identity = resolveEventIdentity(normalized, normalizedResponse);
  const fullName = [identity.first_name, identity.last_name]
    .filter(Boolean)
    .join(" ")
    .trim();
  const title = fullName
    ? `${fullName} · Conversación ${conversationId}`
    : `Helios · Conversación ${conversationId}`;

  if (hermesSessionTitles.get(sessionId) === title) return;
  hermesSessionTitles.set(sessionId, title);

  const outcome = await hermesAgentClient.renameSession({ sessionId, title });

  if (outcome.ok) {
    console.log(JSON.stringify({
      event: "hermes_session_title_updated",
      conversation_id: String(conversationId),
      session_id: sessionId,
      named: Boolean(fullName),
      http_status: outcome.status
    }));
    return;
  }

  // Permitir que el siguiente turno lo reintente.
  hermesSessionTitles.delete(sessionId);
  console.warn(JSON.stringify({
    event: "hermes_session_title_update_failed",
    conversation_id: String(conversationId),
    session_id: sessionId,
    http_status: outcome.status,
    error_code: outcome.errorCode
  }));
}

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
          account_id: payload?.account_id || null,
          clinic_id: payload?.clinic_id || null,
          hermes_profile: payload?.hermes_profile || null,
          conversation_id: identity.conversation_id,
          contact_id: identity.contact_id,
          patient_first_name: payload?.patient?.first_name || null,
          patient_last_name: payload?.patient?.last_name || null,
          patient_display_name: getPatientDisplayName(payload?.patient),
          phone: extractPhone(payload, payload, payload),
          message_content: payload?.message?.text || null,
          status: 'processing',
          processing_stage: 'request_received',
          hermes_transport: HERMES_TRANSPORT,
          started_at: new Date().toISOString()
        })
        .select('id')
        .single();
      assertSupabaseSuccess({ data, error }, "adapter_events.start", {
        tenant_id: identity.tenant_id,
        trace_id: identity.trace_id
      });
      return { eventId: data.id, identity, startedAt: Date.now(), closed: false };
    } else {
       return { eventId: null, identity, startedAt: Date.now(), closed: false };
    }
  } catch (err) {
    console.error(JSON.stringify({
      event: "adapter_telemetry_start_failed",
      error_code: err.code || "SUPABASE_UNKNOWN"
    }));
    return {
      eventId: null,
      identity: normalizeTelemetryIdentity(payload),
      startedAt: Date.now(),
      closed: false,
      startError: err
    };
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
    const update = await supabase.from('helios_adapter_events')
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
    assertSupabaseSuccess(update, "adapter_events.finish_legacy", {
      tenant_id: ctx.identity?.tenant_id,
      trace_id: ctx.identity?.trace_id,
      row_id: ctx.eventId
    });
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
    const update = await supabase.from('helios_adapter_events')
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
    assertSupabaseSuccess(update, "adapter_events.fail_legacy", {
      tenant_id: ctx.identity?.tenant_id,
      trace_id: ctx.identity?.trace_id,
      row_id: ctx.eventId
    });
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

  // B) Verificar token Bearer. Nunca aceptar credenciales por query string.
  if (DEBUG_TOKEN) {
    let token = getBearerToken(req);
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

/**
 * Cada cuanto se registra un acceso al panel, POR RUTA.
 *
 * El panel se auto-refresca cada cinco segundos, asi que /debug/events escribia
 * una linea cada cinco segundos, sin parar, mientras alguien lo tuviera abierto.
 * Con eso los logs quedan inservibles: al diagnosticar el fallo del 18 de agosto,
 * las cien lineas visibles en Coolify eran casi todas admin_dashboard_access y
 * habian empujado fuera las lineas de diagnostico que hacian falta.
 *
 * Un acceso al panel es informacion de auditoria util UNA VEZ, no doce veces por
 * minuto. Se deja una por ruta y minuto: se sigue viendo quien entra y a donde,
 * sin tapar lo que importa.
 */
const ULTIMO_ACCESO_REGISTRADO = new Map();
const CADENCIA_LOG_ACCESO_MS = 60_000;

function registrarAccesoAlPanel(ruta) {
  const ahora = Date.now();
  const anterior = ULTIMO_ACCESO_REGISTRADO.get(ruta) || 0;
  if (ahora - anterior < CADENCIA_LOG_ACCESO_MS) return;
  ULTIMO_ACCESO_REGISTRADO.set(ruta, ahora);
  console.log(JSON.stringify({
    event: "admin_dashboard_access",
    path: ruta,
    nota: "se registra como maximo una vez por minuto y ruta"
  }));
}

function requireDebugAuth(req, res, next) {
  if (isDebugAuthorized(req)) {
    registrarAccesoAlPanel(req.path);
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

    account_id: firstNonEmpty(payload.account_id),
    trace_id: firstNonEmpty(payload.trace_id, payload.metadata?.trace_id),
    tenant_id: firstNonEmpty(payload.tenant_id),
    clinic_id: firstNonEmpty(payload.clinic_id),
    hermes_profile: firstNonEmpty(payload.hermes_profile),
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

function conversationKey(normalized, tenantContext) {
  if (
    !normalized.conversation_id ||
    !normalized.contact_id ||
    !tenantContext?.tenant_id ||
    !tenantContext?.hermes_profile
  ) {
    throw new Error(
      "No se pudo construir session key: faltan tenant_id, hermes_profile, conversation_id o contact_id"
    );
  }
  return [
    `tenant:${tenantContext.tenant_id}`,
    `profile:${tenantContext.hermes_profile}`,
    `conversation:${normalized.conversation_id}`,
    `contact:${normalized.contact_id}`
  ].join(":");
}

function buildHermesMessage(normalized) {
  // IMPORTANTE: El adapter NO agrega instrucciones clínicas.
  return buildHermesContractInput(normalized.raw || {});
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

async function fetchHermesSessionData(sessionId, hermesProfile) {
  if (!sessionId) return { sessionData: null, attempts: [] };

  const pathsToTry = [
    `/api/session?session_id=${encodeURIComponent(sessionId)}&messages=0&resolve_model=1`,
    `/api/session?session_id=${encodeURIComponent(sessionId)}&messages=1&resolve_model=1&msg_limit=5`,
    `/api/sessions/${encodeURIComponent(sessionId)}?profile=${encodeURIComponent(hermesProfile)}`,
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

async function createHermesSession(normalized, tenantContext) {
  const data = await hermesRequest(
    "/api/session/new",
    withOptionalModel({
      workspace: HERMES_CWD,
      profile: tenantContext.hermes_profile
    })
  );

  const sessionId = data?.session?.session_id;

  if (!sessionId) {
    throw new Error("Hermes no devolvió session_id al crear sesión");
  }

  const key = conversationKey(normalized, tenantContext);

  sessionMap[key] = {
    session_id: sessionId,
    profile: tenantContext.hermes_profile,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  };

  saveSessionMap();

  return sessionId;
}

async function getHermesSessionId(normalized, tenantContext) {
  const key = conversationKey(normalized, tenantContext);

  if (sessionMap[key]?.session_id) {
    return sessionMap[key].session_id;
  }

  return createHermesSession(normalized, tenantContext);
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

async function startHermesStream(sessionId, normalized, tenantContext) {
  const body = withOptionalModel({
    session_id: sessionId,
    workspace: HERMES_CWD,
    profile: tenantContext.hermes_profile,
    message: buildHermesMessage(normalized)
  });

  return hermesRequest("/api/chat/start", body);
}

function isAbortError(error) {
  return error?.name === "AbortError" || error?.code === "ABORT_ERR";
}

function createHermesTimeoutError(cause) {
  const error = new Error(`Hermes stream timed out after ${HERMES_TIMEOUT_MS} ms`, {
    cause
  });
  error.code = "HERMES_TIMEOUT";
  return error;
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
    if (isAbortError(error)) {
      throw createHermesTimeoutError(error);
    }
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
  } catch (error) {
    if (isAbortError(error)) {
      throw createHermesTimeoutError(error);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
    try {
      await reader.cancel();
    } catch (error) {
      if (!isAbortError(error)) {
        throw error;
      }
    }
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

async function sendMessageToHermesWebUi(payload) {
  const normalized = normalizeGatewayPayload(payload);
  const tenantContext = validateTenantContext(normalized);
  const key = conversationKey(normalized, tenantContext);

  let sessionId = await getHermesSessionId(normalized, tenantContext);

  console.log(
    JSON.stringify({
      event: "adapter_payload_normalized",
      normalized_account_id: tenantContext.account_id,
      normalized_trace_id: normalized.trace_id || null,
      normalized_tenant_id: normalized.tenant_id || null,
      normalized_clinic_id: normalized.clinic_id || null,
      normalized_hermes_profile: tenantContext.hermes_profile,
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
      startData = await startHermesStream(sid, normalized, tenantContext);
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

    sessionId = await createHermesSession(normalized, tenantContext);
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
    activeStreamId,
    hermesProfile: tenantContext.hermes_profile,
    transport: "webui",
    answerSource: "webui_stream_output",
    durableResultReused: false,
    persistedResultStatus: null,
    persistedErrorCode: null
  };
}

async function sendMessageToHermesAgentApi(payload) {
  const normalized = normalizeGatewayPayload(payload);
  const tenantContext = validateTenantContext(normalized);
  const key = conversationKey(normalized, tenantContext);

  // CUANTO HISTORIAL ARRASTRA ESTA CONVERSACION.
  //
  // En agent_api la conversacion de Hermes es una cadena determinista y Hermes guarda
  // el hilo de su lado con esa clave. Nunca cambiaba, asi que el hilo crecia para
  // siempre: la conversacion 75 iba por 42.000 tokens de entrada, y el modelo se
  // imitaba a si mismo -tuteaba, decia «hueco» y repetia una direccion de Madrid de
  // hacia un mes-. Contra cuarenta mil tokens de ejemplos de lo contrario no gana
  // ninguna regla del prompt.
  //
  // Ahora la cadena lleva una generacion. Subirla es empezar de cero para Hermes sin
  // que haya que borrar nada. Y lo que importa NO se pierde: la identidad del
  // paciente y el estado de la conversacion los manda el Gateway en cada peticion.
  const sesionGuardada = await almacenDeSesiones.leer(key);
  const decision = decidirSesion(sesionGuardada.fila, Date.now());
  let generacion = Number(sesionGuardada.fila?.generacion) || 0;
  if (decision.nueva) {
    generacion = await almacenDeSesiones.abrirNueva(key, decision.motivo, sesionGuardada.fila);
    console.log(JSON.stringify({
      event: "hermes_conversacion_empieza_de_cero",
      session_key_hash: hashShort(key),
      motivo: decision.motivo,
      generacion,
      horas_inactiva: decision.horas_inactiva,
      turnos_de_la_sesion_anterior: sesionGuardada.fila?.turnos ?? null,
      tokens_del_turno_anterior: sesionGuardada.fila?.ultimo_input_tokens ?? null,
      // Si la lectura fue degradada, la decision se tomo con datos de respaldo y
      // conviene saberlo antes de creerse el motivo.
      lectura_degradada: sesionGuardada.degradado
    }));
  }

  const conversation = conversacionDeHermes(hashShort(key), generacion);
  const requestIdentity = createStableRequestIdentity(normalized, tenantContext);
  if (!requestIdentity.key || !requestIdentity.sourceMessageIdsHash) {
    const error = new Error("Stable source message identity is required");
    error.code = "ADAPTER_REQUEST_IDENTITY_MISSING";
    throw error;
  }
  const executionIdentity = {
    request_key: requestIdentity.key,
    tenant_id: tenantContext.tenant_id,
    account_id: tenantContext.account_id,
    clinic_id: tenantContext.clinic_id,
    hermes_profile: tenantContext.hermes_profile,
    conversation_id: normalized.conversation_id,
    contact_id: normalized.contact_id,
    source_message_ids_hash: requestIdentity.sourceMessageIdsHash
  };
  let executionClaim;
  try {
    executionClaim = await executionStore.claim(executionIdentity);
  } catch (error) {
    error.exceptionStage = "durable_lookup";
    error.executionRequestKey = requestIdentity.key;
    throw error;
  }

  if (executionClaim.action === "completed") {
    const persistedMetadata = derivePersistedResultMetadata(executionClaim.execution);
    return {
      sessionId: executionClaim.execution.hermes_response_id || "",
      streamId: "",
      answer: "",
      persistedNormalizedResult: executionClaim.execution.normalized_result,
      conflict: false,
      activeStreamId: "",
      hermesProfile: tenantContext.hermes_profile,
      transport: "agent_api",
      tokenUsage: {
        model: HERMES_AGENT_MODEL,
        input_tokens: executionClaim.execution.input_tokens,
        output_tokens: executionClaim.execution.output_tokens,
        total_tokens: executionClaim.execution.total_tokens,
        tool_calls: executionClaim.execution.tool_calls || []
      },
      toolCalls: executionClaim.execution.tool_calls || [],
      executionRequestKey: requestIdentity.key,
      hermesConversationId: executionClaim.execution.hermes_conversation_id,
      idempotencyStatus: "deduplicated",
      answerSource: "durable_normalized_result",
      durableResultReused: persistedMetadata.durable_result_reused,
      persistedResultStatus: persistedMetadata.persisted_result_status,
      persistedErrorCode: persistedMetadata.persisted_error_code
    };
  }
  if (executionClaim.action === "waiting") {
    const error = new Error("An execution with the same source messages is already active");
    error.code = "ADAPTER_EXECUTION_IN_PROGRESS";
    error.executionRequestKey = requestIdentity.key;
    throw error;
  }
  if (executionClaim.action === "failed_final") {
    const error = new Error("The stable execution is final and cannot be retried");
    error.code = "ADAPTER_EXECUTION_FAILED_FINAL";
    error.executionRequestKey = requestIdentity.key;
    throw error;
  }

  console.log(
    JSON.stringify({
      event: "adapter_payload_normalized",
      transport: "agent_api",
      normalized_account_id: tenantContext.account_id,
      normalized_trace_id: normalized.trace_id || null,
      normalized_tenant_id: normalized.tenant_id || null,
      normalized_clinic_id: normalized.clinic_id || null,
      normalized_hermes_profile: tenantContext.hermes_profile,
      normalized_conversation_id: normalized.conversation_id || null,
      normalized_contact_id: normalized.contact_id || null,
      normalized_phone_exists: Boolean(normalized.phone),
      message_count: normalized.message_count,
      session_key_hash: hashShort(key),
      hermes_conversation: conversation,
      idempotency_strategy: requestIdentity.strategy,
      request_fingerprint_hash: requestIdentity.fingerprintHash,
      source_message_id_count: requestIdentity.sourceMessageIdCount,
      recovery_request: normalized.trace_id.startsWith("recovery-"),
      using_model_override: Boolean(process.env.HERMES_AGENT_MODEL)
    })
  );

  let result;
  try {
    result = await hermesAgentClient.sendMessage({
      input: buildHermesMessage(normalized),
      conversation,
      idempotencyKey: requestIdentity.key,
      traceId: normalized.trace_id
    });
    lastHermesResponseCompletedAt = new Date().toISOString();
  } catch (error) {
    error.executionRequestKey = requestIdentity.key;
    throw error;
  }

  // ESTO ES LO QUE DECIDE LA PROXIMA ROTACION. Si no se anota, la conversacion crece
  // sin techo y volvemos al problema. Va despues del turno porque hasta aqui no hay
  // cifra de entrada. No se hace await a proposito de bloquear la respuesta al
  // paciente por una escritura de contabilidad: si falla, se registra dentro.
  almacenDeSesiones
    .anotarTurno(key, result?.tokenUsage?.input_tokens ?? result?.tokenUsage?.inputTokens ?? null)
    .catch(() => {});

  return {
    sessionId: result.sessionId || null,
    streamId: "",
    answer: result.answer,
    conflict: false,
    activeStreamId: "",
    hermesProfile: tenantContext.hermes_profile,
    transport: "agent_api",
    tokenUsage: result.tokenUsage,
    toolCalls: result.toolCalls,
    executionRequestKey: requestIdentity.key,
    hermesConversationId: conversation,
    hermesResponseId: result.responseId,
    idempotencyStatus: "new",
    answerSource: "agent_api_output_text",
    durableResultReused: false,
    persistedResultStatus: null,
    persistedErrorCode: null
  };
}


/**
 * Que llego de Hermes, cuando el contrato no se pudo leer.
 *
 * SOLO en el fallo: en un turno normal devuelve null y la columna queda vacia.
 *
 * Guarda el texto CRUDO y entero -son un par de miles de caracteres- porque la
 * pregunta que nadie ha podido responder en dos dias es literalmente «que texto
 * llego». Recortarlo a una muestra seria repetir el error de mirar fragmentos.
 *
 * El texto es la respuesta que Hermes redacta para el paciente, no una historia
 * clinica, y esta fila ya guarda el mensaje recibido y la respuesta generada. No
 * se anade ninguna categoria de dato que no estuviera ya.
 */
/**
 * QUIEN FALLO, dicho con nombre y apellido.
 *
 * Peticion de David, y tiene toda la razon: «cuando de un error asi, de una vez sea
 * identificado en el adapter, diga el nombre de lo que esta fallando». Durante una
 * semana el panel decia OUTPUT_CONTRACT_VIOLATION, que es el sintoma y no la causa,
 * y para llegar de ahi al culpable -el plugin helios-output-guard del perfil helios-
 * hicieron falta cinco hipotesis, una columna nueva y varias auditorias.
 *
 * Todos los indicios de aqui son MEDIDOS, no interpretados: cuantos tokens se
 * gastaron, si el texto parsea, si el mensaje viene vacio. Y cuando no se puede
 * afirmar, se dice que no se puede: «desconocido» es una respuesta honesta y
 * «probablemente el guard» no lo es.
 *
 * Los tres casos reales que vivimos, en orden de como se distinguen:
 *
 *  1. CERO TOKENS. El modelo no se ejecuto: el proveedor rechazo la peticion antes
 *     de correr. Es el caso de Ligia del 17-ago -0 tokens en 798 ms-, un HTTP 400
 *     de DeepSeek por un historial mal formado. No es culpa de Hermes ni del
 *     Adapter: la peticion nunca llego al modelo.
 *  2. JSON VALIDO CON EL MENSAJE VACIO. El contrato esta impecable y el mensaje al
 *     paciente esta en blanco. Eso no lo escribe un modelo: lo escribe un validador
 *     que veto la respuesta y la sustituyo. Es el guard.
 *  3. TEXTO QUE NO PARSEA. Ahi si el problema esta en la forma de la respuesta o en
 *     mi extractor, y hay que mirar el texto crudo.
 */
function nombrarAlCulpable(result, normalizedResponse, errorCode, crudo) {
  const tokens = Number(result?.tokenUsage?.total_tokens ?? result?.total_tokens ?? NaN);
  const sinTokens = Number.isFinite(tokens) && tokens === 0;

  let parsea = false;
  let contrato = null;
  try {
    contrato = JSON.parse(String(crudo).trim());
    parsea = contrato !== null && typeof contrato === "object";
  } catch { parsea = false; }

  const mensajeVacio = parsea
    && typeof contrato.message_for_client === "string"
    && contrato.message_for_client.trim() === "";

  if (sinTokens) {
    return {
      culpable: "proveedor_del_modelo",
      nombre: "El proveedor del modelo rechazo la peticion (DeepSeek, HTTP 400)",
      explicacion: "Cero tokens gastados: el modelo no se ejecuto. El cuerpo de la "
        + "peticion se valido y se rechazo antes de generar nada. Causa conocida: un "
        + "mensaje de asistente en el historial con tool_calls vacio.",
      donde_mirar: "Hermes, perfil helios: el hook pre_api_request del plugin "
        + "helios-output-guard es el que limpia ese historial.",
      seguro: true
    };
  }

  if (mensajeVacio) {
    return {
      culpable: "helios_output_guard",
      nombre: "El guard del perfil helios veto la respuesta y la dejo vacia",
      explicacion: "El contrato llego entero y parsea perfectamente, pero "
        + "message_for_client viene en blanco. Un modelo no escribe eso: lo escribe "
        + "un validador que rechazo la respuesta buena y la sustituyo por su "
        + "fallback. Hermes SI genero una respuesta; no es la que llego.",
      donde_mirar: "Hermes, perfil helios, plugins/helios-output-guard. Buscar en "
        + "sus logs el evento helios_output_guard_blocked con la regla que fallo.",
      seguro: true
    };
  }

  if (crudo && !parsea) {
    return {
      culpable: "forma_de_la_respuesta",
      nombre: "Llego texto que no es un contrato JSON valido",
      explicacion: "Hay texto pero no se puede leer como contrato. Puede ser la "
        + "forma de la respuesta de Hermes o mi propio extractor.",
      donde_mirar: "El campo texto_crudo de esta misma fila: son los bytes exactos "
        + "que recibio el Adapter.",
      seguro: false
    };
  }

  if (!crudo) {
    return {
      culpable: "sin_respuesta",
      nombre: "Hermes no devolvio texto",
      explicacion: "La llamada termino sin contenido que analizar.",
      donde_mirar: "forma_respuesta en esta fila, y los logs del gateway-helios.",
      seguro: false
    };
  }

  // Parsea, tiene mensaje, y aun asi fallo. No se puede nombrar a nadie sin
  // inventar, y inventar es lo que costo una semana.
  return {
    culpable: "desconocido",
    nombre: "No se puede identificar al culpable con lo medido",
    explicacion: "El contrato parsea y trae mensaje, asi que no encaja en ninguno "
      + "de los patrones conocidos. Hace falta mirar el texto crudo a mano.",
    donde_mirar: "texto_crudo y error_code de esta fila.",
    seguro: false
  };
}

function construirCajaNegra(result, normalizedResponse, errorCode, respuestaReciclada) {
  // Una respuesta reciclada es un fallo aunque el contrato sea impecable: el
  // paciente recibe algo que ya leyo. Por eso abre caja negra por si sola.
  const fallo = Boolean(errorCode) || normalizedResponse?.safe_to_send !== true
    || respuestaReciclada?.repetida === true;
  if (!fallo) return null;
  try {
    const crudo = typeof result?.answer === "string" ? result.answer : "";
    const diagnostico = nombrarAlCulpable(result, normalizedResponse, errorCode, crudo);
    return {
      guardado_en: new Date().toISOString(),
      error_code: errorCode || null,
      respuesta_reciclada: respuestaReciclada || null,
      // LO PRIMERO QUE SE LEE: quien fallo. Lo demas es la evidencia que lo sostiene.
      diagnostico,
      // Lo que el parser vio
      texto_crudo: crudo.slice(0, 20000),
      texto_largo: crudo.length,
      texto_truncado_aqui: crudo.length > 20000,
      parsea_como_json: (() => {
        try { JSON.parse(crudo.trim()); return true; } catch { return false; }
      })(),
      contiene_message_for_client: crudo.includes("message_for_client"),
      llaves_de_apertura: (crudo.match(/\{/g) || []).length,
      // Lo que dijo el parser
      estrategia: normalizedResponse?.contract_strategy ?? null,
      candidatos: normalizedResponse?.contract_candidate_count ?? null,
      // Y la forma de la respuesta de Hermes, sin contenido
      forma_respuesta: result?.responseShape ?? null,
      idempotencia: result?.idempotencyStatus ?? null,
      origen_respuesta: result?.answerSource ?? null
    };
  } catch (error) {
    // Diagnosticar nunca puede romper el turno.
    return { error_al_construir: String(error && error.message) };
  }
}

/**
 * ¿La respuesta de este turno es una vieja reciclada del historial?
 *
 * Corre ANTES de devolverle nada al Gateway, porque aquí no se registra: se BLOQUEA.
 * David, el 19-ago, sobre los tres pacientes que recibieron el saludo del principio
 * pidiéndoles datos que Helios ya tenía: «está mal, no debe pasar nunca, es algo de
 * mal gusto».
 *
 * QUÉ SE HACE CON ELLA. No se entrega, y se marca como fallo recuperable. Eso lleva
 * al camino que ya existe: se reintenta, y si tampoco sale, se deriva a una persona
 * y al paciente se le dice que sigue alguien del equipo. El paciente nunca se queda
 * sin respuesta, y la que recibe nunca es una que ya leyó.
 *
 * Se marca recoverable a propósito: la causa es que ESE turno no generó mensaje
 * propio, y un reintento tiene posibilidades reales de producir uno.
 */
async function comprobarRespuestaReciclada(normalized, normalizedResponse) {
  const texto = normalizedResponse?.message_for_client || normalizedResponse?.reply || null;
  if (!texto || !normalized?.conversation_id) return { repetida: false, motivo: null };
  try {
    const anterior = await supabase
      .from("helios_adapter_events")
      .select("response_content")
      .eq("tenant_id", normalized.tenant_id)
      .eq("conversation_id", normalized.conversation_id)
      .not("response_content", "is", null)
      .neq("response_content", "[RESPONSE_GENERATED_NOT_SENT]")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    return esRepeticionDeLaAnterior(texto, anterior?.data?.response_content);
  } catch (error) {
    // Comprobar no puede tumbar un turno. Sin poder comparar se deja pasar: un
    // mensaje repetido es malo, pero dejar al paciente sin nada por un fallo de
    // consulta es peor.
    return { repetida: false, motivo: "fallo_al_comparar" };
  }
}

async function closeAdapterEventDurably(ctx, {
  status,
  processingStage,
  normalized,
  normalizedResponse,
  result,
  hermesDurationMs,
  httpStatus,
  errorCode = null,
  responseGenerated = false,
  respuestaReciclada = null
}) {
  if (!ctx || !supabase) return;
  if (ctx.startError) throw ctx.startError;
  if (!ctx.eventId || ctx.closed) return;

  const tokenUsage = result?.tokenUsage || {};
  const toolCalls = result?.toolCalls || tokenUsage.tool_calls || [];
  const completedAt = new Date().toISOString();
  const eventIdentity = resolveEventIdentity(normalized, normalizedResponse);

  // EL DESGLOSE DE CACHE DEL TURNO. Se calcula aqui, con el turno anterior de la
  // misma sesion de Hermes delante, porque es el unico momento en que se tienen las
  // dos cosas: lo que acaba de pasar y lo que habia antes.
  const acumuladosDelTurno = leerAcumuladosDelContrato(normalizedResponse);
  const sesionDeHermes = result?.hermesConversationId || null;
  let desgloseDeCache = { exacto: false, motivo: "sin_contadores_acumulados", cached_tokens: null };
  if (acumuladosDelTurno && sesionDeHermes) {
    try {
      const previo = await supabase
        .from("helios_adapter_events")
        .select("cache_acumulado_hit, cache_acumulado_nuevos")
        .eq("hermes_conversation_id", sesionDeHermes)
        .not("cache_acumulado_hit", "is", null)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      const anterior = previo?.data
        ? { hit: previo.data.cache_acumulado_hit, nuevos: previo.data.cache_acumulado_nuevos }
        : null;
      desgloseDeCache = calcularDesgloseDeCache({
        hit: acumuladosDelTurno.hit,
        nuevos: acumuladosDelTurno.nuevos,
        input_tokens: tokenUsage.input_tokens
      }, anterior);
    } catch (error) {
      // NO PUEDE ROMPER EL TURNO. Calcular un coste es contabilidad; entregarle la
      // respuesta al paciente es el trabajo. Si esta consulta falla, se guarda la
      // fila sin desglose y el panel vuelve al rango.
      desgloseDeCache = { exacto: false, motivo: "fallo_al_leer_el_turno_anterior", cached_tokens: null };
    }
  }

  const payload = {
    request_key: result?.executionRequestKey || null,
    parent_trace_id: normalized?.metadata?.parent_trace_id || null,
    account_id: normalized?.account_id || null,
    clinic_id: normalized?.clinic_id || null,
    hermes_profile: normalized?.hermes_profile || null,
    patient_first_name: eventIdentity.first_name,
    patient_last_name: eventIdentity.last_name,
    patient_display_name: eventIdentity.display_name,
    phone: normalized?.phone || null,
    message_content: normalized?.message_text || null,
    response_content: responseGenerated
      ? "[RESPONSE_GENERATED_NOT_SENT]"
      : normalizedResponse?.message_for_client || normalizedResponse?.reply || null,
    status,
    processing_stage: processingStage,
    hermes_transport: result?.transport || HERMES_TRANSPORT,
    hermes_conversation_id: result?.hermesConversationId || null,
    hermes_response_id: result?.hermesResponseId || result?.sessionId || null,
    idempotency_status: result?.idempotencyStatus || null,
    input_tokens: tokenUsage.input_tokens ?? null,
    output_tokens: tokenUsage.output_tokens ?? null,
    total_tokens: tokenUsage.total_tokens ?? null,
    // Sin esto el coste NO PUEDE ser exacto. Un token cacheado cuesta una
    // cincuentava parte de uno nuevo y aquí el acierto de caché ronda el 97%, así
    // que sin el desglose solo se puede dar un rango de 0,0001 a 0,0056 dólares
    // para el mismo mensaje. Se leía de Hermes y se tiraba: no había columna.
    // EL DESGLOSE EXACTO, cuando se puede. Hermes guarda el acierto de cache
    // ACUMULADO POR SESION y su endpoint lo descarta al serializar, asi que el guard
    // del perfil helios manda los dos acumulados dentro de state_patch -el unico
    // objeto abierto del contrato- y aqui se resta contra el turno anterior de la
    // misma sesion. La resta de dos acumulados ES el consumo del turno: aritmetica,
    // no estimacion. Y si no cuadra con la entrada reportada, no se afirma nada y
    // el panel vuelve al rango.
    cache_read_tokens: desgloseDeCache.exacto
      ? desgloseDeCache.cached_tokens
      : (tokenUsage.cache_read_tokens ?? null),
    cache_acumulado_hit: acumuladosDelTurno?.hit ?? null,
    cache_acumulado_nuevos: acumuladosDelTurno?.nuevos ?? null,
    cache_desglose_origen: desgloseDeCache.exacto
      ? "delta_de_acumulados"
      : (tokenUsage.cache_read_tokens != null ? "reportado_por_hermes" : desgloseDeCache.motivo),
    cache_write_tokens: tokenUsage.cache_write_tokens ?? null,
    // Sin fallback al perfil: si Hermes no dice qué modelo usó, se deja vacío y
    // el panel lo muestra como desconocido. Un nombre inventado impide además
    // calcular el coste, porque el catálogo de precios no lo encontraría.
    model: tokenUsage.model || null,
    tool_names: [...new Set(toolCalls.map(tool => tool?.name).filter(Boolean))],
    tool_count: toolCalls.length,
    duration_ms: Date.now() - ctx.startedAt,
    hermes_duration_ms: hermesDurationMs ?? null,
    http_status: httpStatus,
    error_code: errorCode,
    safe_to_send: normalizedResponse?.safe_to_send === true,
    // LA CAJA NEGRA. Solo se rellena cuando el contrato falla, y entonces guarda
    // EXACTAMENTE lo que llego de Hermes: el texto crudo y la forma de su
    // respuesta. Es el unico salto de los siete que no se podia mirar en SQL, y es
    // justo donde estaba el fallo. Se guarda aqui y no en los logs porque los logs
    // se perdieron tres veces seguidas y SQL nunca ha fallado.
    contract_debug: construirCajaNegra(result, normalizedResponse, errorCode, respuestaReciclada),
    finished_at: completedAt,
    completed_at: completedAt
  };
  const update = await supabase
    .from("helios_adapter_events")
    .update(payload)
    .eq("id", ctx.eventId);
  assertSupabaseSuccess(update, "adapter_events.close", {
    tenant_id: normalized?.tenant_id,
    trace_id: ctx.identity?.trace_id,
    row_id: ctx.eventId
  });
  ctx.closed = true;
}

async function sendMessageToHermes(payload) {
  if (HERMES_TRANSPORT === "agent_api") {
    return sendMessageToHermesAgentApi(payload);
  }
  if (HERMES_TRANSPORT === "webui") {
    return sendMessageToHermesWebUi(payload);
  }
  const error = new Error(`Transporte Hermes no soportado: ${HERMES_TRANSPORT}`);
  error.code = "HERMES_TRANSPORT_INVALID";
  throw error;
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

async function probeHermesAgentApi() {
  if (HERMES_TRANSPORT !== "agent_api" || !HERMES_AGENT_API_BASE_URL) {
    return { state: "NOT_CONFIGURED", authenticated: false, models_endpoint: false, latency_ms: null };
  }
  const startedAt = Date.now();
  try {
    const response = await fetch(`${HERMES_AGENT_API_BASE_URL}/v1/models`, {
      headers: HERMES_AGENT_API_KEY ? { Authorization: `Bearer ${HERMES_AGENT_API_KEY}` } : {},
      signal: AbortSignal.timeout(Math.min(HERMES_TIMEOUT_MS, 3000))
    });
    return {
      state: response.ok ? "HERMES_OK" : "HERMES_UNAVAILABLE",
      authenticated: response.status !== 401 && response.status !== 403,
      models_endpoint: response.ok,
      http_status: response.status,
      latency_ms: Date.now() - startedAt,
      last_response_completed_at: lastHermesResponseCompletedAt
    };
  } catch (error) {
    return {
      state: "HERMES_UNAVAILABLE",
      authenticated: false,
      models_endpoint: false,
      latency_ms: Date.now() - startedAt,
      error_code: error?.name === "TimeoutError" ? "HERMES_HEALTH_TIMEOUT" : "HERMES_HEALTH_NETWORK",
      last_response_completed_at: lastHermesResponseCompletedAt
    };
  }
}

async function probeSupabaseTelemetry() {
  if (!supabase) return { state: "SUPABASE_DEGRADED", read: false, latency_ms: null };
  const startedAt = Date.now();
  const result = await supabase.from("helios_adapter_events").select("id").limit(1);
  if (result.error) {
    return {
      state: "SUPABASE_DEGRADED",
      read: false,
      latency_ms: Date.now() - startedAt,
      error_code: result.error.code || "SUPABASE_UNKNOWN"
    };
  }
  return { state: "SUPABASE_OK", read: true, latency_ms: Date.now() - startedAt };
}

app.get("/health", async (req, res) => {
  const [hermesAgentApi, supabaseTelemetry] = await Promise.all([
    probeHermesAgentApi(),
    probeSupabaseTelemetry()
  ]);
  res.json({
    ok: true,
    service: "helios-hermes-adapter",
    version: PACKAGE_VERSION,
    runtime_status: "ADAPTER_OK",
    token_estimation_enabled: TOKEN_ESTIMATION_ENABLED,
    runtime: `Node.js ${process.version}`,
    profile: HERMES_PROFILE,
    hermes_profile: HERMES_PROFILE,
    mode: HERMES_TRANSPORT === "agent_api"
      ? "HERMES_AGENT_RESPONSES_API"
      : "HERMES_WEBUI_STREAM_API",
    hermes_transport: HERMES_TRANSPORT,
    hermes_agent_api_base_url_configured: Boolean(HERMES_AGENT_API_BASE_URL),
    hermes_agent_api_key_configured: Boolean(HERMES_AGENT_API_KEY),
    hermes_agent_model: HERMES_AGENT_MODEL,
    hermes_agent_api: hermesAgentApi,
    execution_store: { mode: executionStore.mode },
    execution_store_ready: Boolean(supabase),
    supabase_telemetry_status: supabaseTelemetry.state,
    supabase_telemetry: supabaseTelemetry,
    admin_pii_enabled: HELIOS_ADMIN_SHOW_PII,
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
    res.setHeader("Set-Cookie", `debug_token=${expectedToken}; Path=/; HttpOnly; ${isHttps ? "Secure;" : ""} SameSite=Lax; Max-Age=28800`);
    
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

      <!--
        SOLO EL USUARIO, NUNCA LA CONTRASEÑA. Guardar una contraseña en localStorage es
        dejarla al alcance de cualquier JavaScript de la pagina; para eso ya esta el gestor
        del navegador, que la cifra y la protege como es debido.
      -->
      <label style="display:flex; align-items:center; gap:.5rem; font-size:.8rem; color:#94a3b8; cursor:pointer; user-select:none; margin-bottom:1rem;">
        <input type="checkbox" id="recordar-usuario">
        Recordar mi usuario en este equipo
      </label>

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

    // Al abrir la pantalla, se rellena el usuario recordado y el foco salta a la
    // contraseña: si el cursor siguiera cayendo en el usuario habria que saltarlo a mano
    // cada vez, y lo recordado no ahorraria nada.
    (function ponerUsuarioRecordado() {
      const guardado = localStorage.getItem('helios_usuario_recordado');
      if (!guardado) return;
      const userEl = document.getElementById('username');
      const recordar = document.getElementById('recordar-usuario');
      if (userEl) userEl.value = guardado;
      if (recordar) recordar.checked = true;
      if (passwordInput) passwordInput.focus();
    })();

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

        // Se decide DESPUES de que el login vaya bien: recordar un usuario con el que no se
        // ha podido entrar solo sirve para que la proxima vez tampoco funcione.
        if (response.ok) {
          const recordar = document.getElementById('recordar-usuario');
          if (recordar && recordar.checked) {
            localStorage.setItem('helios_usuario_recordado', String(username).trim());
          } else {
            localStorage.removeItem('helios_usuario_recordado');
          }
        }

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
/**
 * Metricas de gasto y de mensajes, por periodo.
 *
 * LO PIDIO DAVID: «quiero una seccion al lado de donde dice servicio activo que me de
 * las metricas: del gasto de tokens y el coste real clasificado por dia, semana, mes,
 * 3 meses, 6 meses, 1 año», y despues «añade tambien la cantidad de mensajes que
 * llegan y los que salen».
 *
 * SE LEE PAGINANDO Y NO CON UN SUM DE SQL, y merece la explicacion porque es la
 * decision discutible de aqui. El cliente de Supabase no agrega, asi que un total de
 * un año exigiria una funcion en Postgres: otra migracion, otro sitio donde el
 * calculo del coste podria divergir del de pricing.js. Al volumen de hoy -decenas de
 * turnos al dia- un año son unos pocos miles de filas y traerlas es barato.
 *
 * PERO NO ES GRATIS PARA SIEMPRE. Hay un tope de filas y, si se alcanza, se devuelve
 * `truncado: true` y el panel lo dice: un total a medias presentado como total es
 * exactamente el error que este endpoint intenta no cometer. Cuando eso empiece a
 * pasar, toca mover la suma a SQL.
 */
app.get("/debug/metricas", requireDebugAuth, async (req, res) => {
  try {
    if (!supabase) throw new Error("Supabase is not initialized.");

    const periodo = String(req.query.periodo || "dia");
    if (!esPeriodoValido(periodo)) {
      return res.status(400).json({ error: true, error_code: "PERIODO_INVALIDO", validos: Object.keys(PERIODOS) });
    }

    const ahora = new Date();
    const desde = inicioDelPeriodo(periodo, ahora);

    // Tope de seguridad. 60.000 filas son mas de un año al volumen actual; si se
    // alcanza, el total es incompleto y hay que DECIRLO, no recortarlo en silencio.
    const TOPE_FILAS = 60000;
    const PAGINA = 1000;

    const eventos = [];
    let truncado = false;
    for (let inicio = 0; inicio < TOPE_FILAS; inicio += PAGINA) {
      const { data, error } = await supabase
        .from("helios_adapter_events")
        // Solo las columnas que la suma necesita: traer message_content o
        // contract_debug de miles de filas seria mover megabytes de datos de
        // pacientes para contar tokens.
        .select("created_at, status, safe_to_send, input_tokens, output_tokens, cache_read_tokens, model")
        .gte("created_at", desde.toISOString())
        .order("created_at", { ascending: false })
        .range(inicio, inicio + PAGINA - 1);

      if (error) throw error;
      if (!data || data.length === 0) break;
      eventos.push(...data);
      if (data.length < PAGINA) break;
      if (eventos.length >= TOPE_FILAS) { truncado = true; break; }
    }

    const resumen = resumirEventos(eventos, HELIOS_BILLING_MODEL);

    // LOS ARCHIVOS SE CUENTAN APARTE, y de otra tabla. El gasto de convertir una nota de
    // voz en texto ocurre en el Gateway, ANTES de que exista el turno, y puede haber
    // gasto sin turno: una cadena reenviada que se ignora cuesta dinero y no genera
    // respuesta. Ver la migracion 20260824010000_media_events.sql.
    //
    // SI ESTA CONSULTA FALLA NO SE CAE EL PANEL. El gasto de texto es el grueso y tiene
    // que seguir viendose; que falte el de los archivos se DICE en el aviso.
    let media = null;
    let mediaTruncado = false;
    let mediaError = null;
    try {
      const filasDeMedia = [];
      for (let inicio = 0; inicio < TOPE_FILAS; inicio += PAGINA) {
        const { data, error } = await supabase
          .from("helios_media_events")
          .select("created_at, tipo, accion, modelo, nivel, input_tokens, output_tokens")
          .gte("created_at", desde.toISOString())
          .order("created_at", { ascending: false })
          .range(inicio, inicio + PAGINA - 1);

        if (error) throw error;
        if (!data || data.length === 0) break;
        filasDeMedia.push(...data);
        if (data.length < PAGINA) break;
        if (filasDeMedia.length >= TOPE_FILAS) { mediaTruncado = true; break; }
      }
      media = resumirMedia(filasDeMedia);
    } catch (error) {
      mediaError = error?.code || "MEDIA_QUERY_ERROR";
      console.error(JSON.stringify({ event: "metricas_media_fallidas", error_code: mediaError }));
    }

    // EL TOTAL SUMA LOS DOS, y solo se declara completo si los dos lo son. Un total que
    // se ha dejado fuera el gasto de los archivos con pinta de exacto es peor que no
    // tenerlo: se usa para decidir.
    const costeDeTexto = resumen.coste_usd;
    const costeDeMedia = media ? media.coste_usd : 0;
    const costeTotal = Math.round((costeDeTexto + costeDeMedia) * 1e6) / 1e6;
    const totalCompleto = resumen.coste_completo && !!media && media.coste_completo && !mediaError;

    // El coste por mensaje enviado usa el TOTAL: lo que se quiere saber es cuanto cuesta
    // atender a un paciente, y si mando una nota de voz, transcribirla es parte de eso.
    const costePorSaliente = resumen.salientes > 0
      ? Math.round((costeTotal / resumen.salientes) * 1e6) / 1e6
      : null;

    return res.json({
      ok: true,
      periodo,
      etiqueta: PERIODOS[periodo].etiqueta,
      desde: desde.toISOString(),
      hasta: ahora.toISOString(),
      truncado,
      ...resumen,

      // El coste de texto conserva su nombre propio, para que en el panel se pueda
      // separar de verdad y no por resta.
      coste_texto_usd: costeDeTexto,
      coste_texto_usd_texto: formatearUsdFino(costeDeTexto),

      media,
      media_truncado: mediaTruncado,
      media_error: mediaError,
      coste_media_usd: costeDeMedia,
      coste_media_usd_texto: media ? formatearUsdFino(costeDeMedia) : null,

      coste_total_usd: costeTotal,
      coste_total_completo: totalCompleto,
      coste_usd_texto: formatearUsdFino(costeTotal),
      coste_por_saliente: costePorSaliente,
      coste_por_saliente_texto: costePorSaliente === null ? null : formatearUsdFino(costePorSaliente)
    });
  } catch (error) {
    console.error(JSON.stringify({
      event: "metricas_fallidas",
      error_code: error?.code || "METRICAS_ERROR"
    }));
    return res.status(500).json({ error: true, error_code: "METRICAS_ERROR" });
  }
});

app.get("/debug/events", requireDebugAuth, async (req, res) => {
  try {
    if (!supabase) throw new Error("Supabase is not initialized.");
    
    const { status, trace_id, conversation_id, limit = '50' } = req.query;
    
    const allowlistStatus = [
      'processing',
      'completed',
      'failed_recoverable',
      'failed_final',
      'deduplicated',
      'waiting_existing_execution',
      'ok',
      'buffered',
      'error'
    ];
    if (status && !allowlistStatus.includes(status)) {
      return res.status(400).json({ error: true, error_code: "INVALID_STATUS_FILTER" });
    }
    
    if (trace_id && trace_id.length > 50) return res.status(400).json({ error: true, error_code: "TRACE_ID_TOO_LONG" });
    if (conversation_id && conversation_id.length > 50) return res.status(400).json({ error: true, error_code: "CONV_ID_TOO_LONG" });
    
    const queryLimit = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 100);

    let query = supabase
      .from('helios_adapter_events')
      .select('id, request_key, created_at, trace_id, parent_trace_id, tenant_id, account_id, clinic_id, hermes_profile, conversation_id, contact_id, patient_first_name, patient_last_name, patient_display_name, phone, message_content, response_content, status, processing_stage, hermes_transport, hermes_conversation_id, hermes_response_id, idempotency_status, started_at, finished_at, completed_at, duration_ms, hermes_duration_ms, input_tokens, output_tokens, total_tokens, cache_read_tokens, cache_write_tokens, model, tool_names, tool_count, attempt_count, safe_to_send, http_status, error_code, contract_debug')
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

    /**
     * Con qué modelo se cobra este turno, de dónde salió esa tarifa, y el coste.
     *
     * DOS COSAS QUE EL PANEL MOSTRABA MAL:
     *
     *  1. Enseñaba `model` tal cual, y durante meses ahí se guardó «helios», que es
     *     el nombre del PERFIL y no de un modelo. Así que decía «Modelo: helios» y
     *     a la vez cobraba con la tarifa de DeepSeek, sin explicar de dónde salía.
     *     Ahora se muestra el modelo con el que de verdad se calcula, y si viene
     *     del respaldo se dice también qué hay guardado en la fila.
     *
     *  2. No se pregunta al catálogo con `||`: «helios» no está vacío, así que
     *     ganaba al respaldo y dejaba TODO el historial sin tarifa conocida.
     *
     * El coste se calcula con la tarifa VIGENTE EN SU FECHA, no en la de hoy:
     * DeepSeek sube precios el 16-08-2026 y un mensaje de antes no cuesta lo que
     * costaría ahora. Si no consta cuántos tokens vinieron de caché se devuelve un
     * rango, porque entre «todo cacheado» y «nada cacheado» hay un factor de
     * cincuenta y dar un número concreto sería inventárselo.
     */
    const usoDeTokensDelEvento = (ev) => {
      const deLaFila = modeloConTarifa(ev.model);
      const delRespaldo = deLaFila ? null : modeloConTarifa(HELIOS_BILLING_MODEL);
      const modelo = deLaFila || delRespaldo || null;
      return {
        billing_model: modelo,
        billing_model_source: deLaFila ? 'fila' : (delRespaldo ? 'variable' : 'desconocido'),
        model_guardado: ev.model || null,
        cost: calcularCoste({
          model: modelo,
          at: ev.created_at,
          input_tokens: ev.input_tokens,
          output_tokens: ev.output_tokens,
          cached_tokens: Number.isFinite(ev.cache_read_tokens) ? ev.cache_read_tokens : null
        })
      };
    };

    /**
     * Del contract_debug solo viaja el DIAGNOSTICO, nunca el texto crudo.
     *
     * texto_crudo son hasta 20.000 caracteres de la respuesta de Hermes, y ahi
     * dentro va el mensaje que se le escribio al paciente. El panel enmascara
     * message_content y response_content salvo con HELIOS_ADMIN_SHOW_PII, asi que
     * mandar el blob entero por esta puerta seria colar por detras exactamente lo
     * que se protege por delante. El diagnostico no lleva contenido: solo nombres de
     * componente y frases fijas escritas en el codigo.
     */
    const soloElDiagnostico = (debug) => {
      if (!debug || typeof debug !== 'object') return null;
      return debug.diagnostico || null;
    };

    const maskedEvents = data.map(ev => ({
        ...ev,
        phone: HELIOS_ADMIN_SHOW_PII
          ? (ev.phone || 'N/A')
          : (ev.phone ? maskPhone(ev.phone) : 'N/A'),
        patient_first_name: HELIOS_ADMIN_SHOW_PII ? ev.patient_first_name : null,
        patient_last_name: HELIOS_ADMIN_SHOW_PII ? ev.patient_last_name : null,
        patient_display_name: HELIOS_ADMIN_SHOW_PII ? ev.patient_display_name : null,
        message_content: HELIOS_ADMIN_SHOW_PII ? ev.message_content : "[REDACTED_MESSAGE]",
        response_content: HELIOS_ADMIN_SHOW_PII ? ev.response_content : "[REDACTED_RESPONSE]",
        // El blob entero NO sale de aqui: solo el diagnostico, que no lleva
        // contenido de pacientes.
        contract_debug: undefined,
        diagnostico: soloElDiagnostico(ev.contract_debug),
        ...usoDeTokensDelEvento(ev)
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

    .request-card.status-ok,
    .request-card.status-completed,
    .request-card.status-deduplicated {
      border-left: 4px solid var(--success);
    }

    .request-card.status-started {
      border-left: 4px solid var(--primary);
    }

    .request-card.status-handoff {
      border-left: 4px solid var(--warning);
    }

    .request-card.status-error,
    .request-card.status-failed_recoverable,
    .request-card.status-failed_final {
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

    .badge-ok,
    .badge-completed,
    .badge-deduplicated {
      background: var(--success-glow);
      color: var(--success);
      border: 1px solid rgba(16, 185, 129, 0.3);
    }

    .badge-handoff {
      background: var(--warning-glow);
      color: var(--warning);
      border: 1px solid rgba(245, 158, 11, 0.3);
    }

    .badge-error,
    .badge-failed_recoverable,
    .badge-failed_final {
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

  <!--
    GASTO Y MENSAJES. Lo pidio David: el coste real y los tokens por periodo, mas
    cuantos mensajes entran y cuantos salen.

    LA CIFRA QUE IMPORTA ES «POR MENSAJE ENVIADO», no el total: dice cuanto cuesta
    atender a un paciente. El total de un mes solo se puede leer sabiendo cuantos
    pacientes hubo, y esta division ya la hace el backend.

    Y SI EL TOTAL ESTA INCOMPLETO SE DICE EN ROJO. Un numero con pinta de exacto que
    se ha dejado turnos fuera es peor que no tener panel: se usa para decidir.
  -->
  <section id="metricas" style="margin: 0 0 1.5rem 0;">
    <div style="display:flex; align-items:center; justify-content:space-between; flex-wrap:wrap; gap:0.75rem; margin-bottom:0.75rem;">
      <h2 style="font-size:1rem; margin:0; color:var(--primary);">Gasto y mensajes</h2>
      <div id="metricas-periodos" style="display:flex; gap:0.35rem; flex-wrap:wrap;"></div>
    </div>
    <div id="metricas-aviso" style="display:none; font-size:0.8rem; padding:0.6rem 0.8rem; border-radius:8px; margin-bottom:0.75rem;"></div>
    <!--
      EL NIVEL GRATUITO DE GEMINI VA EN AMBAR Y NO EN ROJO, porque no es un fallo: es una
      decision tomada a proposito. Pero tiene que estar A LA VISTA, porque en el nivel
      gratuito Google usa el contenido para mejorar sus productos, y aqui el contenido son
      notas de voz de pacientes hablando de su salud. Se cuenta de las FILAS: dice cuantos
      archivos pasaron por ahi de verdad, no lo que dice una variable de entorno.
    -->
    <div id="metricas-aviso-nivel" style="display:none; font-size:0.8rem; padding:0.6rem 0.8rem; border-radius:8px; margin-bottom:0.75rem;"></div>
    <div class="stats-grid" id="metricas-tarjetas">
      <div class="stat-card">
        <div class="stat-label">Coste del periodo</div>
        <div class="stat-value" id="m-coste" style="color: var(--primary);">-</div>
        <div class="stat-detail" id="m-coste-detalle">Cargando...</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Coste por mensaje enviado</div>
        <div class="stat-value" id="m-coste-msg">-</div>
        <div class="stat-detail">Incluye el gasto de los turnos que fallaron</div>
      </div>
      <!--
        TEXTO Y ARCHIVOS SEPARADOS, como lo pidio David: «que separe el costo del de
        deepseek con el de gemini». No es curiosidad contable: son dos proveedores con
        tarifas que no se parecen y que pueden dispararse por motivos distintos. Si sube
        el total, lo primero que hay que saber es de quien es la subida.
      -->
      <div class="stat-card">
        <div class="stat-label">Texto / Archivos</div>
        <div class="stat-value" id="m-reparto" style="font-size:1.1rem; padding-top:0.5rem;">-</div>
        <div class="stat-detail" id="m-reparto-detalle">DeepSeek / Gemini</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Archivos</div>
        <div class="stat-value" id="m-archivos" style="font-size:1.1rem; padding-top:0.5rem;">-</div>
        <div class="stat-detail" id="m-archivos-detalle">audio, imagen, vídeo, documento</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Mensajes</div>
        <div class="stat-value" id="m-mensajes" style="font-size:1.1rem; padding-top:0.5rem;">-</div>
        <div class="stat-detail" id="m-mensajes-detalle">entran / salen</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Tokens</div>
        <div class="stat-value" id="m-tokens" style="font-size:1.1rem; padding-top:0.5rem;">-</div>
        <div class="stat-detail" id="m-tokens-detalle">entrada / salida</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Acierto de caché</div>
        <div class="stat-value" id="m-cache">-</div>
        <div class="stat-detail">Si baja, el gasto sube sin que cambie el uso</div>
      </div>
    </div>
  </section>

  <div class="stats-grid">
    <div class="stat-card">
      <div class="stat-label">Versión</div>
      <div class="stat-value" id="adapter-version" style="color: var(--primary);">-</div>
      <div class="stat-detail" id="adapter-runtime">Cargando runtime...</div>
    </div>
    <div class="stat-card">
      <div class="stat-label">Modo</div>
      <div class="stat-value" id="adapter-mode" style="font-size: 1.1rem; padding-top: 0.5rem; word-break: break-all;">-</div>
      <div class="stat-detail" id="adapter-mode-detail">Cargando transporte...</div>
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
      <button class="btn" id="filter-completed" onclick="setFilter('completed')">Completados</button>
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
    /**
     * Mismo formato que formatearUsd() del servidor, para que el panel y la API
     * digan exactamente lo mismo.
     *
     * VA AQUI, EN EL AMBITO DEL SCRIPT, y no dentro de renderList: estaba declarada
     * con const dentro de esa funcion y openEventDetail tambien la llama. Resultado:
     * ReferenceError en CADA clic sobre una traza, y como el cajon se abre en la
     * ultima linea de esa funcion, no se abria nada y no habia sintoma visible.
     * Estuvo roto desde que se anadio el coste al panel, porque la comprobacion de
     * sintaxis valida el fichero, pero este script viaja dentro de una plantilla de
     * texto y nunca se comprobaba.
     */
    function fmtUsd(v) {
      if (typeof v !== 'number' || !isFinite(v)) return 'N/A';
      if (v === 0) return '$0';
      return v < 0.01 ? '$' + v.toFixed(6) : '$' + v.toFixed(4);
    }

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

    const adapterVersionEl = document.getElementById('adapter-version');
    const adapterRuntimeEl = document.getElementById('adapter-runtime');
    const adapterModeEl = document.getElementById('adapter-mode');
    const adapterModeDetailEl = document.getElementById('adapter-mode-detail');

    // --- GASTO Y MENSAJES -----------------------------------------------------
    //
    // TODO EL TEXTO QUE EXPLICA UNA CIFRA LO ESCRIBE EL BACKEND o se deriva de un
    // campo suyo. Si el navegador decidiera por su cuenta cuando un total esta
    // completo, panel y backend podrian discrepar, y ya nos paso con el semaforo del
    // Gateway: decia una cosa mientras el sistema hacia otra.

    const PERIODOS_UI = [
      ['dia', 'Día'], ['semana', 'Semana'], ['mes', 'Mes'],
      ['3meses', '3 meses'], ['6meses', '6 meses'], ['ano', 'Año']
    ];
    let periodoActivo = 'dia';

    const miles = (n) => Number(n || 0).toLocaleString('es-VE');

    function pintarBotonesDePeriodo() {
      const caja = document.getElementById('metricas-periodos');
      if (!caja) return;
      caja.innerHTML = PERIODOS_UI.map(([id, texto]) => {
        const activo = id === periodoActivo;
        const estilo = activo
          ? 'background: var(--primary); color: #0b1220; font-weight: 600;'
          : 'background: rgba(255,255,255,0.04); color: #9aa4b2;';
        return '<button class="btn" data-periodo="' + id + '" style="padding:0.3rem 0.7rem; font-size:0.78rem; ' + estilo + '">' + texto + '</button>';
      }).join('');
      caja.querySelectorAll('button[data-periodo]').forEach(b => {
        b.addEventListener('click', () => {
          periodoActivo = b.dataset.periodo;
          pintarBotonesDePeriodo();
          cargarMetricas();
        });
      });
    }

    /**
     * El aviso del nivel gratuito de Gemini.
     *
     * EN AMBAR Y NO EN ROJO porque no es un fallo: es una decision tomada a proposito
     * -David eligio el nivel gratuito para las pruebas-. Pero tiene que estar A LA VISTA,
     * porque en el nivel gratuito Google usa el contenido para mejorar sus productos, y el
     * contenido aqui son notas de voz de pacientes hablando de su salud.
     *
     * SE CUENTA DE LAS FILAS y no de una variable de entorno. La pregunta que importa es
     * cuantos archivos de pacientes pasaron por ahi DE VERDAD, y eso una variable que pudo
     * cambiar entre dos despliegues no lo contesta.
     */
    function pintarAvisoDeNivel(mm) {
      const caja = document.getElementById('metricas-aviso-nivel');
      if (!caja) return;
      if (!mm || !mm.en_nivel_gratuito) {
        caja.style.display = 'none';
        return;
      }
      caja.style.display = 'block';
      caja.style.background = 'rgba(245, 158, 11, 0.1)';
      caja.style.border = '1px solid rgba(245, 158, 11, 0.3)';
      caja.style.color = '#fcd34d';
      caja.textContent =
        miles(mm.en_nivel_gratuito) + ' de ' + miles(mm.archivos) +
        ' archivos pasaron por el NIVEL GRATUITO de Gemini, donde Google usa el contenido ' +
        'para mejorar sus productos. Para pacientes reales hay que activar la facturación en ' +
        'Google y poner GEMINI_NIVEL=pago en el Gateway.';
    }

    async function cargarMetricas() {
      const aviso = document.getElementById('metricas-aviso');
      const detalle = document.getElementById('m-coste-detalle');

      // «Cargando...» SOLO LA PRIMERA VEZ. El panel se refresca cada cinco segundos, y
      // ponerlo en cada vuelta hacia que esta linea parpadeara sin parar mientras el resto
      // de las cifras se quedaban quietas: parecia que algo estaba a medio cargar
      // permanentemente. En un refresco no hay nada que anunciar: los datos viejos siguen
      // siendo validos hasta que llegan los nuevos.
      if (detalle && detalle.dataset.cargadoAlgunaVez !== 'si') detalle.textContent = 'Cargando...';
      try {
        // cache: 'no-store' NO ES DECORATIVO. Sin el, el navegador sirve la misma
        // respuesta del GET una y otra vez: David refrescaba la pagina, llegaban
        // mensajes nuevos, y las metricas seguian diciendo «2 / 2». El servidor no se
        // enteraba porque la peticion no llegaba a salir.
        const res = await fetch('/debug/metricas?periodo=' + encodeURIComponent(periodoActivo), {
          credentials: 'include',
          cache: 'no-store'
        });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const m = await res.json();

        document.getElementById('m-coste').textContent = m.coste_usd_texto || '-';
        document.getElementById('m-coste-msg').textContent = m.coste_por_saliente_texto || 'sin datos';
        document.getElementById('m-mensajes').textContent = miles(m.entrantes) + ' / ' + miles(m.salientes);
        document.getElementById('m-tokens').textContent = miles(m.total_tokens);
        document.getElementById('m-cache').textContent =
          m.acierto_cache_pct === null ? 'sin datos' : m.acierto_cache_pct + '%';

        // TEXTO Y ARCHIVOS, cada uno con su cifra. Si el de archivos no se pudo consultar
        // se dice, en vez de pintar un cero que pareceria «no se gasto nada».
        const mm = m.media || null;
        document.getElementById('m-reparto').textContent =
          (m.coste_texto_usd_texto || '-') + ' / ' + (m.coste_media_usd_texto || 'sin datos');
        document.getElementById('m-reparto-detalle').textContent = mm
          ? 'DeepSeek / Gemini'
          : 'DeepSeek / Gemini (no se pudo consultar el gasto de archivos)';

        if (mm) {
          document.getElementById('m-archivos').textContent = miles(mm.archivos);
          const porTipo = [];
          if (mm.por_tipo.audio) porTipo.push(miles(mm.por_tipo.audio) + ' audio');
          if (mm.por_tipo.imagen) porTipo.push(miles(mm.por_tipo.imagen) + ' imagen');
          if (mm.por_tipo.video) porTipo.push(miles(mm.por_tipo.video) + ' vídeo');
          if (mm.por_tipo.documento) porTipo.push(miles(mm.por_tipo.documento) + ' doc');

          // LO QUE HAY QUE MIRAR AQUI SON LOS IGNORADOS: son mensajes de pacientes que NO
          // recibieron respuesta a proposito. Si ese numero crece sin motivo, el
          // clasificador se esta comiendo mensajes de verdad, y este es el unico sitio
          // donde eso se ve: un paciente al que no se contesta no se queja, se va.
          const queSeHizo = [];
          if (mm.derivados) queSeHizo.push(miles(mm.derivados) + ' a una persona');
          if (mm.ignorados) queSeHizo.push(miles(mm.ignorados) + ' SIN responder');
          if (mm.fallidos) queSeHizo.push(miles(mm.fallidos) + ' fallaron');

          document.getElementById('m-archivos-detalle').textContent =
            (porTipo.length ? porTipo.join(', ') : 'ninguno') +
            (queSeHizo.length ? ' · ' + queSeHizo.join(', ') : '');
        } else {
          document.getElementById('m-archivos').textContent = 'sin datos';
          document.getElementById('m-archivos-detalle').textContent = m.media_error || 'no se pudo consultar';
        }

        if (detalle) {
          detalle.textContent = m.etiqueta + ' · ' + miles(m.turnos) + ' turnos' +
            (mm ? ' · ' + miles(mm.archivos) + ' archivos' : '');
          detalle.dataset.cargadoAlgunaVez = 'si';
        }
        document.getElementById('m-tokens-detalle').textContent =
          miles(m.input_tokens) + ' de entrada · ' + miles(m.output_tokens) + ' de salida';

        // ENTRAN Y SALEN NO SON EL MISMO NUMERO, y la diferencia es lo interesante:
        // son los fallos y los duplicados frenados. Verla es para lo que sirve.
        const hueco = [];
        if (m.fallidos > 0) hueco.push(miles(m.fallidos) + ' fallaron');
        if (m.deduplicados > 0) hueco.push(miles(m.deduplicados) + ' duplicados frenados');
        document.getElementById('m-mensajes-detalle').textContent =
          hueco.length ? 'entran / salen · ' + hueco.join(', ') : 'entran / salen';

        // EL AVISO DE TOTAL INCOMPLETO. En rojo y explicando por que, porque un total
        // a medias presentado como total se usa para decidir y decide mal.
        if (aviso) {
          const problemas = [];
          if (m.truncado) {
            problemas.push('Se alcanzó el tope de filas: faltan turnos por contar. Hay que mover la suma a SQL.');
          }
          if (m.media_error) {
            problemas.push(
              'No se pudo consultar el gasto de los archivos (' + m.media_error +
              '). El total mostrado es SOLO el de texto.'
            );
          }
          if (m.media_truncado) {
            problemas.push('Se alcanzó el tope de filas de archivos: falta gasto por contar.');
          }
          if (mm && mm.coste_completo === false) {
            const motivosMedia = Object.entries(mm.motivos_sin_valorar || {})
              .map(([k, v]) => v + ' por ' + k.replace(/_/g, ' ')).join(', ');
            problemas.push(
              'El coste de los archivos está INCOMPLETO: ' + miles(mm.archivos_sin_valorar) +
              ' sin valorar (' + motivosMedia + ').'
            );
          }
          if (m.coste_completo === false) {
            const motivos = Object.entries(m.motivos_sin_valorar || {})
              .map(([k, v]) => v + ' por ' + k.replace(/_/g, ' ')).join(', ');
            problemas.push(
              'El coste está INCOMPLETO: ' + miles(m.turnos_sin_valorar) +
              ' turnos no se pudieron valorar (' + motivos + '). El total mostrado es solo de los ' +
              miles(m.turnos_valorados) + ' que sí.'
            );
          }
          if (problemas.length) {
            aviso.style.display = 'block';
            aviso.style.background = 'rgba(239, 68, 68, 0.1)';
            aviso.style.border = '1px solid rgba(239, 68, 68, 0.3)';
            aviso.style.color = '#fca5a5';
            aviso.textContent = problemas.join(' ');
          } else {
            aviso.style.display = 'none';
          }
        }

        // Y EL DEL NIVEL GRATUITO, siempre: no depende de que haya nada roto.
        pintarAvisoDeNivel(mm);
      } catch (error) {
        if (detalle) detalle.textContent = 'No se pudieron cargar las métricas';
        if (aviso) {
          aviso.style.display = 'block';
          aviso.style.background = 'rgba(239, 68, 68, 0.1)';
          aviso.style.border = '1px solid rgba(239, 68, 68, 0.3)';
          aviso.style.color = '#fca5a5';
          aviso.textContent = 'No se pudieron cargar las métricas: ' + String(error.message || error);
        }
      }
    }

    pintarBotonesDePeriodo();
    cargarMetricas();

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

      // LAS METRICAS SE REFRESCAN CON EL RESTO. Estaban solo en la carga inicial, asi
      // que se quedaban congeladas mientras el historial de abajo se iba actualizando
      // cada cinco segundos: dos cifras del mismo panel contando cosas distintas.
      //
      // Va sin await y con catch propio a proposito: un fallo del resumen no puede
      // impedir que se cargue el historial de trazas, que es para lo que se abre este
      // panel cuando algo va mal.
      cargarMetricas().catch(() => {});

      try {
        try {
          const healthRes = await fetch('/health', { credentials: 'include' });
          if (healthRes.ok) {
            const healthData = await healthRes.json();
            sessionCountEl.textContent = healthData.session_count || 0;
            adapterVersionEl.textContent = healthData.version || 'N/A';
            adapterRuntimeEl.textContent = healthData.runtime || 'Node.js';
            adapterModeEl.textContent = healthData.hermes_transport || 'N/A';
            adapterModeDetailEl.textContent =
              (healthData.hermes_profile || 'perfil N/A') + ' / ' +
              (healthData.hermes_model || 'modelo N/A') + ' / ' +
              (healthData.execution_store?.mode || 'store N/A');
          }
        } catch (_) {}

        const eventsUrl = '/debug/events';
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
      
      const buttons = ['all', 'completed', 'processing', 'buffered', 'error'];
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
        filtered = filtered.filter(ev => {
          if (currentFilter === 'completed') {
            return ['completed', 'deduplicated', 'ok'].includes(ev.status);
          }
          if (currentFilter === 'error') {
            return ['error', 'failed_recoverable', 'failed_final'].includes(ev.status);
          }
          return ev.status === currentFilter;
        });
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
          if (!isNaN(date)) lastEventTimeEl.textContent = formatVenezuelaTime(date);
        }
      }

      container.innerHTML = agruparPorConversacion(events);
    }


    /**
     * Una tarjeta POR CONVERSACION, con sus mensajes dentro.
     *
     * Antes cada ejecucion era una fila suelta. Con varios pacientes escribiendo a
     * la vez es imposible seguirlo: la prueba del 17 de agosto lleno el panel de
     * cincuenta filas que en realidad eran reintentos de un punado de mensajes, y
     * no habia forma de saber cuantas conversaciones habia de verdad.
     *
     * Ahora se agrupa por conversacion y los REINTENTOS SE PLIEGAN: veinte
     * reintentos de la misma peticion son una linea que dice «20 reintentos», no
     * veinte tarjetas. Lo que queda a la vista es una fila por conversacion con su
     * estado, que es lo que se mira cuando estan entrando mensajes de golpe.
     */
    let conversacionesAbiertas = new Set();

    function alternarConversacion(id) {
      if (conversacionesAbiertas.has(id)) conversacionesAbiertas.delete(id);
      else conversacionesAbiertas.add(id);
      applyFiltersAndSearch();
    }

    function agruparPorConversacion(events) {
      const grupos = new Map();
      for (const ev of events) {
        const id = String(ev.conversation_id || 'sin-conversacion');
        if (!grupos.has(id)) grupos.set(id, []);
        grupos.get(id).push(ev);
      }

      return [...grupos.entries()].map(([id, lista]) => {
        // El primero es el mas reciente: la lista ya viene ordenada por fecha.
        const ultimo = lista[0];
        const conError = lista.filter(e => e.error_code).length;
        const dedup = lista.filter(e => e.idempotency_status === 'deduplicated').length;
        const reales = lista.length - dedup;
        const abierta = conversacionesAbiertas.has(id);

        // Los reintentos de la MISMA peticion se pliegan en una sola linea.
        const porPeticion = new Map();
        for (const e of lista) {
          const clave = e.request_key || e.trace_id || String(e.id);
          if (!porPeticion.has(clave)) porPeticion.set(clave, []);
          porPeticion.get(clave).push(e);
        }

        const cuerpo = abierta
          ? [...porPeticion.values()].map(repeticiones => {
              const principal = repeticiones[0];
              const extra = repeticiones.length - 1;
              return tarjetaDeEvento(principal) + (extra > 0
                ? '<div class="info-line" style="margin:-0.5rem 0 0.75rem 1rem; padding:0.35rem 0.6rem;'
                  + ' border-left:2px solid rgba(148,163,184,0.3); color: var(--text-muted); font-size:0.75rem;">'
                  + '+ ' + extra + ' reintento' + (extra === 1 ? '' : 's') + ' de esta misma peticion, '
                  + 'con el mismo resultado</div>'
                : '');
            }).join('')
          : '';

        const semaforo = conError === lista.length ? '#ef4444' : (conError > 0 ? '#f59e0b' : '#34d399');
        const resumen = reales + ' mensaje' + (reales === 1 ? '' : 's')
          + (dedup > 0 ? ' · ' + dedup + ' reintento' + (dedup === 1 ? '' : 's') : '')
          + (conError > 0 ? ' · ' + conError + ' con error' : '');

        return '<div class="request-card" style="cursor:pointer; border-left:3px solid ' + semaforo + ';"'
          + ' data-conv="' + escapeHtml(id) + '">'
          + '<div class="card-header"><div class="card-meta">'
          +   '<span style="font-weight:600; color:#fff;">' + (abierta ? '▾' : '▸') + ' Conversacion ' + escapeHtml(id) + '</span>'
          +   '<span class="timestamp">' + escapeHtml(ultimo.patient_display_name || 'Sin identificar') + '</span>'
          +   '<span class="timestamp">' + escapeHtml(ultimo.phone || 'N/A') + '</span>'
          + '</div>'
          + '<div style="font-size:0.8rem; color: var(--text-muted);">' + resumen + '</div>'
          + '</div></div>'
          + (abierta ? '<div style="margin-left:1rem; border-left:2px solid rgba(148,163,184,0.15); padding-left:0.75rem;">'
              + cuerpo + '</div>' : '');
      }).join('');
    }

    function tarjetaDeEvento(ev) {
      return (function() {
        const statusClass = 'status-' + ev.status;
        const badgeClass = 'badge-' + ev.status;
        const evTime = ev.started_at || ev.created_at;
        const formattedDate = evTime ? formatVenezuelaTime(new Date(evTime)) : 'N/A';
        const durationText = ev.duration_ms !== null && ev.duration_ms !== undefined ? ev.duration_ms + 'ms' : 'N/A';
        const traceShort = ev.trace_id ? ev.trace_id.slice(0, 8) + '...' : 'N/A';
        
        let detailToolsList = 'Ninguna';
        if (ev.tool_names) {
          let dt = ev.tool_names;
          try { if (typeof dt === 'string') dt = JSON.parse(dt); } catch(e){}
          if (Array.isArray(dt) && dt.length > 0) detailToolsList = escapeHtml(dt.join(', '));
        }
        
        const costText = (function(c){
        if (!c) return '';
        if (c.exact) return ' · 💵 ' + fmtUsd(c.usd);
        if (c.motivo === 'modelo_desconocido') return '';
        return ' · 💵 ' + fmtUsd(c.usd_min) + '–' + fmtUsd(c.usd_max);
      })(ev.cost);
      const tokenText = (ev.input_tokens != null ? ev.input_tokens.toLocaleString() : 'N/A') + ' / ' +
                          (ev.output_tokens != null ? ev.output_tokens.toLocaleString() : 'N/A') + ' / ' +
                          (ev.total_tokens != null ? ev.total_tokens.toLocaleString() : 'N/A');
        
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
              '<span class="timestamp" style="color: #818cf8; font-weight: 500;">🪙 Tokens: ' + tokenText + costText + '</span>' +
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
            '<div class="info-line">Hermes Conv: <code>' + escapeHtml(abbreviate(ev.hermes_conversation_id)) + '</code></div>' +
            '<div class="info-line">Hermes Resp: <code>' + escapeHtml(abbreviate(ev.hermes_response_id)) + '</code></div>' +
            '<div class="info-line">Request: <code>' + escapeHtml(abbreviate(ev.request_key)) + '</code></div>' +
            '<div class="info-line">Idempotencia: <code>' + escapeHtml(ev.idempotency_status || 'N/A') + '</code></div>' +
          '</div>' +
          (ev.error_code ? '<div class="error-msg" style="margin-top: 0.5rem; padding: 0.5rem;"><strong>Error:</strong> ' + escapeHtml(ev.error_code) + '</div>' : '') +
          // QUIEN FALLO, junto al codigo de error. OUTPUT_CONTRACT_VIOLATION es el
          // sintoma; esto dice el componente y donde mirar. Cuando no se puede
          // afirmar, se marca como sospecha y no se disfraza de certeza.
          (ev.diagnostico ? '<div style="margin-top:0.4rem;padding:0.5rem;border-left:3px solid '
            + (ev.diagnostico.seguro ? '#f87171' : '#fbbf24')
            + ';background:rgba(255,255,255,0.03);font-size:0.78rem;line-height:1.45">'
            + '<div style="font-weight:700;color:' + (ev.diagnostico.seguro ? '#fca5a5' : '#fcd34d') + '">'
            + (ev.diagnostico.seguro ? '' : 'SOSPECHA: ') + escapeHtml(ev.diagnostico.nombre || '') + '</div>'
            + '<div style="opacity:0.85;margin-top:0.25rem">' + escapeHtml(ev.diagnostico.explicacion || '') + '</div>'
            + (ev.diagnostico.donde_mirar ? '<div style="opacity:0.65;margin-top:0.25rem"><strong>Donde mirar:</strong> '
                + escapeHtml(ev.diagnostico.donde_mirar) + '</div>' : '')
            + '</div>' : '') +
        '</div>';
      })();
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
          '<div class="grid-item"><span>Timestamp Venezuela</span><div>' + (evTime ? formatVenezuelaTime(new Date(evTime)) : 'N/A') + '</div></div>' +
          '<div class="grid-item"><span>Nombre</span><div>' + escapeHtml(ev.patient_display_name || 'N/A') + '</div></div>' +
          '<div class="grid-item"><span>Nombre verificado</span><div>' + escapeHtml(ev.patient_first_name || 'N/A') + '</div></div>' +
          '<div class="grid-item"><span>Apellido verificado</span><div>' + escapeHtml(ev.patient_last_name || 'N/A') + '</div></div>' +
          '<div class="grid-item"><span>Teléfono</span><div>' + escapeHtml(ev.phone || 'N/A') + '</div></div>' +
          '<div class="grid-item"><span>Request Key</span><div>' + escapeHtml(ev.request_key || 'N/A') + '</div></div>' +
          '<div class="grid-item"><span>Hermes Conversation ID</span><div>' + escapeHtml(ev.hermes_conversation_id || 'N/A') + '</div></div>' +
          '<div class="grid-item"><span>Hermes Response ID</span><div>' + escapeHtml(ev.hermes_response_id || 'N/A') + '</div></div>' +
          '<div class="grid-item"><span>Idempotencia</span><div>' + escapeHtml(ev.idempotency_status || 'N/A') + '</div></div>' +
          '<div class="grid-item"><span>Transporte</span><div>' + escapeHtml(ev.hermes_transport || 'N/A') + '</div></div>' +
          '<div class="grid-item"><span>Trace ID Completo</span><div>' + escapeHtml(ev.trace_id || 'N/A') + '</div></div>' +
          '<div class="grid-item"><span>Tenant ID</span><div>' + escapeHtml(ev.tenant_id || 'N/A') + '</div></div>' +
          '<div class="grid-item"><span>Account ID</span><div>' + escapeHtml(ev.account_id || 'N/A') + '</div></div>' +
          '<div class="grid-item"><span>Clinic ID</span><div>' + escapeHtml(ev.clinic_id || 'N/A') + '</div></div>' +
          '<div class="grid-item"><span>Hermes Profile</span><div>' + escapeHtml(ev.hermes_profile || 'N/A') + '</div></div>' +
          '<div class="grid-item"><span>Conv ID</span><div>' + escapeHtml(ev.conversation_id || 'N/A') + '</div></div>' +
          '<div class="grid-item"><span>Contact ID</span><div>' + escapeHtml(ev.contact_id || 'N/A') + '</div></div>' +
          '<div class="grid-item"><span>Duración</span><div>' + (ev.duration_ms !== null && ev.duration_ms !== undefined ? ev.duration_ms + ' ms' : 'N/A') + '</div></div>' +
          '<div class="grid-item"><span>Hermes Duración</span><div>' + (ev.hermes_duration_ms !== null && ev.hermes_duration_ms !== undefined ? ev.hermes_duration_ms + ' ms' : 'N/A') + '</div></div>' +
          '<div class="grid-item"><span>Intentos</span><div>' + (ev.attempt_count || '1') + '</div></div>' +
          '<div class="grid-item"><span>Safe to Send</span><div>' + (ev.safe_to_send ? 'SÍ' : 'NO') + '</div></div>' +
          '<div class="grid-item"><span>HTTP Status</span><div>' + escapeHtml(ev.http_status ?? 'N/A') + '</div></div>' +
          '<div class="grid-item"><span>Etapa</span><div>' + escapeHtml(ev.processing_stage || 'N/A') + '</div></div>' +
        '</div>' +
      '</div>';

      bodyHtml += '<div class="detail-section" style="border-color: rgba(99, 102, 241, 0.2);">' +
        '<div class="detail-section-title" style="color: #818cf8;">H. Uso de Tokens</div>' +
        '<div class="grid-2col">' +
          '<div class="grid-item"><span>Modelo</span><div>' + (function(e){
              // Se muestra el modelo con el que SE COBRA, no lo que hay guardado en
              // la fila: durante meses ahi se guardo «helios», que es el perfil.
              // Si la tarifa sale del respaldo se dice, para que nadie crea que
              // Hermes informo del modelo cuando no lo hizo.
              if (e.billing_model_source === 'fila') return escapeHtml(e.billing_model);
              if (e.billing_model_source === 'variable') {
                return escapeHtml(e.billing_model)
                  + '<span style="opacity:.6;font-size:.85em"> (por variable; la fila dice «'
                  + escapeHtml(e.model_guardado || 'vacío') + '»)</span>';
              }
              return escapeHtml(e.model_guardado || 'sin identificar')
                + '<span style="opacity:.6;font-size:.85em"> (sin tarifa en el catálogo)</span>';
            })(ev) + '</div></div>' +
          '<div class="grid-item"><span>Perfil</span><div>' + escapeHtml(ev.hermes_profile || 'N/A') + '</div></div>' +
          '<div class="grid-item"><span>Coste del mensaje</span><div>' + (function(c){
              if (!c) return 'N/A';
              if (c.exact) return '<b style="color:#34d399">' + fmtUsd(c.usd) + '</b>';
              if (c.motivo === 'modelo_desconocido') return '<span title="El catálogo de precios no reconoce este modelo">sin tarifa conocida</span>';
              // Sin saber cuántos tokens vinieron de caché solo se puede acotar.
              return '<span title="No consta el desglose de caché: se muestra el rango entre todo cacheado y nada cacheado">'
                + fmtUsd(c.usd_min) + ' – ' + fmtUsd(c.usd_max) + '</span>';
            })(ev.cost) + '</div></div>' +
          '<div class="grid-item"><span>Tarifa aplicada</span><div>' + (function(c){
              if (!c || !c.franja) return 'N/A';
              if (c.franja === 'pico') return 'horario pico';
              if (c.franja === 'valle') return 'horario valle';
              return 'tarifa única';
            })(ev.cost) + '</div></div>' +
          '<div class="grid-item"><span>Input Tokens</span><div>' + (ev.input_tokens != null ? ev.input_tokens.toLocaleString() : 'N/A') + '</div></div>' +
          '<div class="grid-item"><span>Output Tokens</span><div>' + (ev.output_tokens != null ? ev.output_tokens.toLocaleString() : 'N/A') + '</div></div>' +
          '<div class="grid-item"><span>Total Tokens</span><div>' + (ev.total_tokens != null ? ev.total_tokens.toLocaleString() : 'N/A') + '</div></div>' +
          '<div class="grid-item"><span>Total Tool Calls</span><div>' + escapeHtml(ev.tool_count ?? '0') + '</div></div>' +
          '<div class="grid-item"><span>Herramientas Usadas</span><div>' + (function(t){if(!t)return 'Ninguna';try{if(typeof t==='string')t=JSON.parse(t);}catch(e){}if(Array.isArray(t)&&t.length>0)return escapeHtml(t.join(', '));return 'Ninguna'})(ev.tool_names) + '</div></div>' +
        '</div>' +
      '</div>';

      bodyHtml += '<div class="detail-section">' +
        '<div class="detail-section-title">Contenido operativo (según política administrativa)</div>' +
        '<div class="grid-item"><span>Mensaje recibido</span><div>' + escapeHtml(ev.message_content || 'N/A') + '</div></div>' +
        '<div class="grid-item" style="margin-top:0.75rem"><span>Respuesta generada</span><div>' + escapeHtml(ev.response_content || 'N/A') + '</div></div>' +
      '</div>';

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
      // La cabecera de una conversacion se pliega y despliega. Va antes que la
      // tarjeta de traza porque la cabecera TAMBIEN es una .request-card.
      const cabecera = e.target.closest('[data-conv]');
      if (cabecera) {
        alternarConversacion(cabecera.dataset.conv);
        return;
      }
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

    function abbreviate(value) {
      const text = String(value || '');
      if (!text) return 'N/A';
      return text.length > 20 ? text.slice(0, 12) + '...' + text.slice(-6) : text;
    }

    function formatVenezuelaTime(value) {
      return value.toLocaleString('es-VE', {
        timeZone: 'America/Caracas',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit'
      });
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
  if (error.code === "ADAPTER_EXECUTION_IN_PROGRESS") {
    return {
      error_code: error.code,
      intent: "waiting_existing_execution",
      recoverable: true,
      requires_handoff: false,
      safe_to_send: false,
      response_sent: false,
      http_status: 409
    };
  }
  if (error.code === "ADAPTER_EXECUTION_FAILED_FINAL") {
    return {
      error_code: error.code,
      intent: "execution_failed_final",
      recoverable: false,
      requires_handoff: false,
      safe_to_send: false,
      response_sent: false,
      http_status: 409
    };
  }
  if (String(error.code || "").startsWith("SUPABASE_")) {
    return {
      error_code: error.code,
      intent: "adapter_persistence_error",
      recoverable: true,
      requires_handoff: false,
      safe_to_send: false,
      response_sent: false,
      http_status: 503
    };
  }
  if (
    error.code === "TENANT_NOT_CONFIGURED" ||
    error.code === "TENANT_CONTEXT_INVALID" ||
    error.code === "TENANT_CONTEXT_MISMATCH"
  ) {
    return {
      error_code: error.code,
      intent: "tenant_configuration_error",
      recoverable: false,
      requires_handoff: false,
      safe_to_send: false,
      response_sent: false,
      http_status: 422
    };
  }

  const errStr = String(error.message || "").toLowerCase();
  const isTimeout = 
    error.name === "AbortError" || 
    error.code === "HERMES_TIMEOUT" ||
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
  return "[REDACTED_MESSAGE]";
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

  return "[REDACTED_RESPONSE]";
}

function extractPhone(normalized, payload, input) {
  return normalized?.conversation?.phone || normalized?.patient?.phone || payload?.conversation?.phone || payload?.patient?.phone || input?.conversation?.phone || input?.patient?.phone || null;
}

function getPatientDisplayName(patient) {
  if (!patient) return "Contacto sin identificar";
  const firstName = String(patient.first_name || "").trim();
  const lastName = String(patient.last_name || "").trim();
  const invalid = value => !value || ["[REDACTED]", "UNKNOWN", "N/A"].includes(value.toUpperCase());
  if (!invalid(firstName) && !invalid(lastName)) {
    return patient.first_name + " " + patient.last_name;
  }
  return "Contacto sin identificar";
}

function getDisplayNameSource(patient) {
  if (!patient) return "unknown";
  if (patient.profile_complete === true && patient.first_name && patient.last_name) return "verified_profile";
  return "unknown";
}

async function finalizeAdapterEventReliably(
  telemetryCtx,
  finalStatus,
  normalizedResponse,
  hermesDurationMs,
  debugEvent,
  extra
) {
  if (telemetryCtx?.closed) return;
  const traceId = telemetryCtx?.identity?.trace_id || "";
  let primarySuccess = false;
  try {
    const ctxClone = { ...telemetryCtx, closed: false };
    
    const result = await withTimeout(
      finishAdapterEvent(
        ctxClone,
        finalStatus,
        { ...normalizedResponse, response_sent: false },
        hermesDurationMs,
        debugEvent.token_usage,
        extra
      ),
      3000,
      TELEMETRY_TIMEOUT
    );

    if (result === TELEMETRY_TIMEOUT) {
      throw new Error("Primary telemetry finish timed out (>3000ms)");
    }
    primarySuccess = true;

    if (primarySuccess) {
      console.log(JSON.stringify({
        event: "adapter_telemetry_finished",
        trace_id: traceId,
        processing_stage: "response_returned",
        ok: normalizedResponse.ok,
        safe_to_send: normalizedResponse.safe_to_send,
        error_code: normalizedResponse.error_code || null
      }));
    }
  } catch (err) {
    console.warn(JSON.stringify({
      event: "adapter_telemetry_primary_failed",
      trace_id: traceId,
      processing_stage: "response_returned",
      ok: normalizedResponse.ok,
      safe_to_send: normalizedResponse.safe_to_send,
      error_code: normalizedResponse.error_code || null,
      error: err.message
    }));

    if (telemetryCtx && telemetryCtx.eventId && supabase) {
      try {
        const durationMs = Date.now() - telemetryCtx.startedAt;
        const fallbackUpdate = {
          status: finalStatus,
          safe_to_send: normalizedResponse.safe_to_send === true,
          response_sent: false,
          error_code: normalizedResponse.error_code || null,
          processing_stage: "response_returned",
          duration_ms: durationMs,
          finished_at: new Date().toISOString()
        };

        const result = await withTimeout(
          supabase
            .from('helios_adapter_events')
            .update(fallbackUpdate)
            .eq('id', telemetryCtx.eventId),
          3000,
          TELEMETRY_TIMEOUT
        );

        if (result === TELEMETRY_TIMEOUT) {
          throw new Error("Fallback telemetry update timed out");
        }

        if (result?.error) {
          throw new Error(
            `Fallback telemetry update failed: ${result.error.message}`
          );
        }

        console.log(JSON.stringify({
          event: "adapter_telemetry_fallback_finished",
          trace_id: traceId,
          processing_stage: "response_returned",
          ok: normalizedResponse.ok,
          safe_to_send: normalizedResponse.safe_to_send,
          error_code: normalizedResponse.error_code || null
        }));
      } catch (fallbackErr) {
        console.error(JSON.stringify({
          event: "adapter_telemetry_finalize_failed",
          trace_id: traceId,
          processing_stage: "response_returned",
          ok: normalizedResponse.ok,
          safe_to_send: normalizedResponse.safe_to_send,
          error_code: normalizedResponse.error_code || null,
          error: fallbackErr.message
        }));
      }
    }
  }
}

app.post("/helios/message", async (req, res) => {
  let processingStage = "request_received";
  let requestPhone = null;
  let requestPatientDisplayName = "Contacto sin identificar";
  let requestPatientFirstName = null;
  let requestPatientLastName = null;
  processingStage = "telemetry_started";
  const telemetryCtx = await startAdapterEvent(req.body || {});
  const startTime = Date.now();
  const uniqueEventId = crypto.randomUUID();
  const payload = req.body || {};
  let hermesDurationMs = null;
  let result = null;
  
  let normalized;
  try {
    normalized = normalizeGatewayPayload(payload);
    requestPhone = normalized.phone || null;
    requestPatientFirstName = normalized.patient?.first_name || null;
    requestPatientLastName = normalized.patient?.last_name || null;
    requestPatientDisplayName = getPatientDisplayName(normalized.patient);
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

    input_preview: maskPreview(normalized.message_text),
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
    if (telemetryCtx?.startError && supabase) {
      throw telemetryCtx.startError;
    }
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
        name_present: Boolean(normalized.patient?.name),
        email_present: Boolean(normalized.patient?.email)
      },
      state: normalized.state,
      message: {
        text: maskPreview(normalized.message_text),
        message_count: normalized.message_count,
        messages: normalized.message_items.map((item) => ({
          id: item?.id,
          created_at: item?.created_at,
          body: item?.body ? "[REDACTED_MESSAGE]" : item?.body
        }))
      }
    };
    debugEvent.input_detail = JSON.stringify(input_detail, null, 2);

    debugEvent.hermes_request_preview = "[OPERATIONAL_PAYLOAD_REDACTED]";
    debugEvent.hermes_request_detail = debugEvent.input_detail;
  } catch (_) {}

  let sessionId = "";
  let streamId = "";
  let rawResponseText = "";
  let finalReply = "";
  let finalStatus = "ok";
  let errorMsg = "";
  let finalRoute = "hermes";
  let finalIntent = "respuesta_hermes";
  let normalizedResponse = null;
  let contractShapeValid = false;
  let contractStrategy = null;
  let contractCandidateCount = 0;
  let normalizedSafeToSend = false;
  let normalizedErrorCode = null;

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

    if (NODE_ENV === "production" && !supabase) {
      const persistenceError = new Error("Durable execution store is not configured");
      persistenceError.code = "SUPABASE_NOT_CONFIGURED";
      throw persistenceError;
    }

    const hermesStartTime = Date.now();
    try {
      processingStage = "hermes_request";
      result = await sendMessageToHermes(payload);
      hermesDurationMs = Date.now() - hermesStartTime;
    } catch(err) {
      hermesDurationMs = Date.now() - hermesStartTime;
      throw err;
    }
    sessionId = result.sessionId || "";
    streamId = result.streamId || "";
    rawResponseText = result.answer || "";
    processingStage = "hermes_response_received";

    // TITULAR LA SESION AQUI, EN CUANTO SE SABE CUAL ES, y no solo al final.
    //
    // Antes solo se hacia despues de persistir el turno, o sea unicamente cuando todo
    // salia bien. Un turno que revienta antes -un contrato vetado, una excepcion- se
    // quedaba con el nombre que Hermes le pone por defecto: la primera linea del prompt.
    // En el WebUI salian varias sesiones llamadas «OUTPUT CONTRACT (REQUIRED)»,
    // indistinguibles entre si.
    //
    // Y son justo las que hay que encontrar. Una sesion que fallo es la que alguien va a
    // ir a buscar; la que salio bien no la mira nadie.
    //
    // Se vuelve a llamar mas abajo con la respuesta ya normalizada, para cambiar
    // «Helios · Conversacion 84» por «David Mercado · Conversacion 84» en cuanto se
    // conoce el nombre. La segunda llamada no repite trabajo: hay un guard por titulo.
    ensureHermesSessionTitle(sessionId, normalized, null).catch(() => {});

    debugEvent.hermes_session_id = sessionId;
    debugEvent.hermes_stream_id = streamId;
    if (result.tokenUsage) {
      debugEvent.token_usage = result.tokenUsage;
    }

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
        operation_type: "technical_error",
        operation_status: "failed",
        operation_summary: "Active Hermes stream conflict",
        has_profile_patch: false,
        has_booking_patch: false,
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
          profile: result.hermesProfile,
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

      processingStage = "response_returned";
      const traceId = telemetryCtx?.identity?.trace_id || normalized?.trace_id || "";

      // OBJETIVO 1 — OBSERVABILIDAD HTTP REAL
      console.log(JSON.stringify({
        event: "adapter_http_response_start",
        trace_id: traceId,
        processing_stage: processingStage,
        ok: conflictResponse.ok,
        safe_to_send: conflictResponse.safe_to_send,
        error_code: conflictResponse.error_code,
        headers_sent: res.headersSent,
        elapsed_ms: Date.now() - startTime
      }));

      res.once("finish", () => {
        console.log(JSON.stringify({
          event: "adapter_http_response_finish",
          trace_id: traceId,
          status_code: res.statusCode,
          headers_sent: res.headersSent,
          elapsed_ms: Date.now() - startTime
        }));
      });

      res.once("close", () => {
        console.log(JSON.stringify({
          event: "adapter_http_response_close",
          trace_id: traceId,
          writable_ended: res.writableEnded,
          headers_sent: res.headersSent,
          elapsed_ms: Date.now() - startTime
        }));
      });

      await closeAdapterEventDurably(telemetryCtx, {
        status: "failed_recoverable",
        processingStage: "response_returned",
        normalized,
        normalizedResponse: conflictResponse,
        result,
        hermesDurationMs,
        httpStatus: 409,
        errorCode: "ACTIVE_STREAM_CONFLICT"
      });
      res.status(409).json(conflictResponse);

      console.log(JSON.stringify({
        event: "adapter_http_response_invoked",
        trace_id: traceId,
        processing_stage: processingStage,
        ok: conflictResponse.ok,
        safe_to_send: conflictResponse.safe_to_send,
        error_code: conflictResponse.error_code
      }));

      // Cerrar telemetría en segundo plano con manejo explícito
      void (async () => {
        if (sessionId && result.transport !== "agent_api") {
          try {
            const { sessionData, attempts } = await fetchHermesSessionData(
              sessionId,
              result.hermesProfile
            );
            debugEvent.token_usage = extractTokenUsage(sessionData, attempts);
          } catch (_) {}
        }

        await finalizeAdapterEventReliably(
          telemetryCtx,
          "error",
          conflictResponse,
          hermesDurationMs,
          debugEvent,
          {
            patient_display_name: requestPatientDisplayName,
            phone: requestPhone,
            hermes_first_token_ms: typeof hermesFirstTokenMs !== 'undefined' ? hermesFirstTokenMs : null,
            session_id: sessionId,
            stream_id: streamId,
            processing_stage: "response_returned",
            display_name_source: getDisplayNameSource(normalized?.patient),
            message_preview: maskPreview(normalized?.message_text),
            message_count: normalized?.message_count,
            intent: finalIntent,
            route: finalRoute,
            provider_error_code: "ACTIVE_STREAM_CONFLICT",
            response_preview: extractResponsePreview(conflictResponse)
          }
        );
      })().catch((error) => {
        console.error(JSON.stringify({
          event: "adapter_background_finalize_unhandled",
          trace_id: traceId,
          error: error?.message || "unknown"
        }));
      });

      return;
    }

    processingStage = "contract_normalization";

    // UNA PETICION DEDUPLICADA SIN RESULTADO GUARDADO NO ES UNA VIOLACION DE
    // CONTRATO, y confundirlas costo una prueba de carga entera.
    //
    // Cuando el Adapter reconoce una peticion repetida devuelve `answer: ""` y el
    // resultado que tenia guardado. Si ese resultado guardado esta vacio -la
    // ejecucion original murio antes de escribirlo-, la linea de abajo caia al
    // parser, el parser leia una cadena vacia, no encontraba ningun JSON y
    // declaraba OUTPUT_CONTRACT_VIOLATION. Un error de contrato que nunca ocurrio,
    // porque en ese turno no hubo ni modelo ni respuesta que validar.
    //
    // Y lo peor no es el nombre equivocado: ese error se marcaba RECUPERABLE, asi
    // que el worker de recuperacion lo reintentaba, el Adapter volvia a decir
    // «esto ya lo tengo», volvia a devolver vacio, y volvia a fallar. Un bucle que
    // no podia progresar nunca. En la prueba del 17 de agosto las CINCUENTA filas
    // del panel eran reintentos de un punado de fallos originales.
    //
    // Ahora se dice lo que es y se marca NO recuperable, para que el bucle pare.
    const dedupSinResultado = result.idempotencyStatus === "deduplicated"
      && !result.persistedNormalizedResult
      && !String(result.answer || "").trim();

    if (dedupSinResultado) {
      console.warn(JSON.stringify({
        event: "adapter_dedup_sin_resultado",
        trace_id: traceId,
        request_key: result.executionRequestKey,
        persisted_error_code: result.persistedErrorCode || null,
        nota: "peticion repetida cuya ejecucion original no dejo resultado; no se reintenta"
      }));
    }

    normalizedResponse = result.persistedNormalizedResult || (dedupSinResultado ? {
      ok: false,
      reply: "",
      message_for_client: "",
      route: "error",
      intent: "technical_error",
      operation: {
        type: "technical_error",
        status: "failed",
        summary: "Peticion repetida cuya ejecucion original no dejo resultado guardado."
      },
      operation_type: "technical_error",
      operation_status: "failed",
      operation_summary: "Peticion repetida cuya ejecucion original no dejo resultado guardado.",
      profile_patch: {},
      state_patch: {},
      booking_patch: {},
      has_profile_patch: false,
      has_booking_patch: false,
      has_state_patch: false,
      tool_calls: [],
      safe_to_send: false,
      response_sent: false,
      requires_handoff: false,
      // NO recuperable: reintentarlo devuelve exactamente lo mismo, para siempre.
      recoverable: false,
      contract_repair_applied: false,
      contract_repair_reason: null,
      original_output_format: "deduplicated_without_result",
      error_code: result.persistedErrorCode || "ADAPTER_DEDUP_SIN_RESULTADO",
      contract_shape_valid: false,
      contract_strategy: "deduplicated_without_result",
      contract_candidate_count: 0
    } : normalizeAdapterResponse(result, {
      httpStatus: result.httpStatus,
      toolCalls: result.toolCalls || [],
      identityComplete: normalized.patient?.identity_complete,
      missingFields: normalized.state?.missing_fields || []
    }));
    // UN REINTENTO DEDUPLICADO DE ALGO QUE YA FALLO NO SE PUEDE REINTENTAR MAS.
    //
    // Cuando la peticion es repetida, el Adapter devuelve el resultado que ya tenia
    // guardado. Si ese resultado era un FALLO marcado como recuperable, pasa esto:
    // el worker de recuperacion lo reintenta, recibe EXACTAMENTE el mismo fallo
    // guardado, y lo vuelve a reintentar. Por construccion devuelve siempre lo
    // mismo. Es un bucle que no puede progresar nunca.
    //
    // El arreglo anterior solo cubria el caso SIN resultado guardado, y por eso no
    // sirvio: lo que ocurria de verdad es este, CON resultado guardado y siendo un
    // fallo. El sintoma era que el panel seguia diciendo la causa original -por
    // ejemplo OUTPUT_CONTRACT_VIOLATION- en cada reintento, como si volviera a
    // pasar, cuando en realidad no se estaba ejecutando nada.
    //
    // Al marcarlo NO recuperable pasan dos cosas buenas: el bucle para, y el
    // Gateway lo trata como fallo definitivo, que es lo que dispara el aviso a
    // Soporte Tecnico y el mensaje al paciente. Deja de morir en silencio.
    if (result.idempotencyStatus === "deduplicated" && normalizedResponse) {
      const guardadoFueFallo = normalizedResponse.ok === false
        || Boolean(normalizedResponse.error_code);
      if (guardadoFueFallo) {
        const causaOriginal = normalizedResponse.error_code || "desconocida";
        normalizedResponse = {
          ...normalizedResponse,
          recoverable: false,
          // Se cambia el codigo a proposito: el que habia describe lo que paso la
          // PRIMERA vez, no lo que acaba de pasar. La causa original se conserva
          // aparte para no perder el diagnostico.
          error_code: "REINTENTO_ABANDONADO",
          error_code_original: causaOriginal,
          operation: {
            ...(normalizedResponse.operation || {}),
            type: normalizedResponse.operation?.type || "technical_error",
            status: "failed",
            summary: "Reintento de una peticion que ya habia fallado. No se reintenta"
              + " mas porque devolveria lo mismo. Causa original: " + causaOriginal
          }
        };
        console.warn(JSON.stringify({
          event: "adapter_reintento_abandonado",
          trace_id: traceId,
          request_key: result.executionRequestKey,
          causa_original: causaOriginal
        }));
      }
    }

    contractShapeValid = result.persistedNormalizedResult
      ? typeof normalizedResponse?.contract_shape_valid === "boolean"
        ? normalizedResponse.contract_shape_valid
        : isValidHermesContract(normalizedResponse)
      : normalizedResponse?.contract_shape_valid === true;
    contractStrategy = result.persistedNormalizedResult
      ? normalizedResponse?.contract_strategy || "persisted_normalized_result"
      : normalizedResponse?.contract_strategy || null;
    contractCandidateCount = Number.isInteger(normalizedResponse?.contract_candidate_count)
      ? normalizedResponse.contract_candidate_count
      : 0;
    normalizedSafeToSend = normalizedResponse?.safe_to_send === true;
    normalizedErrorCode = normalizedResponse?.error_code || null;
    normalizedResponse.request_key = result.executionRequestKey || null;
    processingStage = "contract_validated";
    console.log(JSON.stringify(buildProcessingTelemetry({
      traceId: telemetryCtx?.identity?.trace_id || normalized?.trace_id || "",
      requestKey: result.executionRequestKey,
      processingStage,
      answerSource: result.answerSource,
      answer: rawResponseText,
      contractShapeValid,
      contractStrategy,
      contractCandidateCount,
      normalizedSafeToSend,
      normalizedErrorCode,
      durableResultReused: result.durableResultReused,
      persistedResultStatus: result.persistedResultStatus,
      persistedErrorCode: result.persistedErrorCode
    })));
    if (result.idempotencyStatus === "new") {
      processingStage = "durable_persistence";
      try {
        await executionStore.complete(result.executionRequestKey, {
          hermes_conversation_id: result.hermesConversationId,
          hermes_response_id: result.hermesResponseId || result.sessionId,
          normalized_result: normalizedResponse,
          tool_calls: result.toolCalls || [],
          token_usage: result.tokenUsage || {},
          duration_ms: hermesDurationMs
        });
      } catch (error) {
        error.exceptionStage = "durable_persistence";
        error.executionRequestKey = result.executionRequestKey;
        throw error;
      }
    }

    // Sin await: titular la sesion no debe retrasar la respuesta al paciente.
    // Se hace aqui, y no antes, porque necesita el profile_patch de la respuesta
    // para poder usar el nombre del paciente en cuanto se conoce.
    ensureHermesSessionTitle(result.sessionId, normalized, normalizedResponse).catch(() => {});
    finalReply = normalizedResponse.reply || "";
    finalStatus = normalizedResponse.ok ? "ok" : "error";
    finalRoute = normalizedResponse.route || "hermes";
    finalIntent = normalizedResponse.intent || "respuesta_hermes";

    debugEvent.status = finalStatus;
    debugEvent.route = finalRoute;
    debugEvent.intent = finalIntent;
    debugEvent.requires_handoff = normalizedResponse.requires_handoff === true;
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

    processingStage = "telemetry_finalize";
    // Registrar listeners una sola vez antes de responder:
    const traceId = telemetryCtx?.identity?.trace_id || normalized?.trace_id || "";

    // OBJETIVO 1 — OBSERVABILIDAD HTTP REAL
    console.log(JSON.stringify({
      event: "adapter_http_response_start",
      trace_id: traceId,
      processing_stage: processingStage,
      ok: normalizedResponse.ok,
      safe_to_send: normalizedResponse.safe_to_send,
      error_code: normalizedResponse.error_code || null,
      headers_sent: res.headersSent,
      elapsed_ms: Date.now() - startTime
    }));

    res.once("finish", () => {
      console.log(JSON.stringify({
        event: "adapter_http_response_finish",
        trace_id: traceId,
        status_code: res.statusCode,
        headers_sent: res.headersSent,
        elapsed_ms: Date.now() - startTime
      }));
    });

    res.once("close", () => {
      console.log(JSON.stringify({
        event: "adapter_http_response_close",
        trace_id: traceId,
        writable_ended: res.writableEnded,
        headers_sent: res.headersSent,
        elapsed_ms: Date.now() - startTime
      }));
    });

    // NUNCA SE ENTREGA UNA RESPUESTA QUE EL PACIENTE YA LEYO.
    const respuestaReciclada = await comprobarRespuestaReciclada(normalized, normalizedResponse);
    if (respuestaReciclada.repetida) {
      console.error(JSON.stringify({
        event: "respuesta_reciclada_bloqueada",
        trace_id: traceId,
        tenant_id: normalized?.tenant_id,
        conversation_id: normalized?.conversation_id,
        motivo: respuestaReciclada.motivo,
        que_significa: "El turno no genero mensaje propio y se recupero uno viejo del "
          + "historial reinyectado. Se bloquea: el paciente recibiria algo que ya leyo."
      }));
      normalizedResponse = {
        ...normalizedResponse,
        ok: false,
        safe_to_send: false,
        message_for_client: "",
        reply: "",
        recoverable: true,
        error_code: "RESPUESTA_RECICLADA"
      };
    }

    await closeAdapterEventDurably(telemetryCtx, {
      status: result.idempotencyStatus === "deduplicated"
        ? "deduplicated"
        : normalizedResponse.ok ? "completed" : "failed_recoverable",
      processingStage,
      normalized,
      normalizedResponse,
      result,
      hermesDurationMs,
      httpStatus: 200,
      errorCode: normalizedResponse.error_code || null,
      respuestaReciclada
    });

    // La ejecución y la telemetría ya son durables antes de responder.
    processingStage = "response_returned";
    res.json(normalizedResponse);

    console.log(JSON.stringify({
      event: "adapter_http_response_invoked",
      trace_id: traceId,
      processing_stage: processingStage,
      ok: normalizedResponse.ok,
      safe_to_send: normalizedResponse.safe_to_send,
      error_code: normalizedResponse.error_code || null
    }));

    // Cerrar telemetría en segundo plano con manejo explícito
    void (async () => {
      if (sessionId && result.transport !== "agent_api") {
        try {
          const sessionResult = await withTimeout(
            fetchHermesSessionData(sessionId, result.hermesProfile),
            3000,
            { sessionData: null, attempts: [] }
          );
          debugEvent.token_usage = extractTokenUsage(
            sessionResult.sessionData,
            sessionResult.attempts
          );
        } catch (_) {}
      }

      await finalizeAdapterEventReliably(
        telemetryCtx,
        finalStatus,
        normalizedResponse,
        hermesDurationMs,
        debugEvent,
        {
          patient_display_name: requestPatientDisplayName,
          phone: requestPhone,
          hermes_first_token_ms: typeof hermesFirstTokenMs !== 'undefined' ? hermesFirstTokenMs : null,
          session_id: sessionId,
          stream_id: streamId,
          processing_stage: "response_returned",
          display_name_source: getDisplayNameSource(normalized?.patient),
          message_preview: maskPreview(normalized?.message_text),
          message_count: normalized?.message_count,
          intent: finalIntent,
          response_preview: extractResponsePreview(normalizedResponse),
          route: finalRoute,
        }
      );
    })().catch((error) => {
      console.error(JSON.stringify({
        event: "adapter_background_finalize_unhandled",
        trace_id: traceId,
        error: error?.message || "unknown"
      }));
    });

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

    const exceptionStage = error.exceptionStage || processingStage;
    error.exceptionStage = exceptionStage;
    const normalizedError = classifyPostProcessingError(
      error,
      { processingStage: exceptionStage, contractShapeValid },
      normalizeProviderError(error)
    );
    console.warn(JSON.stringify(buildProcessingTelemetry({
      traceId: telemetryCtx?.identity?.trace_id || normalized?.trace_id || "",
      requestKey: result?.executionRequestKey || error.executionRequestKey,
      processingStage: exceptionStage,
      answerSource: result?.answerSource,
      answer: rawResponseText,
      contractShapeValid,
      contractStrategy,
      contractCandidateCount,
      normalizedSafeToSend,
      normalizedErrorCode,
      durableResultReused: result?.durableResultReused,
      persistedResultStatus: result?.persistedResultStatus,
      persistedErrorCode: result?.persistedErrorCode,
      exception: error
    })));
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

    const traceId = telemetryCtx?.identity?.trace_id || normalized?.trace_id || "";

    // OBJETIVO 1 — OBSERVABILIDAD HTTP REAL
    console.log(JSON.stringify({
      event: "adapter_http_response_start",
      trace_id: traceId,
      processing_stage: processingStage,
      ok: errorResponse.ok,
      safe_to_send: errorResponse.safe_to_send,
      error_code: errorResponse.error_code,
      headers_sent: res.headersSent,
      elapsed_ms: Date.now() - startTime
    }));

    res.once("finish", () => {
      console.log(JSON.stringify({
        event: "adapter_http_response_finish",
        trace_id: traceId,
        status_code: res.statusCode,
        headers_sent: res.headersSent,
        elapsed_ms: Date.now() - startTime
      }));
    });

    res.once("close", () => {
      console.log(JSON.stringify({
        event: "adapter_http_response_close",
        trace_id: traceId,
        writable_ended: res.writableEnded,
        headers_sent: res.headersSent,
        elapsed_ms: Date.now() - startTime
      }));
    });

    try {
      if (error.executionRequestKey) {
        await executionStore.fail(
          error.executionRequestKey,
          normalizedError.error_code,
          normalizedError.recoverable !== false
        );
      }
      if (supabase) {
        await closeAdapterEventDurably(telemetryCtx, {
          status: normalizedError.recoverable === false ? "failed_final" : "failed_recoverable",
          processingStage: exceptionStage,
          normalized,
          normalizedResponse: errorResponse,
          result: {
            executionRequestKey: error.executionRequestKey || null,
            transport: HERMES_TRANSPORT,
            hermesConversationId: error.hermesConversationId || null,
            tokenUsage: debugEvent.token_usage,
            toolCalls: debugEvent.token_usage?.tool_calls || []
          },
          hermesDurationMs,
          httpStatus: normalizedError.http_status,
          errorCode: normalizedError.error_code,
          responseGenerated: contractShapeValid && Boolean(
            normalizedResponse?.message_for_client || normalizedResponse?.reply
          )
        });
      }
    } catch (persistenceError) {
      return res.status(503).json({
        ok: false,
        safe_to_send: false,
        recoverable: true,
        error_code: persistenceError.code || "ADAPTER_PERSISTENCE_FAILED"
      });
    }

    res.status(normalizedError.http_status).json(errorResponse);

    console.log(JSON.stringify({
      event: "adapter_http_response_invoked",
      trace_id: traceId,
      processing_stage: processingStage,
      ok: errorResponse.ok,
      safe_to_send: errorResponse.safe_to_send,
      error_code: errorResponse.error_code
    }));

    // Cerrar telemetría en segundo plano
    void (async () => {
      if (sessionId && HERMES_TRANSPORT !== "agent_api") {
        try {
          const { sessionData, attempts } = await fetchHermesSessionData(
            sessionId,
            normalized?.hermes_profile
          );
          debugEvent.token_usage = extractTokenUsage(sessionData, attempts);
        } catch (_) {}
      }

      try {
        await withTimeout(
          failAdapterEvent(
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
          ),
          3000,
          null
        );
      } catch (err) {
        console.error(JSON.stringify({
          event: "adapter_telemetry_finalize_failed",
          trace_id: traceId,
          processing_stage: processingStage,
          ok: errorResponse.ok,
          safe_to_send: errorResponse.safe_to_send,
          error_code: errorResponse.error_code,
          error: err.message
        }));
      }
    })().catch((error) => {
      console.error(JSON.stringify({
        event: "adapter_background_finalize_unhandled",
        trace_id: traceId,
        error: error?.message || "unknown"
      }));
    });
  }
});

app.listen(PORT, () => {
  console.log(`helios-hermes-adapter v2.5.1 listening on port ${PORT}`);
});
