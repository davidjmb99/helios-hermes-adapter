"use strict";

/**
 * El clic en una traza del panel abre su detalle.
 *
 * EL FALLO QUE MOTIVA ESTA PRUEBA. `fmtUsd` estaba declarada con const DENTRO de
 * renderList, y openEventDetail también la llamaba. Otro ámbito: ReferenceError en
 * CADA clic. Y como el cajón se abre en la ÚLTIMA línea de openEventDetail, después
 * de construir todo el HTML, no se abría nada y no había ningún síntoma: ni error
 * visible, ni fila roja, ni log. Solo un clic que no hacía nada.
 *
 * POR QUÉ NO LO CAZÓ NADA. La comprobación de sintaxis valida server.js, pero este
 * script viaja DENTRO de una plantilla de texto que se sirve al navegador: para el
 * validador es una cadena, no código. Estuvo roto desde que se añadió el coste al
 * panel.
 *
 * CÓMO SE PRUEBA. Se extrae el script del navegador del propio fichero, se ejecuta
 * en Node con un DOM mínimo, y se hace el clic. Si alguna función del detalle no
 * resuelve, esto falla. No sustituye a abrir el navegador, pero sí caza la familia
 * entera de «una función no existe en este ámbito».
 */

const assert = require("assert");
const fs = require("fs");

const fuente = fs.readFileSync(require.resolve("./server.js"), "utf8");

// --- Se localiza el script del navegador, sin números de línea a mano --------
// Hardcodear las líneas hacía que la prueba se rompiera al añadir código encima.

const bloques = [...fuente.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);
assert.ok(bloques.length >= 1, "no se encontró ningún <script> en el panel");

const cuerpo = bloques.sort((a, b) => b.length - a.length)[0];
assert.ok(
  cuerpo.includes("function openEventDetail"),
  "el bloque más grande debería ser el del panel de trazas"
);

// --- DOM mínimo: solo lo que toca el detalle --------------------------------

const elementos = {};
const elemento = (id) => (elementos[id] = elementos[id] || {
  id, innerHTML: "", style: {}, dataset: {}, value: "", textContent: "",
  classList: { _c: new Set(), add(x) { this._c.add(x); }, remove(x) { this._c.delete(x); }, contains(x) { return this._c.has(x); } },
  addEventListener() {}
});

global.document = {
  getElementById: elemento,
  querySelector: () => null,
  querySelectorAll: () => [],
  addEventListener() {}
};
global.window = { location: { href: "" } };
global.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
global.fetch = async () => ({ ok: true, status: 200, headers: { get: () => null }, json: async () => ({ events: [] }) });
global.setInterval = () => 0;
global.clearInterval = () => {};
if (!global.navigator) {
  Object.defineProperty(global, "navigator", {
    value: { clipboard: { writeText: async () => {} } }, configurable: true
  });
}

/**
 * Una traza como las de producción: coste en RANGO -Hermes no reportó el desglose
 * de caché en ese turno- y el modelo resuelto por la variable de facturación, que
 * es justo la combinación que se ve hoy en el panel.
 */
const TRAZA = {
  id: 991, status: "completed",
  created_at: "2026-08-17T13:56:41.000Z", started_at: "2026-08-17T13:56:28.000Z",
  finished_at: "2026-08-17T13:56:41.000Z", completed_at: "2026-08-17T13:56:41.000Z",
  duration_ms: 13599, hermes_duration_ms: 13100,
  trace_id: "f51f4a8d-1111-2222-3333-444455556666", parent_trace_id: null,
  request_key: "helios-09708-f44f73",
  tenant_id: "democoi1", account_id: "2", clinic_id: "coi", hermes_profile: "helios",
  conversation_id: "45", contact_id: "14",
  patient_display_name: "David Perez", patient_first_name: "David", patient_last_name: "Perez",
  phone: "+584167474664",
  message_content: "perdi mi cita",
  response_content: "Lamento que haya perdido la cita. No se preocupe...",
  processing_stage: "completed", hermes_transport: "agent_api",
  hermes_conversation_id: "helios-a9ff99e9d09b", hermes_response_id: "resp_e433c40_ec8b15",
  idempotency_status: "new",
  input_tokens: 156677, output_tokens: 888, total_tokens: 157565,
  cache_read_tokens: null, cache_write_tokens: null,
  model: "helios",
  tool_names: ["mcp__calcom__get_available_slots"], tool_count: 3,
  attempt_count: 1, safe_to_send: true, http_status: 200, error_code: null,
  billing_model: "deepseek-v4-flash", billing_model_source: "variable", model_guardado: "helios",
  cost: {
    provider: "deepseek", model: "deepseek-v4-flash", franja: "valle",
    tarifa_desde: "2026-08-16T00:00:00Z",
    input_tokens: 156677, output_tokens: 888, coste_salida_usd: 0.00058608,
    exact: false, motivo: "sin_desglose_de_cache",
    cached_tokens: null, usd: null, usd_min: 0.001683, usd_max: 0.0351
  }
};

const api = new Function(`
  ${cuerpo}
  return { openEventDetail, rawEventsList, renderList, fmtUsd, agruparPorConversacion, alternarConversacion };
`)();

// --- El clic ----------------------------------------------------------------

api.rawEventsList.push(TRAZA);
api.openEventDetail(991);

const cajon = elementos["drawer-body-area"];
assert.ok(cajon.innerHTML.length > 500, "el cajón de detalle tiene que llenarse");

