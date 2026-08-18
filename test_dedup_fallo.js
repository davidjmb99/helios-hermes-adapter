"use strict";

/**
 * Un reintento deduplicado de algo que ya fallo NO se reintenta mas.
 *
 * EL CASO REAL, del 18 de agosto de madrugada. El operador mando dos mensajes de
 * prueba. El segundo no le llego nunca al WhatsApp, y el panel decia
 * OUTPUT_CONTRACT_VIOLATION en cada reintento. Pero Hermes SI habia contestado ese
 * turno con un contrato perfecto: el error que se mostraba era el de la PRIMERA
 * vez, guardado, devuelto una y otra vez.
 *
 * El mecanismo: peticion repetida -> el Adapter devuelve el resultado guardado ->
 * ese resultado era un fallo con recoverable=true -> el worker lo reintenta ->
 * recibe el mismo fallo guardado -> lo reintenta otra vez. Por construccion
 * devuelve siempre lo mismo. Un bucle que no puede progresar.
 *
 * El arreglo del dia anterior solo cubria el caso SIN resultado guardado, y por eso
 * no sirvio de nada. Esta prueba fija los dos casos y, sobre todo, fija que un
 * reintento de un EXITO sigue devolviendo el exito: eso es la idempotencia, y
 * romperla seria peor que el bucle.
 */

const assert = require("assert");
const fs = require("fs");

// El fichero esta en CRLF y las busquedas con salto de linea simple no
// encontraban nada: devolvian un bloque vacio, sin avisar. De ahi el assert
// de mas abajo que comprueba que el bloque extraido no viene vacio.
const fuente = fs.readFileSync(require.resolve("./server.js"), "utf8")
  .split("\r\n").join("\n");

const inicio = fuente.indexOf('if (result.idempotencyStatus === "deduplicated" && normalizedResponse) {');
assert.ok(inicio > 0, "no se encontro el bloque del reintento abandonado");
const fin = fuente.indexOf("\n    }\n", fuente.indexOf("adapter_reintento_abandonado")) + "\n    }\n".length;
const bloque = fuente.slice(inicio, fin);
assert.ok(bloque.includes("recoverable: false"), "el bloque extraido esta incompleto");

/**
 * EL TEST TAPABA EL FALLO. La primera version le pasaba al bloque un `ctx` de
 * mentira, y con eso `ctx.identity?.trace_id` funcionaba aqui... y reventaba en
 * produccion con ReferenceError, porque en ese ambito `ctx` NO EXISTE. El Adapter
 * devolvia 502 en cada peticion deduplicada.
 *
 * La leccion: un arnes que INVENTA una variable no prueba el codigo, prueba otra
 * cosa. Ahora se le pasan solo las que de verdad hay alli -result,
 * normalizedResponse y traceId- y cualquier otra referencia revienta el test,
 * que es justo lo que se quiere.
 */
function aplicar(result, normalizedResponse) {
  const traceId = "t-prueba";
  const avisos = [];
  const consolaOriginal = console.warn;
  console.warn = (m) => avisos.push(m);
  try {
    // eslint-disable-next-line no-new-func
    const fn = new Function("result", "normalizedResponse", "traceId", bloque + "\n return normalizedResponse;");
    return { salida: fn(result, normalizedResponse, traceId), avisos };
  } finally {
    console.warn = consolaOriginal;
  }
}

// --- EL CASO QUE FALLABA: reintento de un fallo guardado --------------------

let r = aplicar(
  { idempotencyStatus: "deduplicated", executionRequestKey: "helios-abc" },
  {
    ok: false,
    error_code: "OUTPUT_CONTRACT_VIOLATION",
    recoverable: true,                       // <- esto era el motor del bucle
    safe_to_send: false,
    message_for_client: "",
    operation: { type: "technical_error", status: "failed" }
  }
);

assert.equal(r.salida.recoverable, false, "LO QUE PARA EL BUCLE: deja de ser recuperable");
assert.equal(r.salida.error_code, "REINTENTO_ABANDONADO", "y el panel deja de mentir con la causa vieja");
assert.equal(r.salida.error_code_original, "OUTPUT_CONTRACT_VIOLATION", "pero la causa original no se pierde");
assert.match(r.salida.operation.summary, /no se reintenta/i);
assert.equal(r.avisos.length, 1, "queda registrado");
assert.match(r.avisos[0], /adapter_reintento_abandonado/);

// --- LO QUE NO SE PUEDE ROMPER: un reintento de un EXITO sigue siendo exito --
// Es la razon de existir de la deduplicacion. Si esto se rompiera, un mensaje ya
// enviado se volveria a enviar, y duplicar mensajes a un paciente es peor que
// cualquier bucle.

r = aplicar(
  { idempotencyStatus: "deduplicated", executionRequestKey: "helios-ok" },
  {
    ok: true,
    error_code: null,
    recoverable: false,
    safe_to_send: true,
    message_for_client: "Tu cita del jueves esta confirmada.",
    operation: { type: "appointment_created", status: "success" }
  }
);

assert.equal(r.salida.error_code, null, "un exito deduplicado NO se marca como fallo");
assert.equal(r.salida.message_for_client, "Tu cita del jueves esta confirmada.", "y su mensaje se conserva");
assert.equal(r.salida.safe_to_send, true);
assert.equal(r.avisos.length, 0, "y no se avisa de nada");

// --- Una peticion NUEVA no se toca, aunque falle ----------------------------
// Un fallo de primera vez SI puede ser recuperable: quiza el reintento funcione.

r = aplicar(
  { idempotencyStatus: "new", executionRequestKey: "helios-nueva" },
  { ok: false, error_code: "HERMES_TIMEOUT", recoverable: true, safe_to_send: false }
);

assert.equal(r.salida.recoverable, true, "un fallo NUEVO sigue siendo reintentable");
assert.equal(r.salida.error_code, "HERMES_TIMEOUT", "y conserva su codigo");
assert.equal(r.avisos.length, 0);

// --- Un fallo guardado sin codigo tambien para el bucle ---------------------

r = aplicar(
  { idempotencyStatus: "deduplicated", executionRequestKey: "helios-sin-codigo" },
  { ok: false, error_code: null, recoverable: true, safe_to_send: false }
);
assert.equal(r.salida.recoverable, false);
assert.equal(r.salida.error_code_original, "desconocida", "se dice que no se sabe, no se inventa");

console.log("test_dedup_fallo: PASS");
