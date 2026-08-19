/**
 * ¿Dice el Adapter QUIEN fallo, o solo que algo fallo?
 *
 * Peticion de David: «cuando de un error asi, de una vez sea identificado en el
 * adapter, diga el nombre de lo que esta fallando». Durante una semana el panel
 * decia OUTPUT_CONTRACT_VIOLATION -el sintoma- y llegar de ahi al culpable real
 * costo cinco hipotesis fallidas y varias auditorias.
 *
 * Los dos casos de este test son REALES, con sus fechas:
 *  - 17-ago, conversacion 69: 0 tokens en 798 ms. El proveedor rechazo la peticion.
 *  - 18-ago, conversacion 57: JSON valido con message_for_client vacio. El guard.
 *
 * Y lo que mas importa: que NO invente. Si el contrato parsea y trae mensaje, no
 * hay patron conocido y tiene que decir «desconocido». Inventar es lo que costo la
 * semana.
 */
const fs = require('fs');
const assert = require('assert');

const src = fs.readFileSync(require('path').join(__dirname, 'server.js'), 'utf8');
const ini = src.indexOf('function nombrarAlCulpable');
const fin = src.indexOf('function construirCajaNegra');
assert.ok(ini > 0 && fin > ini, 'no se encuentra nombrarAlCulpable en server.js');
eval(src.slice(ini, fin));

let pasados = 0;
const comprobar = (etiqueta, condicion) => {
  assert.ok(condicion, 'FALLO: ' + etiqueta);
  pasados += 1;
  console.log('  PASS: ' + etiqueta);
};

// --- Caso real 1: Ligia, 17-ago. Cero tokens = el modelo no se ejecuto -------
{
  const d = nombrarAlCulpable({ tokenUsage: { total_tokens: 0 } }, {}, 'OUTPUT_CONTRACT_VIOLATION', '');
  comprobar('cero tokens senala al proveedor del modelo', d.culpable === 'proveedor_del_modelo');
  comprobar('y lo afirma con seguridad', d.seguro === true);
  comprobar('y dice donde mirar', /pre_api_request|helios-output-guard/.test(d.donde_mirar));
}

// --- Caso real 2: David, 18-ago. JSON perfecto, mensaje vacio = el guard ------
{
  const contrato = JSON.stringify({
    message_for_client: '',
    operation: { type: 'technical_error', status: 'failed', summary: 'La salida final no supero la validacion contractual.' },
    profile_patch: {}, state_patch: {}, booking_patch: {}, tool_calls: [],
    safe_to_send: false, requires_handoff: false, recoverable: true,
    error_code: 'OUTPUT_CONTRACT_VIOLATION'
  });
  const d = nombrarAlCulpable({ tokenUsage: { total_tokens: 1200 } }, {}, 'OUTPUT_CONTRACT_VIOLATION', contrato);
  comprobar('mensaje vacio con JSON valido senala al guard', d.culpable === 'helios_output_guard');
  comprobar('y lo afirma con seguridad', d.seguro === true);
  comprobar('y nombra el plugin', /helios-output-guard/.test(d.donde_mirar));
}

// --- Lo que NO debe hacer: inventar -----------------------------------------
{
  const bueno = JSON.stringify({ message_for_client: 'Hola David, ya tengo tu ficha.', safe_to_send: true });
  const d = nombrarAlCulpable({ tokenUsage: { total_tokens: 900 } }, {}, 'ALGO_RARO', bueno);
  comprobar('con mensaje presente no culpa a nadie', d.culpable === 'desconocido');
  comprobar('y NO se presenta como seguro', d.seguro === false);
}

{
  const d = nombrarAlCulpable({ tokenUsage: { total_tokens: 900 } }, {}, 'X', 'Voy a mirar la agenda');
  comprobar('texto que no parsea es sospecha, no certeza', d.culpable === 'forma_de_la_respuesta' && d.seguro === false);
}

{
  const d = nombrarAlCulpable({ tokenUsage: { total_tokens: 500 } }, {}, 'ADAPTER_EXCEPTION', '');
  comprobar('sin texto y con tokens gastados es sin_respuesta', d.culpable === 'sin_respuesta');
}

// --- El orden importa: cero tokens gana sobre todo lo demas ------------------
{
  // Si llegara un contrato vacio Y cero tokens, la causa es el rechazo del
  // proveedor: sin ejecucion no hay respuesta que el guard pudiera vaciar.
  const vacio = JSON.stringify({ message_for_client: '', safe_to_send: false });
  const d = nombrarAlCulpable({ tokenUsage: { total_tokens: 0 } }, {}, 'X', vacio);
  comprobar('cero tokens manda sobre el patron del guard', d.culpable === 'proveedor_del_modelo');
}

// --- Sin datos de tokens no se afirma un 400 --------------------------------
{
  // tokens desconocidos NO es lo mismo que cero. Tratarlos igual acusaria al
  // proveedor cada vez que falte la telemetria.
  const d = nombrarAlCulpable({}, {}, 'X', 'texto cualquiera');
  comprobar('tokens ausentes no se leen como cero', d.culpable !== 'proveedor_del_modelo');
}

console.log('\ntest_diagnostico: ' + pasados + '/' + pasados + ' PASS');
