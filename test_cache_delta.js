/**
 * ¿Da el coste EXACTO, y se calla cuando no puede?
 *
 * Lo que se protege, en este orden de importancia:
 *  1. Que un desglose exacto lo sea de verdad: la suma de los deltas tiene que
 *     cuadrar con la entrada que reporta el propio turno.
 *  2. Que NO invente cuando no cuadra. Un coste exacto equivocado es peor que un
 *     rango honesto, porque se usa para decidir.
 *  3. Que un reinicio de los contadores no produzca un numero con pinta de bueno.
 */
const assert = require('assert');
const { calcularDesgloseDeCache, leerAcumuladosDelContrato } = require('./cache-delta.js');

let pasados = 0;
const ok = (etiqueta, condicion) => {
  assert.ok(condicion, 'FALLO: ' + etiqueta);
  pasados += 1;
  console.log('  PASS: ' + etiqueta);
};

// --- El caso real: el turno de 126.601 tokens de la conversacion 57 ----------
{
  // Hermes midio que la sesion b3086c75 va al 90,2631% de acierto. Con acumulados
  // que crecen exactamente 126.601 en este turno, el desglose sale exacto.
  const anterior = { hit: 600000, nuevos: 65000 };
  const actual = { hit: 600000 + 114262, nuevos: 65000 + 12339, input_tokens: 126601 };
  const d = calcularDesgloseDeCache(actual, anterior);
  ok('el turno real da desglose exacto', d.exacto === true);
  ok('y los tokens cacheados son la resta', d.cached_tokens === 114262);
  ok('y los nuevos tambien', d.nuevos_tokens === 12339);
  ok('y el porcentaje cuadra con lo que midio Hermes', Math.abs(d.porcentaje_cache - 90.25) < 0.1);
}

// --- Primer turno de una sesion ---------------------------------------------
{
  const d = calcularDesgloseDeCache({ hit: 0, nuevos: 6623, input_tokens: 6623 }, null);
  ok('el primer turno sin cache es exacto', d.exacto === true && d.cached_tokens === 0);
  ok('y su porcentaje de cache es cero', d.porcentaje_cache === 0);
}

// --- LO QUE MAS IMPORTA: cuando NO cuadra, no se afirma ---------------------
{
  // Falta un turno intermedio: los deltas suman mas que la entrada reportada.
  const d = calcularDesgloseDeCache(
    { hit: 100000, nuevos: 20000, input_tokens: 30000 },
    { hit: 50000, nuevos: 10000 }
  );
  ok('si los deltas no cuadran, NO es exacto', d.exacto === false);
  ok('y dice por que', d.motivo === 'los_deltas_no_cuadran_con_la_entrada');
  ok('y no devuelve un numero que parezca bueno', d.cached_tokens === null);
  ok('pero deja los datos para poder investigarlo', d.suma_deltas === 60000 && d.entrada_reportada === 30000);
}

{
  // Contadores reiniciados: la sesion de Hermes se recreo.
  const d = calcularDesgloseDeCache(
    { hit: 500, nuevos: 100, input_tokens: 600 },
    { hit: 900000, nuevos: 50000 }
  );
  ok('un reinicio de contadores no se resta', d.exacto === false);
  ok('y se nombra como reinicio, no como descuadre', d.motivo === 'contadores_reiniciados');
}

{
  // Sin contadores: el guard todavia no los manda. Tiene que degradarse al rango,
  // no romperse.
  for (const actual of [{}, null, undefined, { hit: 'mucho', nuevos: 3 }, { hit: 3 }]) {
    const d = calcularDesgloseDeCache(actual, { hit: 0, nuevos: 0 });
    ok('sin contadores legibles no hay desglose (' + JSON.stringify(actual) + ')',
       d.exacto === false && d.cached_tokens === null);
  }
}

{
  // Un delta de cero en los dos: turno repetido o dedup. No es un error, pero el
  // porcentaje no se puede calcular sin dividir por cero.
  const d = calcularDesgloseDeCache({ hit: 100, nuevos: 50, input_tokens: 0 }, { hit: 100, nuevos: 50 });
  ok('deltas a cero siguen siendo exactos', d.exacto === true);
  ok('y el porcentaje es null, no NaN', d.porcentaje_cache === null);
}

// --- De donde se leen: state_patch, el unico objeto abierto -----------------
{
  const contrato = {
    message_for_client: 'Hola',
    state_patch: { pending_question: 'x', cache_acumulado_hit: 12345, cache_acumulado_nuevos: 678 }
  };
  const a = leerAcumuladosDelContrato(contrato);
  ok('se leen de state_patch', a.hit === 12345 && a.nuevos === 678);
}

{
  // Un contrato normal, sin los campos: no pasa nada.
  ok('un contrato sin los campos devuelve null',
     leerAcumuladosDelContrato({ state_patch: { pending_question: 'x' } }) === null);
  ok('y un contrato sin state_patch tampoco rompe',
     leerAcumuladosDelContrato({ message_for_client: 'Hola' }) === null);
  ok('ni un contrato nulo', leerAcumuladosDelContrato(null) === null);
}

{
  // Solo uno de los dos contadores no sirve: hacen falta los dos para restar.
  ok('con un solo contador no se puede calcular nada',
     leerAcumuladosDelContrato({ state_patch: { cache_acumulado_hit: 100 } }) === null);
}

console.log('\ntest_cache_delta: ' + pasados + '/' + pasados + ' PASS');
