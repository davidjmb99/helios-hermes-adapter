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

// EL CUERPO SE DELIMITA POR LA SIGUIENTE FUNCION, no cortando 1200 caracteres. Con el
// corte fijo, cualquier comentario que se añada arriba empuja lo que se comprueba fuera
// de la ventana y la prueba falla por una razon que no tiene nada que ver.
const inicioCuerpo = fuente.indexOf("async function ensureHermesSessionTitle(");
assert.ok(inicioCuerpo > 0, "se encontro ensureHermesSessionTitle");
const finCuerpo = fuente.indexOf("\nfunction ", inicioCuerpo);
const cuerpo = fuente.slice(inicioCuerpo, finCuerpo > inicioCuerpo ? finCuerpo : undefined);
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
// EL GUARD, COMPROBADO POR LA FORMA Y NO POR EL NOMBRE DE LA VARIABLE. Esta linea
// decia `hermesSessionTitles.get(sessionId) === title` tal cual, y al cambiar la clave
// de la cache para meterle el perfil, la prueba se puso roja sin que el guard hubiera
// dejado de existir. Una prueba que se rompe al renombrar una variable local no esta
// protegiendo la propiedad, esta copiando el codigo.
assert.ok(
  /if \(hermesSessionTitles\.get\(\w+\) === title\) return;/.test(cuerpo),
  "con guard: la segunda llamada no debe repetir el PATCH si el titulo no cambio"
);

// --- 4. EL PATCH VA AL HERMES DE ESTA CLINICA ------------------------------
//
// Se rompio al meter el enrutado por perfil: el mensaje ya salia por el cliente de la
// clinica, pero el titulo se le pedia al cliente global -el de la clinica del Adapter-.
// La sesion solo existe en el Hermes de su propio perfil, asi que el PATCH fallaba y
// el WebUI volvia a titular con la primera linea: «OUTPUT CONTRACT (REQUIRED)» otra vez,
// que es exactamente lo que esta funcion existe para evitar.
//
// EN LA CLINICA DEL ADAPTER NO SE NOTABA, porque para ella el cliente global si es el
// correcto. Por eso hacen falta las dos comprobaciones y no solo «que titule».

assert.ok(
  !/hermesAgentClient\s*\.\s*renameSession/.test(cuerpo),
  "el titulo se le pide al cliente global: en cualquier clinica que no sea la del "
    + "Adapter, ese PATCH va al Hermes equivocado y la sesion se queda sin nombre"
);
assert.ok(
  /clienteDe\(/.test(cuerpo) && /\.renameSession\(/.test(cuerpo),
  "el titulo tiene que pedirse al cliente que corresponde al perfil de la clinica"
);

// Y LA CLAVE DE LA CACHE LLEVA EL PERFIL. Cada Hermes acuña sus identificadores de
// sesion sin saber de los demas, y este Map lo comparten todas las clinicas: dos
// sesiones con el mismo id harian que la segunda se creyera ya renombrada.
assert.ok(
  /hermes_profile|perfil/.test(cuerpo.slice(0, cuerpo.indexOf("hermesSessionTitles.get"))),
  "la clave de la cache de titulos tiene que incorporar el perfil, no solo el sessionId"
);

console.log("test_session_title: OK");
