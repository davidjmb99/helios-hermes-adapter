"use strict";

/**
 * Coste por mensaje.
 *
 * Lo que se protege: que la caché no se ignore (factor cincuenta), que un
 * mensaje se cobre con la tarifa de SU fecha y no la de hoy, y que cuando no se
 * conoce el reparto de caché se devuelva un rango en vez de un número inventado.
 */

const assert = require("assert");
const { calcularCoste, esHoraPico, elegirTramo, CATALOGO, formatearUsd } = require("./pricing.js");

const ANTES = "2026-08-13T18:08:06Z";   // antes de la subida
const DESPUES_VALLE = "2026-08-20T14:00:00Z"; // 14 UTC no es pico
const DESPUES_PICO = "2026-08-20T08:30:00Z";  // 08:30 UTC sí es pico

// --- El caso real de produccion ---------------------------------------------
// Turno del 13-08-2026: 99.015 de entrada (97.536 de cache), 2.383 de salida.

const real = calcularCoste({
  provider: "deepseek",
  model: "deepseek-v4-flash",
  at: ANTES,
  input_tokens: 99015,
  output_tokens: 2383,
  cached_tokens: 97536
});

assert.equal(real.exact, true, "con desglose de cache el coste es exacto");
assert.equal(real.cached_tokens, 97536);
assert.equal(real.uncached_tokens, 1479);

// 97.536 * 0,0028/1M + 1.479 * 0,14/1M + 2.383 * 0,28/1M
const esperado = (97536 * 0.0028 + 1479 * 0.14 + 2383 * 0.28) / 1e6;
assert.ok(Math.abs(real.usd - esperado) < 1e-12, "coste exacto del turno real");
assert.ok(real.usd < 0.002, "menos de dos milesimas de dolar: " + real.usd);

// LO QUE PASA SI SE IGNORA LA CACHE, que es el error que hay que evitar.
const ignorandoCache = (99015 * 0.14 + 2383 * 0.28) / 1e6;
assert.ok(
  ignorandoCache / real.usd > 10,
  "ignorar la cache multiplica el coste por " + Math.round(ignorandoCache / real.usd)
);

// --- La salida pesa mas que la entrada --------------------------------------
// Contraintuitivo y es la clave: 99.000 tokens de entrada cuestan menos que
// 2.383 de salida, porque casi toda la entrada viene de cache.
assert.ok(
  real.coste_salida_usd > real.coste_entrada_usd,
  "la salida cuesta mas que los 99.000 tokens de entrada"
);

// --- Tramos por fecha --------------------------------------------------------

const tramos = CATALOGO.deepseek["deepseek-v4-flash"];
assert.equal(elegirTramo(tramos, "2026-08-15T23:59:59Z").cache_miss, 0.14, "el 15 sigue la tarifa vieja");
assert.equal(elegirTramo(tramos, "2026-08-16T00:00:00Z").cache_miss, 0.22, "el 16 ya es la nueva");

const mismoTurnoDespues = calcularCoste({
  provider: "deepseek", model: "deepseek-v4-flash", at: DESPUES_VALLE,
  input_tokens: 99015, output_tokens: 2383, cached_tokens: 97536
});
assert.ok(mismoTurnoDespues.usd > real.usd, "el mismo turno cuesta mas tras la subida");

// --- Horario pico ------------------------------------------------------------

const tramoNuevo = elegirTramo(tramos, DESPUES_PICO);
assert.equal(esHoraPico(tramoNuevo, "2026-08-20T08:30:00Z"), true, "08:30 UTC es pico");
assert.equal(esHoraPico(tramoNuevo, "2026-08-20T02:00:00Z"), true, "02:00 UTC es pico");
assert.equal(esHoraPico(tramoNuevo, "2026-08-20T14:00:00Z"), false, "14:00 UTC es valle");
assert.equal(esHoraPico(tramoNuevo, "2026-08-20T10:00:00Z"), false, "a las 10:00 ya termino el pico");
assert.equal(esHoraPico(tramos[0], "2026-08-13T08:30:00Z"), false, "antes del 16 no habia pico");

const enPico = calcularCoste({
  provider: "deepseek", model: "deepseek-v4-flash", at: DESPUES_PICO,
  input_tokens: 99015, output_tokens: 2383, cached_tokens: 97536
});
assert.equal(enPico.franja, "pico");
assert.equal(mismoTurnoDespues.franja, "valle");
assert.ok(enPico.usd > mismoTurnoDespues.usd, "en pico cuesta mas que en valle");

