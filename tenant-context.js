"use strict";

/**
 * De quien es cada mensaje, visto desde el Adapter.
 *
 * EL ADAPTER NO SE FIA DEL GATEWAY, Y HACE BIEN. El Gateway le manda tenant_id, clinic_id
 * y hermes_profile en el payload; `validateTenantContext` los RESUELVE otra vez por su
 * cuenta y compara. Si no coinciden, rechaza el mensaje. Eso es lo que impide que un
 * payload mal construido acabe hablando con el Hermes de otra clinica.
 *
 * Y DE AHI SALE EL CUIDADO DE ESTE FICHERO. Esa comprobacion solo protege mientras las dos
 * partes miren LO MISMO. Hasta hoy miraban dos copias a mano de la misma variable de
 * entorno, una en cada servicio de Coolify: si alguien editaba una y olvidaba la otra, la
 * comprobacion pasaba de proteger a rechazar mensajes buenos, y el sintoma
 * -TENANT_CONTEXT_MISMATCH- no se parece en nada a la causa.
 *
 * Por eso las dos partes pasan a leer LA MISMA TABLA. La deriva deja de detectarse para
 * volverse imposible, que es mejor sitio donde impedirla.
 *
 * COMO SE LEE, igual que en el Gateway:
 *
 *   ARRANQUE   la variable de entorno de siempre. El primer mensaje ya se atiende.
 *   LUEGO      la tabla `helios_tenants`, refrescada de fondo cada minuto.
 *   SI FALLA   se conserva lo ultimo bueno en memoria. La tabla puede caerse sin que
 *              deje de entrar un solo mensaje.
 *
 * La LECTURA sigue siendo sincrona; lo que se fue al fondo es el REFRESCO.
 */

let cachedRaw = null;
let cachedByAccount = new Map();

/** "entorno" o "tabla". Pasa a "tabla" la primera vez que la tabla trae clinicas. */
let fuente = "entorno";
let ultimoRefrescoOk = null;
let ultimoFalloDeRefresco = null;

class TenantContextError extends Error {
  constructor(code, message, accountId = null) {
    super(message);
    this.name = "TenantContextError";
    this.code = code;
    this.account_id = accountId;
  }
}

function requiredString(value, field, accountId) {
  const normalized = String(value ?? "").trim();
  if (!normalized) {
    throw new TenantContextError(
      "TENANT_CONTEXT_INVALID",
      `Tenant context ${accountId} is missing ${field}`,
      accountId
    );
  }
  return normalized;
}

/** Para mirar desde fuera que mapa esta vivo sin tener que deducirlo. */
function estadoDelMapa() {
  // El mapa del entorno se carga perezosamente, en la primera lectura de verdad. Sin
  // esto, /health diria «0 clinicas» en un sistema sano mientras no llegara un mensaje, y
  // un cero ahi es justo la señal engañosa que este campo venia a evitar.
  if (cachedByAccount.size === 0 && fuente === "entorno") {
    try { loadTenantContexts(); } catch (_) { /* sin mapa; el recuento lo dice */ }
  }
  return {
    fuente,
    clinicas: cachedByAccount.size,
    ultimo_refresco_ok: ultimoRefrescoOk ? new Date(ultimoRefrescoOk).toISOString() : null,
    ultimo_fallo: ultimoFalloDeRefresco
  };
}

// ---------------------------------------------------------------------------
// LA FUENTE VIEJA: LA VARIABLE DE ENTORNO
// ---------------------------------------------------------------------------
//
// Intacta, con una sola linea nueva: si la tabla ya manda, aqui no se hace nada. Sin ese
// cortocircuito la variable pisaria el mapa bueno en cada lectura.

