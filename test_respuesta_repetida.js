/**
 * ¿Se detecta una respuesta reciclada del historial?
 *
 * Los tres casos son REALES, del 19-ago-2026: Darliana, David Mercado y Antonella
 * recibieron el saludo del principio como si fuera una respuesta nueva, pidiendo
 * datos que Helios ya tenia.
 *
 * Lo que se protege, y el segundo importa tanto como el primero:
 *  1. Que una repeticion literal de la respuesta anterior se detecte.
 *  2. Que una cortesia corta repetida NO se marque: «Perfecto, nos vemos» puede
 *     decirse dos veces y no es un bucle.
 */
const assert = require('assert');
const { esRepeticionDeLaAnterior, LARGO_MINIMO } = require('./respuesta-repetida.js');

let n = 0;
const ok = (etiqueta, cond) => { assert.ok(cond, 'FALLO: ' + etiqueta); n += 1; console.log('  PASS: ' + etiqueta); };

const SALUDO = '¡Hola! Claro, te ayudo a agendar una cita. Para poder reservarte el turno '
  + 'necesito que me digas tu nombre y apellidos y un correo electrónico de contacto. ¿Me los pasas?';

// --- El caso real ------------------------------------------------------------
{
  const r = esRepeticionDeLaAnterior(SALUDO, SALUDO);
  ok('el saludo repetido se detecta', r.repetida === true);
  ok('y se nombra el motivo', r.motivo === 'identica_a_la_respuesta_anterior');
}

{
  // Diferencias de espacios o mayusculas no lo hacen distinto: sigue siendo el mismo
  // mensaje para el paciente.
  const r = esRepeticionDeLaAnterior(SALUDO.toUpperCase().replace(/ /g, '  '), SALUDO);
  ok('los espacios y las mayusculas no disfrazan una repeticion', r.repetida === true);
}

// --- Lo que NO debe marcarse -------------------------------------------------
{
  const r = esRepeticionDeLaAnterior(
    'Perfecto, Darliana. Te espero el lunes 24 a las 10:00.',
    SALUDO
  );
  ok('una respuesta distinta pasa', r.repetida === false);
}

{
  // Cortesias cortas: repetirlas es normal y humano.
  for (const corta of ['Perfecto.', 'De nada, hasta luego.', '¡Gracias a ti!', 'Sí, claro.']) {
    const r = esRepeticionDeLaAnterior(corta, corta);
    ok('cortesia corta repetida no se marca: "' + corta + '"', r.repetida === false);
  }
}

{
  // Justo en el limite: por debajo no se juzga, por encima si.
  const casi = 'a'.repeat(LARGO_MINIMO - 1);
  const justo = 'a'.repeat(LARGO_MINIMO);
  ok('por debajo del minimo no se juzga', esRepeticionDeLaAnterior(casi, casi).repetida === false);
  ok('en el minimo si se juzga', esRepeticionDeLaAnterior(justo, justo).repetida === true);
}

{
  // Sin anterior con que comparar no se puede afirmar nada. Es el primer turno de
  // cualquier conversacion, y marcarlo seria bloquear el saludo legitimo.
  for (const anterior of [null, undefined, '', '   ']) {
    ok('sin respuesta anterior no se marca (' + JSON.stringify(anterior) + ')',
       esRepeticionDeLaAnterior(SALUDO, anterior).repetida === false);
  }
}

{
  // Y una respuesta vacia tampoco: de eso se ocupa la validacion del contrato.
  ok('respuesta vacia no se marca aqui', esRepeticionDeLaAnterior('', SALUDO).repetida === false);
}

console.log('\ntest_respuesta_repetida: ' + n + '/' + n + ' PASS');
