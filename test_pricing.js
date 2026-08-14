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
