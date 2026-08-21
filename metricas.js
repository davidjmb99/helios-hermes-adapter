/**
 * Cuánto se ha gastado y cuántos mensajes han pasado, por periodo.
 *
 * POR QUÉ ESTO ES UN MÓDULO APARTE Y NO UNA CONSULTA EN EL PANEL: aquí vive la parte
 * que puede estar mal en silencio. Sumar tokens es trivial; lo que no lo es es saber
 * CUÁNDO la suma se puede presentar como un hecho y cuándo hay que decir que es
 * incompleta. Un total con pinta de exacto que en realidad se ha dejado fuera la mitad
 * de los turnos es peor que no tener panel: se usa para decidir.
 *
 * LA REGLA, la misma que en cache-delta.js: si no se puede calcular exacto, se dice.
 * El coste se suma solo de los turnos que se pudieron valorar, y se informa aparte de
 * cuántos quedaron fuera y por qué. Nunca se rellena un hueco con una estimación.
 *
 * SOBRE «MENSAJES QUE LLEGAN Y QUE SALEN», que es como lo pidió David: lo que hay en
 * helios_adapter_events es un TURNO por fila, no un mensaje. El Gateway agrupa los
 * mensajes seguidos de un paciente en un solo turno —si escribe tres frases en veinte
 * segundos, es un turno— así que «entrantes» son turnos atendidos y no mensajes de
 * WhatsApp. Se llama por su nombre en el panel para que nadie lea otra cosa.
 */

"use strict";

const { calcularCoste, modeloConTarifa } = require("./pricing");

/**
 * Los periodos que ofrece el panel, en días hacia atrás desde ahora.
 *
 * Se cuentan hacia atrás desde el instante actual y NO por semanas o meses naturales.
 * Es deliberado: «el último mes» responde a «cuánto llevo gastado» mejor que «agosto»,
 * que el día 2 solo tiene dos días dentro y asusta o tranquiliza sin motivo.
 */
const PERIODOS = {
  dia: { dias: 1, etiqueta: "Último día" },
  semana: { dias: 7, etiqueta: "Última semana" },
  mes: { dias: 30, etiqueta: "Último mes" },
  "3meses": { dias: 90, etiqueta: "Últimos 3 meses" },
  "6meses": { dias: 180, etiqueta: "Últimos 6 meses" },
  ano: { dias: 365, etiqueta: "Último año" }
};

function esPeriodoValido(nombre) {
  return Object.prototype.hasOwnProperty.call(PERIODOS, String(nombre));
}

/** El instante desde el que hay que mirar, dado un periodo y un «ahora». */
function inicioDelPeriodo(nombre, ahora) {
  const def = PERIODOS[String(nombre)];
  if (!def) return null;
  const base = ahora instanceof Date ? ahora.getTime() : Number(ahora);
  return new Date(base - def.dias * 24 * 60 * 60 * 1000);
}

const numero = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

/**
 * Resume una lista de eventos del Adapter.
 *
 * @param eventos Filas de helios_adapter_events con al menos created_at, status,
 *   safe_to_send, input_tokens, output_tokens, cache_read_tokens y model.
 * @param modeloDeRespaldo Modelo a usar cuando la fila no lo guardó. Sale de la
 *   variable HELIOS_BILLING_MODEL; sin él, esos turnos quedan sin valorar.
 */
function resumirEventos(eventos, modeloDeRespaldo = null) {
  const filas = Array.isArray(eventos) ? eventos : [];

  const resumen = {
    turnos: filas.length,

    // MENSAJES. «Entrantes» son turnos recibidos; «salientes», respuestas que de
    // verdad salieron hacia el paciente. No son el mismo número y no deberían serlo:
    // la diferencia son los fallos y los duplicados frenados, y ver ese hueco es
    // justamente para lo que sirve tenerlos separados.
    entrantes: 0,
    salientes: 0,
    fallidos: 0,
    deduplicados: 0,

    input_tokens: 0,
    output_tokens: 0,
    cached_tokens: 0,
    total_tokens: 0,

    coste_usd: 0,
    /** Turnos cuyo coste sí se pudo calcular exacto. */
    turnos_valorados: 0,
    /** Turnos que no se pudieron valorar, con el motivo agrupado. */
    turnos_sin_valorar: 0,
    motivos_sin_valorar: {},

    /** true solo si TODOS los turnos con tokens se pudieron valorar. */
    coste_completo: true,
    acierto_cache_pct: null
  };

  for (const ev of filas) {
    resumen.entrantes += 1;

    const estado = String(ev?.status ?? "");
    if (estado === "deduplicated") resumen.deduplicados += 1;
    else if (estado.startsWith("failed")) resumen.fallidos += 1;

    // SALIENTE ES QUE LE LLEGÓ ALGO AL PACIENTE. No basta con `completed`: un turno
    // puede completarse y no enviarse -contrato inválido, respuesta reciclada-, y
    // contar eso como mensaje saliente pintaría un sistema más sano de lo que es.
    if (estado === "completed" && ev?.safe_to_send === true) resumen.salientes += 1;

    const entrada = numero(ev?.input_tokens);
    const salida = numero(ev?.output_tokens);
    const cacheados = numero(ev?.cache_read_tokens);

    resumen.input_tokens += entrada;
    resumen.output_tokens += salida;
    resumen.cached_tokens += cacheados;
    resumen.total_tokens += entrada + salida;

    // Un turno sin tokens -un duplicado frenado, un fallo antes de llamar- no cuesta
    // nada y no se cuenta como «sin valorar»: valorarlo daría cero de todas formas.
    if (entrada === 0 && salida === 0) continue;

    const modelo = modeloConTarifa(ev?.model) || modeloConTarifa(modeloDeRespaldo) || null;
    const coste = calcularCoste({
      model: modelo,
      at: ev?.created_at,
      input_tokens: entrada,
      output_tokens: salida,
      cached_tokens: Number.isFinite(Number(ev?.cache_read_tokens)) ? cacheados : null
    });

    if (coste && coste.exact === true && Number.isFinite(coste.usd)) {
      resumen.coste_usd += coste.usd;
      resumen.turnos_valorados += 1;
    } else {
      resumen.turnos_sin_valorar += 1;
      resumen.coste_completo = false;
      const motivo = String(coste?.motivo || "desconocido");
      resumen.motivos_sin_valorar[motivo] = (resumen.motivos_sin_valorar[motivo] || 0) + 1;
    }
  }

  // El acierto de caché explica el coste mejor que ninguna otra cifra: con el 97% que
  // tiene Helios, la entrada cuesta cincuenta veces menos que sin ella. Si baja, el
  // gasto se dispara sin que cambie nada del uso, y hay que poder verlo.
  if (resumen.input_tokens > 0) {
    resumen.acierto_cache_pct = Math.round((resumen.cached_tokens / resumen.input_tokens) * 10000) / 100;
  }

  // Redondeo al céntimo de millonésima: los costes por turno están en el orden de
  // 0,0006 USD y redondear antes escondería el total de un día entero.
  resumen.coste_usd = Math.round(resumen.coste_usd * 1e6) / 1e6;

  // El coste por mensaje enviado es la cifra que de verdad se usa para decidir: dice
  // cuánto cuesta atender a un paciente, no cuánto cuesta un turno técnico.
  resumen.coste_por_saliente = resumen.salientes > 0
    ? Math.round((resumen.coste_usd / resumen.salientes) * 1e6) / 1e6
    : null;

  return resumen;
}

module.exports = { PERIODOS, esPeriodoValido, inicioDelPeriodo, resumirEventos };