function loadTenantContexts() {
  if (fuente === "tabla") return;

  const raw = String(process.env.CHATWOOT_TENANT_CONTEXTS_JSON ?? "").trim();
  if (raw === cachedRaw) return;
  if (!raw) {
    throw new TenantContextError(
      "TENANT_CONTEXT_INVALID",
      "CHATWOOT_TENANT_CONTEXTS_JSON is not configured"
    );
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (_) {
    throw new TenantContextError(
      "TENANT_CONTEXT_INVALID",
      "CHATWOOT_TENANT_CONTEXTS_JSON is not valid JSON"
    );
  }

  const entries = Array.isArray(parsed)
    ? parsed.map((item) => [String(item?.account_id ?? ""), item])
    : Object.entries(parsed);
  const byAccount = new Map();
  const tenantIds = new Set();

  for (const [key, value] of entries) {
    const accountId = requiredString(value?.account_id ?? key, "account_id", key);
    const context = Object.freeze({
      account_id: accountId,
      tenant_id: requiredString(value?.tenant_id, "tenant_id", accountId),
      clinic_id: requiredString(value?.clinic_id, "clinic_id", accountId),
      hermes_profile: requiredString(value?.hermes_profile, "hermes_profile", accountId)
    });

    if (byAccount.has(accountId) || tenantIds.has(context.tenant_id)) {
      throw new TenantContextError(
        "TENANT_CONTEXT_INVALID",
        "Duplicate account_id or tenant_id in tenant context map",
        accountId
      );
    }
    byAccount.set(accountId, context);
    tenantIds.add(context.tenant_id);
  }

  cachedRaw = raw;
  cachedByAccount = byAccount;
}

// ---------------------------------------------------------------------------
// LA FUENTE NUEVA: LA TABLA
// ---------------------------------------------------------------------------

let clienteDePruebas = null;

/** Solo para pruebas: pone una base falsa en lugar de la de verdad. */
function __setSupabaseClientForTests(cliente) {
  clienteDePruebas = cliente;
}

function clienteDeSupabase() {
  if (clienteDePruebas) return clienteDePruebas;
  const url = process.env.SUPABASE_URL || "";
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
  if (!url || !key) return null;
  // Se pide aqui dentro y no arriba: asi el fichero se puede cargar -y probar- sin que
  // haya una base de datos configurada, que es como estaba hasta hoy.
  const { createClient } = require("@supabase/supabase-js");
  return createClient(url, key);
}

/**
 * Lee el mapa de la tabla y lo sustituye en memoria si vino bien.
 *
 * NO LANZA NUNCA: se llama desde un temporizador, sin nadie esperandola. Las mismas tres
 * reglas que en el Gateway, y por el mismo motivo -que la alternativa es dejar clinicas
 * sin atender-:
 *
 *   1. Cero clinicas NO borra el mapa. Un DELETE de mas, una migracion a medias o unos
 *      permisos mal puestos devuelven cero igual que una tabla de verdad vacia.
 *   2. Una fila mala solo se lleva a SU clinica; las demas siguen.
 *   3. El mapa se cambia de golpe, no se va modificando el vivo.
 */
async function refrescarMapaDesdeTabla() {
  try {
    const supabase = clienteDeSupabase();
    if (!supabase) {
      ultimoFalloDeRefresco = "sin SUPABASE_URL o SUPABASE_SERVICE_ROLE_KEY";
      return;
    }

    const resultado = await supabase
      .from("helios_tenants")
      .select("tenant_id, account_id, clinic_id, hermes_profile, mapa_activo");

    if (resultado.error) {
      throw new Error(`MAPA_LECTURA_FALLIDA: ${resultado.error.message || resultado.error}`);
    }

    const byAccount = new Map();
    const tenantIds = new Set();
    const descartadas = [];

    for (const fila of resultado.data || []) {
      const tenantId = String(fila?.tenant_id ?? "").trim();
      const accountId = String(fila?.account_id ?? "").trim();

      // Sin account_id no es una clinica del mapa. Es normal, no un fallo.
      if (!accountId) continue;
      // Baja deliberada: deja de atenderse y sus datos siguen intactos.
      if (fila?.mapa_activo === false) continue;

      const clinicId = String(fila?.clinic_id ?? "").trim();
      const perfil = String(fila?.hermes_profile ?? "").trim();

      if (!tenantId || !clinicId || !perfil) {
        descartadas.push({
          tenant_id: tenantId || "(sin tenant_id)",
          motivo: !tenantId ? "sin tenant_id" : !clinicId ? "sin clinic_id" : "sin hermes_profile"
        });
        continue;
      }

      // Ante un duplicado se descarta la SEGUNDA en vez de pisar la primera: no atender
      // es mejor que atender a la clinica equivocada.
      if (byAccount.has(accountId) || tenantIds.has(tenantId)) {
        descartadas.push({ tenant_id: tenantId, motivo: "duplicada en la tabla" });
        continue;
      }

      byAccount.set(accountId, Object.freeze({
        account_id: accountId,
        tenant_id: tenantId,
        clinic_id: clinicId,
        hermes_profile: perfil
      }));
      tenantIds.add(tenantId);
    }

    if (descartadas.length > 0) {
      console.warn(JSON.stringify({
        event: "mapa_filas_descartadas",
        descartadas,
        atendidas: byAccount.size
      }));
    }

    if (byAccount.size === 0) {
      ultimoFalloDeRefresco = "la tabla no devolvio ninguna clinica";
      console.warn(JSON.stringify({
        event: "mapa_sin_clinicas",
        fuente_en_uso: fuente,
        clinicas_en_memoria: cachedByAccount.size
      }));
      return;
    }

    const primeraVez = fuente !== "tabla";
    cachedByAccount = byAccount;
    fuente = "tabla";
    ultimoRefrescoOk = Date.now();
    ultimoFalloDeRefresco = null;

    if (primeraVez) {
      console.log(JSON.stringify({
        event: "mapa_desde_tabla",
        clinicas: byAccount.size,
        nota: "la variable de entorno deja de usarse"
      }));
    }
  } catch (error) {
    ultimoFalloDeRefresco = String(error?.message ?? error);
    console.warn(JSON.stringify({
      event: "mapa_refresco_fallido",
      motivo: ultimoFalloDeRefresco,
      fuente_en_uso: fuente,
      clinicas_en_memoria: cachedByAccount.size
    }));
  }
}

let temporizador = null;

/** Refresca YA y luego cada minuto. Se llama una vez al levantar el Adapter. */
function arrancarRefrescoDelMapa(intervaloMs = 60000) {
  if (temporizador) return;
  void refrescarMapaDesdeTabla();
  temporizador = setInterval(() => { void refrescarMapaDesdeTabla(); }, intervaloMs);
  if (typeof temporizador.unref === "function") temporizador.unref();
}

function pararRefrescoDelMapa() {
  if (temporizador) clearInterval(temporizador);
  temporizador = null;
}

/** Devuelve el modulo a su estado de arranque. Solo para pruebas. */
function reiniciarMapaParaPruebas() {
  pararRefrescoDelMapa();
  clienteDePruebas = null;
  cachedRaw = null;
  cachedByAccount = new Map();
  fuente = "entorno";
  ultimoRefrescoOk = null;
  ultimoFalloDeRefresco = null;
}

// ---------------------------------------------------------------------------
// LA LECTURA — SINCRONA, DESDE MEMORIA
// ---------------------------------------------------------------------------

function resolveTenantContext(accountId) {
  loadTenantContexts();
  const normalizedAccountId = String(accountId ?? "").trim();
  const context = cachedByAccount.get(normalizedAccountId);
  if (!context) {
    throw new TenantContextError(
      "TENANT_NOT_CONFIGURED",
      "Chatwoot account is not configured",
      normalizedAccountId || null
    );
  }
  return context;
}

function validateTenantContext(input) {
  const context = resolveTenantContext(input?.account_id);
  const matches =
    String(input?.tenant_id ?? "").trim() === context.tenant_id &&
    String(input?.clinic_id ?? "").trim() === context.clinic_id &&
    String(input?.hermes_profile ?? "").trim() === context.hermes_profile;

  if (!matches) {
    throw new TenantContextError(
      "TENANT_CONTEXT_MISMATCH",
      "Received tenant context does not match configured Chatwoot account",
      context.account_id
    );
  }
  return context;
}

module.exports = {
  TenantContextError,
  resolveTenantContext,
  validateTenantContext,
  refrescarMapaDesdeTabla,
  arrancarRefrescoDelMapa,
  pararRefrescoDelMapa,
  reiniciarMapaParaPruebas,
  estadoDelMapa,
  __setSupabaseClientForTests
};