// --- Sin desglose de cache: RANGO, no un numero inventado --------------------

const sinCache = calcularCoste({
  provider: "deepseek", model: "deepseek-v4-flash", at: ANTES,
  input_tokens: 99015, output_tokens: 2383, cached_tokens: null
});
assert.equal(sinCache.exact, false);
assert.equal(sinCache.usd, null, "no se inventa un numero");
assert.equal(sinCache.motivo, "sin_desglose_de_cache");
assert.ok(sinCache.usd_min < real.usd && real.usd < sinCache.usd_max, "el real cae dentro del rango");

// --- Agnostico de proveedor --------------------------------------------------

const sinProveedor = calcularCoste({
  model: "deepseek-v4-flash", at: ANTES,
  input_tokens: 1000, output_tokens: 100, cached_tokens: 900
});
assert.equal(sinProveedor.provider, "deepseek", "encuentra el proveedor por el modelo");

const desconocido = calcularCoste({
  provider: "openai", model: "gpt-inexistente",
  input_tokens: 1000, output_tokens: 100, cached_tokens: 0
});
assert.equal(desconocido.exact, false);
assert.equal(desconocido.motivo, "modelo_desconocido", "un modelo que no esta en el catalogo se dice, no se estima");
assert.equal(desconocido.usd, null);

// El nombre del PERFIL no es un modelo: no debe colar como si lo fuera.
assert.equal(
  calcularCoste({ model: "helios", input_tokens: 10, output_tokens: 1, cached_tokens: 0 }).motivo,
  "modelo_desconocido",
  "«helios» es un perfil, no un modelo"
);

// --- Casos limite ------------------------------------------------------------

assert.equal(calcularCoste({}).motivo, "modelo_desconocido");
const cacheMayor = calcularCoste({
  model: "deepseek-v4-flash", at: ANTES,
  input_tokens: 100, output_tokens: 0, cached_tokens: 500
});
assert.equal(cacheMayor.cached_tokens, 100, "la cache no puede superar la entrada");
assert.equal(cacheMayor.uncached_tokens, 0);

assert.equal(formatearUsd(0.001147), "$0.001147");
assert.equal(formatearUsd(null), "N/A");

console.log("test_pricing: PASS");
console.log("  coste real del turno de 101.398 tokens: " + real.usd.toFixed(6) + " USD");
console.log("  ignorando la cache habria dado:         " + ignorandoCache.toFixed(6) + " USD");
console.log("  el mismo turno tras la subida (valle):  " + mismoTurnoDespues.usd.toFixed(6) + " USD");
console.log("  el mismo turno tras la subida (pico):   " + enPico.usd.toFixed(6) + " USD");

// --- Filas antiguas con el PERFIL guardado como modelo ----------------------
// Durante meses se guardo "helios" en el campo del modelo. No esta vacio, asi
// que un simple `guardado || respaldo` lo daba por bueno y dejaba TODO el
// historial sin tarifa. Se resuelve preguntando al catalogo.

const { modeloConTarifa } = require("./pricing.js");

assert.equal(
  modeloConTarifa("helios", "deepseek-v4-flash"),
  "deepseek-v4-flash",
  "una fila antigua con el perfil cae al modelo de facturacion"
);
assert.equal(
  modeloConTarifa("deepseek-v4-pro", "deepseek-v4-flash"),
  "deepseek-v4-pro",
  "si el guardado es bueno, ese manda"
);
assert.equal(modeloConTarifa("helios", null), null, "sin respaldo valido, se admite que no se sabe");
assert.equal(modeloConTarifa(null, null), null);
assert.equal(modeloConTarifa("", "deepseek-v4-flash"), "deepseek-v4-flash");

const filaAntigua = calcularCoste({
  model: modeloConTarifa("helios", "deepseek-v4-flash"),
  at: ANTES, input_tokens: 99015, output_tokens: 2383, cached_tokens: 97536
});
assert.equal(filaAntigua.exact, true, "y por tanto una traza vieja ya muestra su coste");
assert.ok(Math.abs(filaAntigua.usd - real.usd) < 1e-12);

console.log("  filas antiguas con perfil por modelo: resueltas");

