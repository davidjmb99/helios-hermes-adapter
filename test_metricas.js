/**
 * Las métricas de gasto y de mensajes.
 *
 * Lo que se protege, por orden de daño si falla:
 *  1. QUE UN TOTAL INCOMPLETO NO PAREZCA COMPLETO. Es un número que se usa para
 *     decidir: si se dejan turnos fuera en silencio, la decisión se toma sobre una
 *     cifra falsa. Misma regla que en cache-delta.js.
 *  2. Que «saliente» signifique que al paciente LE LLEGÓ algo. Un turno que se
 *     completa pero no se envía —contrato inválido, respuesta reciclada— pintaría un
 *     sistema más sano de lo que es.
 *  3. Que los turnos sin tokens no ensucien la cuenta: un duplicado frenado no cuesta
 *     nada y tampoco es un turno «sin valorar».
 */
const assert = require('assert');
const {
  PERIODOS, esPeriodoValido, inicioDelPeriodo, resumirEventos, resumirMedia
} = require('./metricas.js');

let pasados = 0;
const ok = (etiqueta, condicion) => {
  assert.ok(condicion, 'FALLO: ' + etiqueta);
  pasados += 1;
  console.log('  PASS: ' + etiqueta);
};

// El modelo real de Helios, para que el catalogo de precios lo encuentre.
const MODELO = 'deepseek-v4-flash';
const AHORA = new Date('2026-08-21T18:00:00Z');

const turno = (over = {}) => ({
  created_at: '2026-08-21T12:00:00Z',
  status: 'completed',
  safe_to_send: true,
  input_tokens: 40000,
  output_tokens: 300,
  cache_read_tokens: 39000,
  model: MODELO,
  ...over
});

// --- Los periodos -----------------------------------------------------------
{
  ok('estan los seis periodos que pidio David',
    ['dia', 'semana', 'mes', '3meses', '6meses', 'ano'].every(p => esPeriodoValido(p)));
  ok('y no se acepta cualquier cosa', !esPeriodoValido('decada') && !esPeriodoValido(''));

  const desde = inicioDelPeriodo('semana', AHORA);
  ok('una semana son siete dias hacia atras',
    Math.round((AHORA.getTime() - desde.getTime()) / 86400000) === 7);
  ok('un periodo inventado no da fecha', inicioDelPeriodo('decada', AHORA) === null);
}

// --- Contar mensajes: entrantes y salientes NO son lo mismo -----------------
{
  const r = resumirEventos([
    turno(),
    turno(),
    // Se completo pero NO se envio: contrato invalido. Entra, no sale.
    turno({ status: 'completed', safe_to_send: false }),
    // Duplicado frenado: entra, no sale, y no costo nada.
    turno({ status: 'deduplicated', safe_to_send: false, input_tokens: 0, output_tokens: 0, cache_read_tokens: 0 }),
    // Fallo tecnico.
    turno({ status: 'failed_recoverable', safe_to_send: false })
  ]);

  ok('entran los cinco turnos', r.entrantes === 5);
  ok('EL CASO 2: solo salen los dos que de verdad llegaron al paciente', r.salientes === 2);
  ok('el completado sin enviar NO cuenta como saliente', r.salientes !== 3);
  ok('los fallos se cuentan aparte', r.fallidos === 1);
  ok('y los duplicados frenados tambien', r.deduplicados === 1);
}

// --- La suma de tokens ------------------------------------------------------
{
  const r = resumirEventos([
    turno({ input_tokens: 1000, output_tokens: 100, cache_read_tokens: 900 }),
    turno({ input_tokens: 3000, output_tokens: 200, cache_read_tokens: 2700 })
  ]);
  ok('los tokens de entrada se suman', r.input_tokens === 4000);
  ok('los de salida tambien', r.output_tokens === 300);
  ok('los cacheados tambien', r.cached_tokens === 3600);
  ok('y el total es la suma de entrada y salida', r.total_tokens === 4300);
  ok('el acierto de cache es 3600 de 4000', r.acierto_cache_pct === 90);
}

