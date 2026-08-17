"use strict";

/**
 * Que el panel no lea campos que la consulta no pide.
 *
 * EL FALLO QUE MOTIVA ESTA PRUEBA. El coste del mensaje leía
 * `ev.cache_read_tokens` para saber cuántos tokens vinieron de caché, pero ese
 * campo NO estaba en la lista del select. En JavaScript eso no es un error: es
 * `undefined`. Así que el coste salía siempre como rango en vez de exacto, sin una
 * sola señal de que faltaba un dato. Y el dato importa por un factor de cincuenta.
 *
 * Peor aún: la columna tampoco existía en la base, y el Adapter la leía de Hermes y
 * la tiraba. Tres piezas desconectadas y ningún mensaje de error en ninguna.
 *
 * Esta prueba comprueba las tres uniones: que se guarde, que se pida, y que lo que
 * el panel lee esté entre lo que se pide.
 */

const assert = require("assert");
const fs = require("fs");

const fuente = fs.readFileSync(require.resolve("./server.js"), "utf8");

// --- La lista de campos que pide el panel ------------------------------------

// Hay varias consultas contra esta tabla -conteos, comprobaciones-, así que se
// coge la que pide más campos: esa es la del panel.
const listas = [...fuente.matchAll(
  /\.from\(['"]helios_adapter_events['"]\)[\s\S]{0,80}?\.select\((['"])([^'"]+)\1/g
)].map(m => m[2]);
assert.ok(listas.length > 0, "no se encontró ningún select sobre helios_adapter_events");

const listaDelPanel = listas.sort((a, b) => b.length - a.length)[0];
const pedidos = new Set(listaDelPanel.split(",").map(c => c.trim()).filter(Boolean));

assert.ok(pedidos.size > 20, "el select del panel parece truncado: " + pedidos.size + " campos");

// --- Lo que el panel LEE de cada fila ----------------------------------------

/**
 * Campos que NO vienen del select porque se calculan al servir la fila. Si se añade
 * uno nuevo hay que apuntarlo aquí, y eso es a propósito: obliga a pararse a pensar
 * si de verdad es derivado o si se ha olvidado pedirlo.
 */
const DERIVADOS = new Set([
  "cost",                  // lo calcula pricing.js
  "billing_model",         // el modelo con el que se cobra, resuelto
  "billing_model_source",  // de dónde salió esa tarifa
  "model_guardado"         // copia de `model` para poder mostrar las dos cosas
]);

const leidos = new Set();
for (const m of fuente.matchAll(/\bev\.([a-z_][a-z0-9_]*)/gi)) leidos.add(m[1]);

const huerfanos = [...leidos].filter(campo => !pedidos.has(campo) && !DERIVADOS.has(campo));
assert.deepEqual(
  huerfanos,
  [],
  "el panel lee campos que la consulta no pide (saldrían como undefined sin avisar): " + huerfanos.join(", ")
);

// --- El campo concreto que estaba roto, en las tres piezas ------------------

assert.ok(
  pedidos.has("cache_read_tokens"),
  "cache_read_tokens tiene que estar en el select o el coste nunca será exacto"
);

const guardado = fuente.match(/cache_read_tokens:\s*tokenUsage\.cache_read_tokens/);
assert.ok(guardado, "cache_read_tokens tiene que guardarse en la fila, no solo leerse de Hermes");

const migraciones = fs.readdirSync(require("path").join(__dirname, "supabase", "migrations"))
  .map(f => fs.readFileSync(require("path").join(__dirname, "supabase", "migrations", f), "utf8"))
  .join("\n");
assert.ok(
  /ADD COLUMN IF NOT EXISTS cache_read_tokens/.test(migraciones),
  "la columna cache_read_tokens tiene que existir en alguna migración"
);

// --- Y que el modelo que se muestra sea el que se cobra --------------------
// El panel mostraba `ev.model` tal cual, y ahi vivia «helios» -el perfil-, asi que
// decia «Modelo: helios» mientras cobraba con la tarifa de DeepSeek.

assert.ok(
  !/>Modelo<\/span><div>'\s*\+\s*escapeHtml\(ev\.model\b/.test(fuente),
  "el panel no debe mostrar ev.model crudo: ahí puede haber el nombre del perfil"
);
assert.ok(
  /billing_model_source/.test(fuente),
  "el panel tiene que decir de dónde sale la tarifa que aplica"
);

console.log("test_panel_fields: PASS");
console.log("  campos pedidos en el select: " + pedidos.size);
console.log("  campos leídos por el panel:  " + leidos.size);