// ============================================================================
// GEMINI: LA ENTRADA DE AUDIO CUESTA EL TRIPLE
// ============================================================================
//
// EL FALLO QUE ESTO EVITA es de los que no se notan: valorar una nota de voz a precio
// de texto no es un redondeo, es un TERCIO del coste real. El panel diria 0,0001 USD
// donde se pagaron 0,0003, y multiplicado por mil notas de voz al mes la cifra que se
// usa para decidir el precio del producto esta mal por un factor de tres.
//
// Y NO SE PUEDE DEDUCIR DEL MODELO, que es lo que lo hace facil de olvidar: el mismo
// gemini-2.5-flash-lite cobra 0,10 por texto, imagen y video, y 0,30 por audio. La
// unica forma de acertar es que el TIPO viaje hasta el calculo.

const AHORA_G = "2026-08-24T12:00:00Z";

// Una nota de voz de 30 segundos: 32 tokens por segundo = 960 de entrada.
const notaDeVoz = calcularCoste({
  model: "gemini-2.5-flash-lite", modalidad: "audio",
  input_tokens: 960, output_tokens: 20, cached_tokens: 0, at: AHORA_G
});
assert.equal(notaDeVoz.exact, true, "sin cache de contexto, el coste de un archivo es EXACTO");
assert.equal(notaDeVoz.modalidad, "audio");
assert.ok(
  Math.abs(notaDeVoz.usd - (960 * 0.30 + 20 * 0.40) / 1e6) < 1e-12,
  "una nota de voz de 30 segundos cuesta 0,000296 USD"
);

const comoSiFueraTexto = calcularCoste({
  model: "gemini-2.5-flash-lite",
  input_tokens: 960, output_tokens: 20, cached_tokens: 0, at: AHORA_G
});
assert.ok(
  notaDeVoz.usd > comoSiFueraTexto.usd * 2.5,
  "SIN la modalidad el mismo audio sale casi tres veces mas barato: es el error que " +
  "por_modalidad existe para evitar"
);

// Una imagen: 258 tokens por bloque de 768x768, a precio de texto.
const imagen = calcularCoste({
  model: "gemini-2.5-flash-lite", modalidad: "imagen",
  input_tokens: 258, output_tokens: 12, cached_tokens: 0, at: AHORA_G
});
assert.ok(
  Math.abs(imagen.usd - (258 * 0.10 + 12 * 0.40) / 1e6) < 1e-12,
  "imagen, video y documento van a 0,10: solo el audio es distinto"
);
for (const m of ["imagen", "video", "documento", null, "", "cualquiera"]) {
  const r = calcularCoste({
    model: "gemini-2.5-flash-lite", modalidad: m,
    input_tokens: 1000, output_tokens: 0, cached_tokens: 0, at: AHORA_G
  });
  assert.ok(
    Math.abs(r.usd - 1000 * 0.10 / 1e6) < 1e-12,
    "modalidad " + JSON.stringify(m) + ": todo lo que no sea audio va a la tarifa base"
  );
}

// Y LO QUE MAS IMPORTA DE TODO ESTO: DEEPSEEK NO SE HA MOVIDO. `por_modalidad` es un
// campo que solo existe en los tramos de Gemini, asi que pasar una modalidad a un
// modelo que no la declara no puede cambiar su precio.
const dsSinModalidad = calcularCoste({
  model: "deepseek-v4-flash", input_tokens: 37307, output_tokens: 400,
  cached_tokens: 36000, at: AHORA_G
});
for (const m of ["audio", "imagen", "video"]) {
  const dsCon = calcularCoste({
    model: "deepseek-v4-flash", modalidad: m, input_tokens: 37307, output_tokens: 400,
    cached_tokens: 36000, at: AHORA_G
  });
  assert.equal(
    dsCon.usd, dsSinModalidad.usd,
    "una modalidad NO puede cambiar el precio de un modelo que no la declara"
  );
}

// La hora pico de DeepSeek sigue funcionando con el parametro nuevo en medio.
const pico = calcularCoste({
  model: "deepseek-v4-flash", input_tokens: 1000, output_tokens: 100,
  cached_tokens: 0, at: "2026-08-24T02:00:00Z"
});
const valle = calcularCoste({
  model: "deepseek-v4-flash", input_tokens: 1000, output_tokens: 100,
  cached_tokens: 0, at: AHORA_G
});
assert.equal(pico.franja, "pico");
assert.equal(valle.franja, "valle");
assert.ok(pico.usd > valle.usd, "el recargo de hora pico sigue aplicandose");