// Y tiene que ABRIRSE. Es la última línea de la función: si algo lanza antes, el
// cuerpo puede estar a medias y el cajón cerrado, que era el síntoma exacto.
assert.ok(elementos["drawer"].classList.contains("open"), "el cajón tiene que quedar abierto");
assert.ok(elementos["drawer-overlay"].classList.contains("open"), "y el fondo también");

// --- Lo que el detalle debe decir -------------------------------------------

const html = cajon.innerHTML;
assert.ok(html.includes("deepseek-v4-flash"), "muestra el modelo con el que se cobra");
assert.ok(html.includes("por variable"), "y avisa de que la tarifa sale del respaldo");
assert.ok(html.includes("helios"), "y enseña lo que hay guardado en la fila");
assert.ok(/\$0\.001683/.test(html), "muestra el mínimo del rango de coste");
assert.ok(/\$0\.0351/.test(html), "y el máximo");
assert.ok(html.includes("156,677") || html.includes("156.677"), "y los tokens de entrada");

// --- El otro camino: coste exacto -------------------------------------------
// Con el desglose de caché, el coste es un número y no un rango. Es el caso al que
// se llega en cuanto Hermes reporte cache_read_tokens.

api.rawEventsList.push({
  ...TRAZA, id: 992, cache_read_tokens: 154000,
  billing_model_source: "fila", model: "deepseek-v4-flash", model_guardado: "deepseek-v4-flash",
  cost: { ...TRAZA.cost, exact: true, motivo: undefined, cached_tokens: 154000, usd: 0.001147 }
});
api.openEventDetail(992);
const exacto = elementos["drawer-body-area"].innerHTML;
assert.ok(/\$0\.001147/.test(exacto), "con desglose de caché se muestra el coste exacto");
assert.ok(!exacto.includes("por variable"), "y no se dice «por variable» cuando el modelo venía en la fila");

// --- Y una traza pelada, sin nada opcional ----------------------------------
// Las filas antiguas no tienen coste, ni modelo, ni herramientas. El detalle tiene
// que abrirse igual: si no, el historial viejo queda inaccesible.

api.rawEventsList.push({ id: 993, status: "error", created_at: "2026-07-01T10:00:00.000Z", error_code: "HERMES_TIMEOUT" });
api.openEventDetail(993);
assert.ok(
  elementos["drawer-body-area"].innerHTML.includes("HERMES_TIMEOUT"),
  "una traza sin campos opcionales también abre su detalle"
);

// =============================================================================
// AGRUPACION POR CONVERSACION
// =============================================================================
//
// El 17 de agosto la prueba de carga lleno el panel con cincuenta filas que en
// realidad eran reintentos de un punado de mensajes. Imposible seguirlo mientras
// entraban. Ahora se agrupa por conversacion y los reintentos se pliegan.

function eventoDe(conv, id, requestKey, extra) {
  return Object.assign({}, TRAZA, {
    id, conversation_id: conv, request_key: requestKey,
    patient_display_name: "Paciente " + conv, phone: "+3460000000" + conv
  }, extra || {});
}

// Tres conversaciones. La 55 con la MISMA peticion reintentada veinte veces, que
// es exactamente lo que paso en la prueba.
const muchos = [];
for (let i = 0; i < 20; i++) {
  muchos.push(eventoDe("55", 1000 + i, "req-55", {
    idempotency_status: "deduplicated", error_code: "OUTPUT_CONTRACT_VIOLATION"
  }));
}
muchos.push(eventoDe("68", 2000, "req-68", { idempotency_status: "new", error_code: null }));
muchos.push(eventoDe("68", 2001, "req-68-b", { idempotency_status: "new", error_code: null }));
muchos.push(eventoDe("64", 3000, "req-64", { idempotency_status: "new", error_code: "HERMES_TIMEOUT" }));

// alternarConversacion repinta desde rawEventsList, que es lo que hace el panel
// de verdad: se cargan ahi para que el despliegue funcione como en produccion.
api.rawEventsList.length = 0;
muchos.forEach(e => api.rawEventsList.push(e));

api.renderList(muchos);
const lista = elementos["requests-container"].innerHTML;

const cabeceras = (lista.match(/data-conv=/g) || []).length;
assert.equal(cabeceras, 3, "veintitres eventos se ven como TRES conversaciones, no veintitres filas");

assert.ok(lista.includes("Conversacion 55"), "y cada una dice cual es");
assert.ok(lista.includes("20 reintento"), "los veinte reintentos se resumen en la cabecera: " + lista.slice(0, 200));
assert.ok(lista.includes("con error"), "y se dice cuantos fallaron");

// Cerradas por defecto: con muchas conversaciones a la vez, lo que se necesita es
// la lista corta, no todo el detalle abierto.
assert.ok(!lista.includes("Hermes Resp"), "las conversaciones empiezan plegadas");

// Al abrir una, aparecen sus mensajes, y los reintentos van en UNA linea.
api.alternarConversacion("55");
const abierta = elementos["requests-container"].innerHTML;
assert.ok(abierta.includes("Hermes Resp"), "al desplegar se ven los mensajes");
assert.ok(
  abierta.includes("+ 19 reintentos de esta misma peticion"),
  "y los diecinueve repetidos son una linea, no diecinueve tarjetas"
);
const tarjetasDentro = (abierta.match(/class="request-card [^"]*status/g) || []).length;
assert.ok(tarjetasDentro <= 2, "como mucho una tarjeta por peticion distinta, no una por reintento");

console.log("test_panel_drawer: PASS");
console.log("  script del navegador: " + cuerpo.split("\n").length + " lineas ejecutadas");
