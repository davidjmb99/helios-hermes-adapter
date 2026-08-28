/**
 * El titulo de la sesion de Hermes.
 *
 * Hermes crea las sesiones de la API sin titulo y el WebUI las nombra con la primera linea
 * de lo que recibe. Como esa primera linea es siempre la misma -«OUTPUT CONTRACT
 * (REQUIRED):»- salian varias conversaciones con el mismo nombre, indistinguibles.
 *
 * LO QUE SE PROTEGE: que se titule EN CUANTO SE SABE CUAL ES LA SESION, y no solo cuando el
 * turno termina bien. Antes se hacia despues de persistir, asi que un turno que reventaba
 * antes -un contrato vetado, una excepcion- se quedaba sin nombre. Y son justo esas las que
 * alguien va a ir a buscar: la que salio bien no la mira nadie.
 */

const assert = require("assert");
const fs = require("fs");

const fuente = fs.readFileSync("server.js", "utf8");

// --- 1. SE TITULA ANTES DE PERSISTIR, NO SOLO DESPUES ----------------------

// La definicion de la funcion NO cuenta como llamada: se descarta mirando lo que hay
// justo antes del nombre.
const llamadas = [...fuente.matchAll(/ensureHermesSessionTitle\(/g)]
  .map(m => m.index)
  .filter(i => !fuente.slice(Math.max(0, i - 20), i).includes("function "));

assert.equal(
  llamadas.length, 2,
  `tienen que ser DOS llamadas -antes y despues de persistir- y hay ${llamadas.length}`
);

const persistencia = fuente.indexOf('processingStage = "durable_persistence"');
assert.ok(persistencia > 0, "se encontro el punto de persistencia");

const antes = llamadas.filter(i => i < persistencia);
const despues = llamadas.filter(i => i > persistencia);

assert.ok(
  antes.length >= 1,
  "TIENE que titularse antes de persistir: si no, un turno que falla se queda sin nombre"
);
assert.ok(
  despues.length >= 1,
  "y despues tambien, para cambiarlo por el nombre del paciente en cuanto se conoce"
);

// --- 2. NUNCA BLOQUEA NI TUMBA EL TURNO ------------------------------------

for (const i of [...antes, ...despues]) {
  const trozo = fuente.slice(i - 30, i + 200);
  assert.ok(
    trozo.includes(".catch(() => {})"),
    "titular una sesion NUNCA puede tumbar la respuesta al paciente: hace falta el .catch"
  );
  assert.ok(
    !/await\s+ensureHermesSessionTitle/.test(trozo),
    "ni retrasarla: nada de await"
  );
}

// --- 3. EL TITULO LLEVA LA CONVERSACION, QUE ES POR LO QUE SE BUSCA --------

const cuerpo = fuente.slice(
  fuente.indexOf("async function ensureHermesSessionTitle("),
  fuente.indexOf("async function ensureHermesSessionTitle(") + 1200
);
// LAS DOS RAMAS LLEVAN EL NUMERO DE CONVERSACION, y hay que comprobarlas por separado:
// mirar solo si aparece «Conversación ${conversationId}» en algun sitio lo daba por bueno
// aunque la rama del nombre lo hubiera perdido -la otra rama lo tapaba-.
assert.ok(
  cuerpo.includes("${fullName} · Conversación ${conversationId}"),
  "con nombre: «David Mercado · Conversación 84»"
);
assert.ok(
  cuerpo.includes("Helios · Conversación ${conversationId}"),
  "y sin nombre todavia: «Helios · Conversación 84», que ya sirve para encontrarla"
);
assert.ok(
  cuerpo.includes("hermesSessionTitles.get(sessionId) === title"),
  "con guard: la segunda llamada no debe repetir el PATCH si el titulo no cambio"
);

console.log("test_session_title: OK");