// --- EL CASO 1: un total incompleto NO puede parecer completo ---------------
{
  const r = resumirEventos([
    turno(),
    // Modelo desconocido: el catalogo no sabe cuanto cuesta.
    turno({ model: 'un-modelo-que-no-existe' })
  ]);

  ok('el turno valorable se valora', r.turnos_valorados === 1);
  ok('y el otro se cuenta como no valorado', r.turnos_sin_valorar === 1);
  ok('EL CASO 1: y el total se marca como INCOMPLETO', r.coste_completo === false);
  ok('con el motivo agrupado, para saber por que',
    r.motivos_sin_valorar.modelo_desconocido === 1);
  ok('el coste que si se pudo calcular se conserva', r.coste_usd > 0);
}
{
  const r = resumirEventos([turno(), turno()]);
  ok('con todo valorable, el total SI es completo', r.coste_completo === true);
  ok('y no hay turnos sin valorar', r.turnos_sin_valorar === 0);
}

// --- EL CASO 3: los turnos sin tokens no ensucian la cuenta ----------------
{
  const r = resumirEventos([
    turno(),
    turno({ status: 'deduplicated', safe_to_send: false, input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, model: null })
  ]);
  ok('un turno sin tokens no cuenta como «sin valorar»', r.turnos_sin_valorar === 0);
  ok('y por tanto el total sigue siendo completo', r.coste_completo === true);
}

// --- El coste por mensaje enviado, que es la cifra que se usa para decidir --
{
  const r = resumirEventos([turno(), turno(), turno({ status: 'failed', safe_to_send: false })]);
  // La tolerancia es 1e-6 porque coste_por_saliente se redondea a la millonesima:
  // compararlo con 1e-9 comparaba contra una precision que el valor no tiene.
  //
  // Y OJO CON LO QUE SE DIVIDE: el coste incluye el turno que fallo, porque ese gasto
  // ocurrio de verdad. Repartirlo entre los mensajes que SI llegaron es la cifra
  // honesta: cuanto cuesta atender a un paciente, fallos incluidos.
  ok('el coste por saliente divide entre los que LLEGARON, no entre los turnos',
    r.salientes === 2 && Math.abs(r.coste_por_saliente - r.coste_usd / 2) < 1e-6);
}
{
  const r = resumirEventos([turno({ status: 'failed', safe_to_send: false })]);
  ok('sin ningun saliente NO se divide entre cero: se dice que no hay dato',
    r.coste_por_saliente === null);
}

// --- Nada que resumir -------------------------------------------------------
{
  const r = resumirEventos([]);
  ok('sin eventos todo va a cero', r.entrantes === 0 && r.salientes === 0 && r.coste_usd === 0);
  ok('sin tokens no se inventa un acierto de cache', r.acierto_cache_pct === null);
  ok('y un periodo vacio se considera completo: no falta nada por valorar',
    r.coste_completo === true);
  ok('una entrada que no es una lista no rompe', resumirEventos(null).entrantes === 0);
}

// --- El modelo de respaldo --------------------------------------------------
{
  // Filas viejas guardadas antes de que se registrara el modelo. Con el respaldo
  // configurado se pueden valorar; sin el, se cuentan como no valoradas y se dice.
  const conRespaldo = resumirEventos([turno({ model: null })], MODELO);
  ok('con modelo de respaldo, una fila sin modelo se valora', conRespaldo.turnos_valorados === 1);

  const sinRespaldo = resumirEventos([turno({ model: null })], null);
  ok('sin respaldo se cuenta como no valorada', sinRespaldo.turnos_sin_valorar === 1);
  ok('y el total se marca incompleto', sinRespaldo.coste_completo === false);
}

// ============================================================================
// LOS ARCHIVOS: resumirMedia
// ============================================================================
//
// LO QUE SE PROTEGE, por orden de daño si falla:
//
//  1. QUE LOS IGNORADOS SE CUENTEN. Un archivo «ignorado» es un mensaje de un paciente
//     que NO recibio respuesta a proposito. Es la unica decision de Helios que produce
//     SILENCIO, y un paciente al que no se contesta no se queja: se va. Este contador es
//     el unico sitio del sistema donde eso se ve.
//
//  2. QUE EL AUDIO SE VALORE COMO AUDIO. Cuesta el triple; a precio de texto el panel
//     diria un tercio del gasto real.
//
//  3. QUE EL GASTO DE LO IGNORADO SE SUME IGUAL. Cuesta dinero y no genera respuesta:
//     si no se contara, seria gasto invisible.
//
//  4. Que el nivel gratuito se cuente de las FILAS. Es lo que contesta «cuantos archivos
//     de pacientes pasaron por ahi», que una variable de entorno no contesta.

