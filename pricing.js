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
  },

  /**
   * GEMINI, que es quien convierte los archivos en texto. Vive en el Gateway y no en
   * Hermes, pero el precio se calcula aquí para que haya UN solo catálogo: dos sitios
   * con tarifas es la forma segura de que uno se quede viejo.
   *
   * LA ENTRADA DE AUDIO CUESTA EL TRIPLE que el texto, la imagen o el vídeo, y esa es la
   * única razón por la que existe `por_modalidad`. Sin ese desglose, una nota de voz se
   * valoraría a precio de texto y el coste real sería tres veces el que dice el panel.
   *
   * Y SOBRE LA CACHÉ: no usamos la caché de contexto de Gemini. Cada archivo es una
   * llamada independiente, así que quien pida el coste pasa `cached_tokens: 0` y sale
   * exacto. `cache_hit` se deja igual a `cache_miss` a propósito: si algún día se activa
   * la caché y nadie actualiza esto, el número saldrá ALTO, que es el lado en el que uno
   * quiere equivocarse al estimar un gasto.
   */
  gemini: {
    "gemini-2.5-flash-lite": [
      {
        desde: "1970-01-01T00:00:00Z",
        cache_hit: 0.10,
        cache_miss: 0.10,
        output: 0.40,
        por_modalidad: {
          // 32 tokens por segundo de audio, a 0,30 el millón: una nota de voz de 30
          // segundos son 960 tokens, unos 0,00029 USD.
          audio: { cache_hit: 0.30, cache_miss: 0.30 }
        }
      }
    ],
    "gemini-2.5-flash": [
      {
        desde: "1970-01-01T00:00:00Z",
        cache_hit: 0.30,
        cache_miss: 0.30,
        output: 2.50,
        por_modalidad: { audio: { cache_hit: 1.00, cache_miss: 1.00 } }
      }
    ],

    /**
     * GEMINI 3.5 FLASH-LITE: el que se usa desde el 24 de agosto de 2026.
     *
     * POR QUE SE CAMBIO. `gemini-2.5-flash-lite` sigue en la lista de modelos y sigue en la
     * pagina de precios, pero Google lo cerro a claves nuevas. Su respuesta, literal: «This
     * model models/gemini-2.5-flash-lite is no longer available to new users. Please update
     * your code to use models/gemini-3.5-flash-lite». Un 404, con la clave y el nombre
     * perfectamente correctos.
     *
     * OJO A LA DIFERENCIA QUE IMPORTA: AQUI EL AUDIO NO TIENE TARIFA PROPIA. En 2.5 el audio
     * costaba el triple que el texto -0,30 frente a 0,10-; en 3.5 todo entra al mismo precio,
     * 0,30. Asi que NO lleva `por_modalidad`, y copiarlo del modelo anterior habria hecho que
     * las notas de voz se valoraran a 0,90.
     *
     * Lo que si sube es la SALIDA: de 0,40 a 2,50, seis veces. Para transcribir da casi
     * igual -la salida de una nota de voz son veinte tokens- pero para clasificar imagenes
     * y videos multiplica el coste por tres. Sigue siendo calderilla: una nota de voz de
     * treinta segundos pasa de 0,000296 a 0,000338 USD.
     */
    "gemini-3.5-flash-lite": [
      {
        desde: "1970-01-01T00:00:00Z",
        cache_hit: 0.30,
        cache_miss: 0.30,
        output: 2.50
        // SIN por_modalidad A PROPOSITO: el audio va al mismo precio que el resto.
      }
    ],

    /**
     * GEMINI 3.1 FLASH-LITE. No se usa, pero esta en el catalogo para poder cambiar de
     * modelo con una variable de entorno y sin tocar codigo.
     *
     * Y PARA QUE CONSTE POR QUE NO SE ELIGIO: su audio cuesta 0,50 frente a los 0,30 de
     * 3.5. Para lo que hace Helios -sobre todo transcribir notas de voz- sale MAS CARO que
     * el modelo mas nuevo, aunque su salida sea mas barata.
     */
    "gemini-3.1-flash-lite": [
      {
        desde: "1970-01-01T00:00:00Z",
        cache_hit: 0.25,
        cache_miss: 0.25,
        output: 1.50,
        por_modalidad: { audio: { cache_hit: 0.50, cache_miss: 0.50 } }
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

/**
 * La tarifa que toca, resolviendo la hora pico y la modalidad.
 *
 * LA MODALIDAD SOLO PISA LA ENTRADA, nunca la salida: lo que cambia de precio es leer
 * un audio, no escribir texto. Y solo pisa si el tramo declara esa modalidad, así que
 * los modelos sin desglose -DeepSeek- se comportan exactamente igual que antes.
 */
function tarifaAplicable(tramo, fecha, modalidad = null) {
  const base = esHoraPico(tramo, fecha)
    ? {
      cache_hit: tramo.pico.cache_hit,
      cache_miss: tramo.pico.cache_miss,
      output: tramo.pico.output,
      franja: "pico"
    }
    : {
      cache_hit: tramo.cache_hit,
      cache_miss: tramo.cache_miss,
      output: tramo.output,
      franja: tramo.pico ? "valle" : "unica"
    };

  const clave = String(modalidad || "").trim().toLowerCase();
  const especial = clave && tramo.por_modalidad ? tramo.por_modalidad[clave] : null;
  if (!especial) return { ...base, modalidad: clave || null };

  return {
    ...base,
    cache_hit: especial.cache_hit,
    cache_miss: especial.cache_miss,
    modalidad: clave
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
    cached_tokens = null,
    /**
     * Qué se está leyendo: 'audio', 'imagen', 'video', 'documento'. Solo importa en los
     * modelos cuya entrada cambia de precio según el tipo -Gemini-. Se ignora en el
     * resto.
     */
    modalidad = null
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
  const tarifa = tarifaAplicable(tramo, at, modalidad);

  const costeSalida = (salida * tarifa.output) / POR_MILLON;
  const comun = {
    provider: encontrado.provider,
    model: encontrado.model,
    franja: tarifa.franja,
    modalidad: tarifa.modalidad,
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

/**
 * Elige el primer candidato que EXISTA en el catálogo de precios.
 *
 * No basta con `guardado || respaldo`: durante meses se guardó el nombre del
 * PERFIL en el campo del modelo, así que las filas antiguas traen «helios», que
 * no está vacío y por tanto ganaba al respaldo. El resultado era «sin tarifa
 * conocida» en todo el historial. Preguntando al catálogo se resuelven también
 * esas filas, y cualquier otro valor basura que se haya colado.
 */
function modeloConTarifa(...candidatos) {
  for (const candidato of candidatos) {
    if (candidato && buscarTramos(null, candidato)) return String(candidato);
  }
  return null;
}

/** Formato corto para la interfaz: seis decimales bastan a estos precios. */
function formatearUsd(valor) {
  if (!Number.isFinite(valor)) return "N/A";
  if (valor === 0) return "$0";
  if (valor < 0.01) return "$" + valor.toFixed(6);
  return "$" + valor.toFixed(4);
}

/**
 * Formato de SEIS decimales, siempre, para las cifras del panel de gasto.
 *
 * POR QUE NO VALE `formatearUsd` AQUI. Ese usa cuatro decimales por encima de un centavo,
 * y el total del periodo suma dos cosas de magnitudes muy distintas: el texto de DeepSeek
 * ronda los 0,02 y los archivos de Gemini los 0,00008. A cuatro decimales los archivos
 * DESAPARECEN, y el resultado es un panel con la tarjeta del total y la del texto marcando
 * exactamente lo mismo: parece que el gasto de Gemini no se esta contando.
 *
 * Lo pregunto David el 24 de agosto: «¿cuanto es el costo total sumando lo de deepseek y
 * lo de gemini?». Si hay que preguntarlo mirando el panel, el panel esta mal.
 */
function formatearUsdFino(valor) {
  if (!Number.isFinite(valor)) return "N/A";
  if (valor === 0) return "$0";
  return "$" + valor.toFixed(6);
}

module.exports = {
  CATALOGO,
  formatearUsdFino,
  calcularCoste,
  modeloConTarifa,
  formatearUsd,
  normalizarModelo,
  buscarTramos,
  elegirTramo,
  esHoraPico,
  tarifaAplicable
};