console.log("  gemini: audio a 0,30 y el resto a 0,10, sin tocar deepseek");

// ============================================================================
// GEMINI 3.5 FLASH-LITE: EL AUDIO YA NO TIENE TARIFA PROPIA
// ============================================================================
//
// EL 24 DE AGOSTO DE 2026 HUBO QUE CAMBIAR DE MODELO. gemini-2.5-flash-lite sigue en la
// lista de modelos de Google y sigue en su pagina de precios, pero esta cerrado a claves
// nuevas. Su respuesta, literal: «This model models/gemini-2.5-flash-lite is no longer
// available to new users. Please update your code to use models/gemini-3.5-flash-lite».
//
// LA TRAMPA DE ESTE CAMBIO, y es la razon de ser de esta prueba: en 2.5 el audio costaba
// EL TRIPLE que el texto; en 3.5 va al MISMO precio. Copiar el `por_modalidad` del modelo
// viejo -que es lo natural al añadir una fila nueva al lado- habria valorado cada nota de
// voz a 0,90 en vez de 0,30. Tres veces de mas, en silencio, en la cifra que se usa para
// poner precio al producto.

const AHORA_35 = "2026-08-24T12:00:00Z";
const coste35 = (modalidad, entrada, salida) => calcularCoste({
  model: "gemini-3.5-flash-lite", modalidad,
  input_tokens: entrada, output_tokens: salida, cached_tokens: 0, at: AHORA_35
});

// TODAS LAS MODALIDADES AL MISMO PRECIO. Esta es la comprobacion que caza el error de
// copiar por_modalidad del modelo anterior.
const base35 = coste35(null, 1000, 0).usd;
for (const m of ["audio", "imagen", "video", "documento", null, "", "cualquiera"]) {
  assert.ok(
    Math.abs(coste35(m, 1000, 0).usd - base35) < 1e-12,
    `3.5-flash-lite, modalidad ${JSON.stringify(m)}: NO tiene tarifa de audio aparte. ` +
    `Si esto falla, alguien copio el por_modalidad de 2.5 y las notas de voz se estan ` +
    `valorando al triple`
  );
}
assert.ok(Math.abs(base35 - 1000 * 0.30 / 1e6) < 1e-12, "la entrada de 3.5 son 0,30 por millon");
assert.ok(
  Math.abs(coste35(null, 0, 1000).usd - 1000 * 2.50 / 1e6) < 1e-12,
  "y la salida 2,50: seis veces la de 2.5, que es lo que de verdad cambia"
);

// Y EL MODELO VIEJO SIGUE VALORANDOSE BIEN. Las filas de antes del cambio existen y su
// coste no se puede recalcular con la tarifa nueva: cada fila se valora con la suya.
const vozEn25 = calcularCoste({
  model: "gemini-2.5-flash-lite", modalidad: "audio",
  input_tokens: 960, output_tokens: 20, cached_tokens: 0, at: AHORA_35
});
assert.ok(
  Math.abs(vozEn25.usd - (960 * 0.30 + 20 * 0.40) / 1e6) < 1e-12,
  "una fila vieja de 2.5 se sigue valorando con la tarifa de 2.5"
);

// LA COMPARACION QUE JUSTIFICA LA ELECCION, para que no haya que rehacerla:
//
//                         2.5-lite      3.5-lite      3.1-lite
//   nota de voz 30s      0,000296      0,000338      0,000510
//   imagen               0,000032      0,000115      0,000087
//   video 10s            0,000804      0,002425      0,002015
//
// Se eligio 3.5 y no 3.1 porque el caso dominante de Helios es TRANSCRIBIR, y ahi 3.1
// sale mas caro pese a tener la salida mas barata: su audio cuesta 0,50 frente a 0,30.
const voz35 = coste35("audio", 960, 20).usd;
const voz31 = calcularCoste({
  model: "gemini-3.1-flash-lite", modalidad: "audio",
  input_tokens: 960, output_tokens: 20, cached_tokens: 0, at: AHORA_35
}).usd;
assert.ok(voz35 < voz31, "para transcribir, 3.5 es mas barato que 3.1");

console.log("  gemini 3.5: audio al mismo precio que el texto, y 2.5 sigue valorandose");
