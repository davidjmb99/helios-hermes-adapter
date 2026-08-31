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
    /** Turnos que repitieron un resultado guardado: existen, pero no gastaron. */
    reutilizados: 0,

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

    // UN RESULTADO REUTILIZADO NO GASTA TOKENS, Y SUS CIFRAS SON PRESTADAS.
    //
    // Cuando el gateway reintenta un turno, los mensajes de origen son los mismos y el
    // almacen durable devuelve lo que produjo el turno ORIGINAL, sin llamar a Hermes. Y con
    // ello COPIA sus contadores de tokens. Sumarlos aqui es contar dos veces algo que se
    // gasto una.
    //
    // NO ES TEORICO: la noche del 28-ago un turno se reintento dos veces y el panel apunto
    // 125.442 tokens de entrada por cada reintento —los mismos del original—, en llamadas
    // que duraron 221 y 261 milisegundos. Doscientos cincuenta mil tokens que nunca se
    // gastaron, en la cifra que se usa para decidir.
    //
    // SE CUENTAN COMO TURNO Y NO COMO GASTO. La fila existe, el reintento ocurrio y hay que
    // verlo; lo que no puede es sumar dinero.
    const reutilizado = String(ev?.idempotency_status ?? "") === "deduplicated";
    if (reutilizado) {
      resumen.reutilizados = (resumen.reutilizados || 0) + 1;
      continue;
    }

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

/**
 * Resume los archivos procesados: audio, imagen, video y documentos.
 *
 * VA APARTE DEL RESUMEN DE TURNOS, y no por comodidad. Un archivo NO ES UN TURNO: puede
 * haber gasto sin turno -una cadena reenviada que se ignora cuesta dinero y no genera
 * respuesta- y un turno puede llevar tres archivos. Sumarlos en el mismo contador diria
 * que hubo mas conversaciones de las que hubo, que es la clase de cifra que se usa para
 * decidir y esta mal.
 *
 * LA MODALIDAD DECIDE EL PRECIO. En Gemini la entrada de audio cuesta el TRIPLE que la
 * de texto, imagen o video. Valorar una nota de voz a precio de texto no es un redondeo:
 * es un tercio del coste real. Por eso el tipo viaja hasta `calcularCoste`.
 *
 * @param filas Filas de helios_media_events.
 */
function resumirMedia(filas) {
  const lista = Array.isArray(filas) ? filas : [];

  const resumen = {
    archivos: lista.length,

    por_tipo: { audio: 0, imagen: 0, video: 0, documento: 0 },

    // QUE SE HIZO CON CADA UNO. «ignorados» es el que hay que mirar: son mensajes de
    // pacientes que NO recibieron respuesta a proposito. Si ese numero crece sin motivo,
    // el clasificador se esta comiendo mensajes de verdad y aqui es donde se ve.
    seguidos: 0,
    derivados: 0,
    ignorados: 0,
    fallidos: 0,

    input_tokens: 0,
    output_tokens: 0,
    total_tokens: 0,

    coste_usd: 0,
    archivos_valorados: 0,
    archivos_sin_valorar: 0,
    motivos_sin_valorar: {},
    coste_completo: true,

    /**
     * Cuantos pasaron por el nivel gratuito de Gemini, donde Google usa el contenido para
     * mejorar sus productos. Se cuenta de las FILAS y no de una variable de entorno: la
     * pregunta es cuantos archivos de pacientes pasaron por ahi de verdad, y eso una
     * variable que pudo cambiar entre dos despliegues no lo contesta.
     */
    en_nivel_gratuito: 0
  };

  for (const fila of lista) {
    const tipo = String(fila?.tipo ?? "");
    if (Object.prototype.hasOwnProperty.call(resumen.por_tipo, tipo)) resumen.por_tipo[tipo] += 1;

    const accion = String(fila?.accion ?? "");
    if (accion === "derivar") resumen.derivados += 1;
    else if (accion === "ignorar") resumen.ignorados += 1;
    else if (accion === "sin_procesar") resumen.fallidos += 1;
    else if (accion === "seguir") resumen.seguidos += 1;

    if (String(fila?.nivel ?? "") === "gratuito") resumen.en_nivel_gratuito += 1;

    const entrada = numero(fila?.input_tokens);
    const salida = numero(fila?.output_tokens);
    resumen.input_tokens += entrada;
    resumen.output_tokens += salida;
    resumen.total_tokens += entrada + salida;

    // Un archivo rechazado antes de llamar -demasiado grande, formato no soportado- no
    // gasto nada. No cuenta como «sin valorar»: valorarlo daria cero igual.
    if (entrada === 0 && salida === 0) continue;

    const coste = calcularCoste({
      model: modeloConTarifa(fila?.modelo) || null,
      at: fila?.created_at,
      input_tokens: entrada,
      output_tokens: salida,
      // NO USAMOS LA CACHE DE CONTEXTO DE GEMINI: cada archivo es una llamada
      // independiente. Pasar 0 es la verdad, y ademas es lo que hace que el coste salga
      // exacto en vez de un rango inutil.
      cached_tokens: 0,
      modalidad: tipo === "audio" ? "audio" : null
    });

    if (coste && coste.exact === true && Number.isFinite(coste.usd)) {
      resumen.coste_usd += coste.usd;
      resumen.archivos_valorados += 1;
    } else {
      resumen.archivos_sin_valorar += 1;
      resumen.coste_completo = false;
      const motivo = String(coste?.motivo || "desconocido");
      resumen.motivos_sin_valorar[motivo] = (resumen.motivos_sin_valorar[motivo] || 0) + 1;
    }
  }

  resumen.coste_usd = Math.round(resumen.coste_usd * 1e6) / 1e6;
  return resumen;
}

module.exports = {
  PERIODOS, esPeriodoValido, inicioDelPeriodo, resumirEventos, resumirMedia
};