{
  const archivo = (over = {}) => ({
    created_at: '2026-08-24T12:00:00Z',
    tipo: 'audio', accion: 'seguir', modelo: 'gemini-2.5-flash-lite', nivel: 'gratuito',
    input_tokens: 960, output_tokens: 20, error: null, ...over
  });

  // 1 y 3. UN ARCHIVO IGNORADO SE CUENTA Y SE PAGA.
  const conIgnorado = resumirMedia([
    archivo({ tipo: 'video', accion: 'ignorar', input_tokens: 8000, output_tokens: 10 })
  ]);
  ok('un archivo ignorado se cuenta', conIgnorado.ignorados === 1);
  ok('y NO como seguido', conIgnorado.seguidos === 0);
  ok(
    'y su gasto se suma igual: ignorar es no contestar, no que sea gratis',
    conIgnorado.coste_usd > 0 && conIgnorado.archivos_valorados === 1
  );

  // 2. EL AUDIO SE VALORA COMO AUDIO.
  const soloAudio = resumirMedia([archivo()]);
  const soloImagen = resumirMedia([archivo({ tipo: 'imagen' })]);
  ok(
    'el audio cuesta casi el triple que la misma cantidad de tokens de imagen',
    soloAudio.coste_usd > soloImagen.coste_usd * 2.5
  );
  ok('y el de imagen tambien se valora', soloImagen.archivos_valorados === 1);

  // 4. EL NIVEL SE CUENTA DE LAS FILAS.
  const mezclado = resumirMedia([
    archivo({ nivel: 'gratuito' }),
    archivo({ nivel: 'gratuito' }),
    archivo({ nivel: 'pago' })
  ]);
  ok('el nivel gratuito se cuenta por filas', mezclado.en_nivel_gratuito === 2);
  ok('y el total de archivos no se confunde con el', mezclado.archivos === 3);

  // El reparto por tipo y por accion.
  const todo = resumirMedia([
    archivo({ tipo: 'audio', accion: 'seguir' }),
    archivo({ tipo: 'imagen', accion: 'derivar' }),
    archivo({ tipo: 'video', accion: 'ignorar' }),
    archivo({ tipo: 'documento', accion: 'seguir' }),
    archivo({ tipo: 'audio', accion: 'sin_procesar', input_tokens: 0, output_tokens: 0, error: 'gemini_rechaza_el_codec' })
  ]);
  ok('reparto por tipo', todo.por_tipo.audio === 2 && todo.por_tipo.imagen === 1
    && todo.por_tipo.video === 1 && todo.por_tipo.documento === 1);
  ok('reparto por accion', todo.seguidos === 2 && todo.derivados === 1
    && todo.ignorados === 1 && todo.fallidos === 1);

  // UN ARCHIVO RECHAZADO ANTES DE LLAMAR no gasto nada, y NO cuenta como «sin valorar»:
  // valorarlo daria cero igual, y marcarlo dejaria el total en incompleto para siempre
  // por algo que no cuesta.
  ok('un archivo sin tokens no ensucia el total', todo.coste_completo === true);
  ok('y no se cuenta como sin valorar', todo.archivos_sin_valorar === 0);
  ok('los cuatro que gastaron si se valoraron', todo.archivos_valorados === 4);

  // UN MODELO DESCONOCIDO SI deja el total incompleto, y se dice.
  const raro = resumirMedia([archivo({ modelo: 'gemini-inventado-9' })]);
  ok('un modelo sin tarifa deja el total incompleto', raro.coste_completo === false);
  ok('con su motivo apuntado', !!raro.motivos_sin_valorar.modelo_desconocido);
  ok('y sin sumar nada al coste', raro.coste_usd === 0);

  // Sin filas, todo a cero y completo: no hay nada que no se sepa.
  const vacio = resumirMedia([]);
  ok('sin archivos, cero y completo', vacio.archivos === 0 && vacio.coste_completo === true);
  ok('y aguanta basura', resumirMedia(null).archivos === 0);
}

console.log('test_metricas: ' + pasados + ' comprobaciones OK');
