"use strict";

/**
 * Catálogo de precios y cálculo del coste por mensaje.
 *
 * AGNÓSTICO DE PROVEEDOR a propósito. Hoy es DeepSeek, mañana puede ser OpenAI u
 * otro: el catálogo es una tabla de datos y el cálculo no sabe de quién es cada
 * modelo. Añadir un proveedor es añadir filas, no tocar lógica.
 *
 * TRES COSAS QUE HACEN QUE ESTO NO SEA UNA SIMPLE MULTIPLICACIÓN:
 *
 *  1. LA CACHÉ. Los tokens de entrada que el proveedor sirve desde caché cuestan
 *     una fracción. En Helios el acierto de caché ronda el 97-98%, así que
 *     ignorarlo multiplica el coste calculado por cincuenta. Si no se conoce el
 *     reparto, se devuelve un RANGO honesto en vez de un número inventado.
 *
 *  2. LOS TRAMOS DE FECHA. DeepSeek sube precios el 16 de agosto de 2026. Un
 *     mensaje de ayer no cuesta lo que costaría hoy, así que el precio se elige
 *     por la fecha del mensaje y no por la de hoy.
 *
 *  3. HORARIO PICO. A partir del 16 hay tarifa distinta según la hora UTC. Se
 *     resuelve con la hora real del mensaje.
 */

/**
 * Tramos de precio en USD por millón de tokens.
 *
 * `desde` es inclusivo y en UTC. Los tramos de cada modelo van de más antiguo a
 * más reciente; se elige el último cuyo `desde` sea menor o igual a la fecha.
 *
 * `pico` es opcional: si existe, define las franjas horarias UTC con tarifa alta.
 */
const CATALOGO = {
  deepseek: {
    "deepseek-v4-flash": [
      {
        desde: "1970-01-01T00:00:00Z",
        cache_hit: 0.0028,
        cache_miss: 0.14,
        output: 0.28
      },
      {
        desde: "2026-08-16T00:00:00Z",
        cache_hit: 0.007,
        cache_miss: 0.22,
        output: 0.66,
        pico: {
          // Horas UTC en las que se aplica la tarifa alta.
          franjas: [[1, 4], [6, 10]],
          cache_hit: 0.014,
          cache_miss: 0.44,
          output: 1.32
        }
      }
    ],
    "deepseek-v4-pro": [
      {
        desde: "1970-01-01T00:00:00Z",
        cache_hit: 0.003625,
        cache_miss: 0.435,
        output: 0.87
      },
      {
        desde: "2026-08-16T00:00:00Z",
        cache_hit: 0.022,
        cache_miss: 0.66,
        output: 1.98,
        pico: {
          franjas: [[1, 4], [6, 10]],
          cache_hit: 0.044,
          cache_miss: 1.32,
          output: 3.96
        }
      }
    ]
  }
  // openai: { "gpt-...": [...] }  <- añadir aquí cuando toque, sin tocar lógica.
};

/** Alias frecuentes hacia el nombre canónico del catálogo. */
const ALIAS = {
  "deepseek-v4flash": "deepseek-v4-flash",
  "deepseek v4 flash": "deepseek-v4-flash",
  "deepseek-v4-flash-latest": "deepseek-v4-flash",
  "v4-flash": "deepseek-v4-flash",
  "deepseek-v4pro": "deepseek-v4-pro",
  "v4-pro": "deepseek-v4-pro"
};

function normalizarModelo(model) {
  const limpio = String(model || "").trim().toLowerCase();
  if (!limpio) return null;
  return ALIAS[limpio] || limpio;
}

/** Busca el modelo en todos los proveedores si no se indica cuál. */
function buscarTramos(provider, model) {
  const modelo = normalizarModelo(model);
  if (!modelo) return null;
  const prov = String(provider || "").trim().toLowerCase();
  if (prov && CATALOGO[prov] && CATALOGO[prov][modelo]) {
    return { provider: prov, model: modelo, tramos: CATALOGO[prov][modelo] };
  }
  for (const [nombreProv, modelos] of Object.entries(CATALOGO)) {
    if (modelos[modelo]) return { provider: nombreProv, model: modelo, tramos: modelos[modelo] };
  }
  return null;
}

function elegirTramo(tramos, fecha) {
  const t = fecha instanceof Date ? fecha.getTime() : new Date(fecha || Date.now()).getTime();
  if (!Number.isFinite(t)) return tramos[0];
  let elegido = null;
  for (const tramo of tramos) {
    if (new Date(tramo.desde).getTime() <= t) elegido = tramo;
  }
  return elegido || tramos[0];
}

function esHoraPico(tramo, fecha) {
  if (!tramo.pico) return false;
  const d = fecha instanceof Date ? fecha : new Date(fecha || Date.now());
  if (Number.isNaN(d.getTime())) return false;
  const hora = d.getUTCHours();
  return tramo.pico.franjas.some(([desde, hasta]) => hora >= desde && hora < hasta);
}

function tarifaAplicable(tramo, fecha) {
  if (esHoraPico(tramo, fecha)) {
    return {
      cache_hit: tramo.pico.cache_hit,
      cache_miss: tramo.pico.cache_miss,
      output: tramo.pico.output,
      franja: "pico"
    };
  }
  return {
    cache_hit: tramo.cache_hit,
    cache_miss: tramo.cache_miss,
    output: tramo.output,
    franja: tramo.pico ? "valle" : "unica"
  };
}

const POR_MILLON = 1e6;

/**
 * Coste de un mensaje.
 *
 * Devuelve `exact: true` solo cuando se conoce cuántos tokens de entrada vinieron
 * de caché. Si no se conoce, se devuelve un rango entre el mejor y el peor caso,
 * porque entre esos dos extremos hay un factor de cincuenta y dar un número
 * concreto sería inventárselo.
 */
function calcularCoste(input) {
  const {
    provider = null,
    model = null,
    at = new Date(),
    input_tokens = null,
    output_tokens = null,
    cached_tokens = null
  } = input || {};

  const encontrado = buscarTramos(provider, model);
  if (!encontrado) {
    return {
      exact: false,
      usd: null,
      motivo: "modelo_desconocido",
      modelo_consultado: model || null
    };
  }

  const entrada = Number.isFinite(input_tokens) ? input_tokens : 0;
  const salida = Number.isFinite(output_tokens) ? output_tokens : 0;
  const tramo = elegirTramo(encontrado.tramos, at);
  const tarifa = tarifaAplicable(tramo, at);

  const costeSalida = (salida * tarifa.output) / POR_MILLON;
  const comun = {
    provider: encontrado.provider,
    model: encontrado.model,
    franja: tarifa.franja,
    tarifa_desde: tramo.desde,
    input_tokens: entrada,
    output_tokens: salida,
    coste_salida_usd: costeSalida
  };

  if (Number.isFinite(cached_tokens) && cached_tokens >= 0) {
    const enCache = Math.min(cached_tokens, entrada);
    const nuevos = Math.max(0, entrada - enCache);
    const costeCache = (enCache * tarifa.cache_hit) / POR_MILLON;
    const costeNuevos = (nuevos * tarifa.cache_miss) / POR_MILLON;
    return {
      ...comun,
      exact: true,
      cached_tokens: enCache,
      uncached_tokens: nuevos,
      coste_entrada_usd: costeCache + costeNuevos,
      coste_cache_usd: costeCache,
      coste_nuevos_usd: costeNuevos,
      usd: costeCache + costeNuevos + costeSalida
    };
  }

  // Sin reparto de caché: se acota entre los dos extremos posibles.
  const minimo = (entrada * tarifa.cache_hit) / POR_MILLON + costeSalida;
  const maximo = (entrada * tarifa.cache_miss) / POR_MILLON + costeSalida;
  return {
    ...comun,
    exact: false,
    motivo: "sin_desglose_de_cache",
    cached_tokens: null,
    usd: null,
    usd_min: minimo,
    usd_max: maximo
  };
}

/** Formato corto para la interfaz: seis decimales bastan a estos precios. */
function formatearUsd(valor) {
  if (!Number.isFinite(valor)) return "N/A";
  if (valor === 0) return "$0";
  if (valor < 0.01) return "$" + valor.toFixed(6);
  return "$" + valor.toFixed(4);
}

module.exports = {
  CATALOGO,
  calcularCoste,
  formatearUsd,
  normalizarModelo,
  buscarTramos,
  elegirTramo,
  esHoraPico,
  tarifaAplicable
};
