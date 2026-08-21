/**
 * ¿Cuándo se empieza una conversación de cero?
 *
 * Lo que se protege, por orden de daño si falla:
 *  1. Que el RESET MANUAL siempre gane. Es un botón que aprieta una persona para
 *     poder probar algo sin el historial encima; si algo lo pudiera vetar, el botón
 *     sería mentira.
 *  2. Que un reset NO se aplique dos veces. Si se quedara pegado, cada mensaje de
 *     esa conversación abriría una sesión nueva para siempre y Helios no recordaría
 *     ni la frase anterior.
 *  3. Que dentro de la misma jornada NO se rote. «Entonces el martes» solo se
 *     entiende con lo de antes; cortar ahí rompe una reserva a medias.
 *  4. Que una conversación envenenada -la de 42.000 tokens que tuteaba y repetía la
 *     dirección de Madrid- sí se corte.
 */
const assert = require('assert');
const {
  decidirSesion,
  HORAS_PARA_EMPEZAR_DE_CERO,
  TECHO_DE_TOKENS_DE_ENTRADA
} = require('./sesiones.js');

let pasados = 0;
const ok = (etiqueta, condicion) => {
  assert.ok(condicion, 'FALLO: ' + etiqueta);
  pasados += 1;
  console.log('  PASS: ' + etiqueta);
};

const T0 = new Date('2026-08-21T15:00:00Z').getTime();
const haceHoras = (h) => new Date(T0 - h * 3600_000).toISOString();

// --- Sin fila: primera vez que escribe esta conversacion ---------------------
{
  const d = decidirSesion(null, T0);
  ok('sin fila se crea sesion', d.nueva === true && d.motivo === 'sin_sesion');
  ok('una fila sin session_id cuenta como sin sesion',
    decidirSesion({ updated_at: haceHoras(1) }, T0).motivo === 'sin_sesion');
}

// --- Dentro de la jornada NO se rota ----------------------------------------
{
  const d = decidirSesion({ session_id: 's1', updated_at: haceHoras(2), ultimo_input_tokens: 12000 }, T0);
  ok('dos horas despues se sigue con la misma sesion', d.nueva === false && d.motivo === 'vigente');
  ok('y se informa de cuanto lleva inactiva', d.horas_inactiva === 2);
}
{
  // El limite justo por debajo: a las 11h59 todavia no.
  const d = decidirSesion({ session_id: 's1', updated_at: haceHoras(11.9), ultimo_input_tokens: 100 }, T0);
  ok('a las 11h54 todavia no se rota', d.nueva === false);
}

// --- De un dia para otro si -------------------------------------------------
{
  const d = decidirSesion({ session_id: 's1', updated_at: haceHoras(HORAS_PARA_EMPEZAR_DE_CERO), ultimo_input_tokens: 100 }, T0);
  ok('a las 12 exactas se empieza de cero', d.nueva === true && d.motivo === 'inactividad');
}
{
  const d = decidirSesion({ session_id: 's1', updated_at: haceHoras(24 * 30), ultimo_input_tokens: 100 }, T0);
  ok('una conversacion de hace un mes no arrastra nada', d.nueva === true && d.motivo === 'inactividad');
}

// --- El techo de contexto ----------------------------------------------------
{
  // La conversacion 75 del 20-ago: 42.274 tokens y contando. Todavia por debajo.
  const d = decidirSesion({ session_id: 's1', updated_at: haceHoras(1), ultimo_input_tokens: 42274 }, T0);
  ok('42.274 tokens aun no cruzan el techo', d.nueva === false);
}
{
  const d = decidirSesion(
    { session_id: 's1', updated_at: haceHoras(1), ultimo_input_tokens: TECHO_DE_TOKENS_DE_ENTRADA + 1 },
    T0
  );
  ok('pasado el techo se empieza de cero', d.nueva === true && d.motivo === 'contexto_demasiado_grande');
}
{
  // EN EL TECHO EXACTO NO SE ROTA. El corte es «mas que», no «al menos», para que el
  // turno que lo cruza se atienda con la sesion vieja y el siguiente empiece limpio.
  const d = decidirSesion(
    { session_id: 's1', updated_at: haceHoras(1), ultimo_input_tokens: TECHO_DE_TOKENS_DE_ENTRADA },
    T0
  );
  ok('en el techo exacto todavia no', d.nueva === false);
}
{
  // Sin cifra del turno anterior -primer turno de una sesion nueva- no se puede
  // juzgar por tamaño, y eso no puede provocar una rotacion.
  const d = decidirSesion({ session_id: 's1', updated_at: haceHoras(1), ultimo_input_tokens: null }, T0);
  ok('sin cifra de tokens no se rota por tamaño', d.nueva === false && d.motivo === 'vigente');
}

// --- EL RESET MANUAL --------------------------------------------------------
{
  // Pedido despues del ultimo turno: se aplica, aunque la sesion este fresquisima y
  // el contexto sea pequeño.
  const d = decidirSesion(
    { session_id: 's1', updated_at: haceHoras(3), ultimo_input_tokens: 500, reset_pedido_at: haceHoras(0.1) },
    T0
  );
  ok('un reset pedido hace seis minutos se aplica', d.nueva === true && d.motivo === 'reset_manual');
}
{
  // EL CASO QUE IMPORTA: pedido ANTES del ultimo turno, o sea ya aplicado. Si esto
  // fallara, la conversacion abriria una sesion nueva en CADA mensaje y Helios no
  // recordaria ni la frase anterior. Seria peor que el problema original.
  const d = decidirSesion(
    { session_id: 's2', updated_at: haceHoras(1), ultimo_input_tokens: 900, reset_pedido_at: haceHoras(5) },
    T0
  );
  ok('un reset ya aplicado no se repite', d.nueva === false && d.motivo === 'vigente');
}
{
  // Y gana sobre el techo de tokens: los dos dicen «rota», pero el motivo que se
  // registra tiene que ser el humano, que es el que explica por que.
  const d = decidirSesion(
    {
      session_id: 's1', updated_at: haceHoras(1),
      ultimo_input_tokens: TECHO_DE_TOKENS_DE_ENTRADA + 5000,
      reset_pedido_at: haceHoras(0.2)
    },
    T0
  );
  ok('el reset manual se registra como tal, no como tamaño', d.motivo === 'reset_manual');
}
{
  const d = decidirSesion({ session_id: 's1', updated_at: haceHoras(1), reset_pedido_at: 'no-es-una-fecha' }, T0);
  ok('un reset con fecha basura no rota nada', d.nueva === false);
}

// --- Fechas imposibles: el lado seguro es empezar de cero -------------------
{
  ok('sin fecha se empieza de cero',
    decidirSesion({ session_id: 's1' }, T0).motivo === 'fecha_ilegible');
  ok('con fecha ilegible tambien',
    decidirSesion({ session_id: 's1', updated_at: 'ayer por la tarde' }, T0).motivo === 'fecha_ilegible');
}
{
  // Reloj adelantado: updated_at en el futuro. Da horas negativas, que no llegan al
  // umbral, asi que se sigue con la sesion. Es lo correcto: una sesion del futuro es
  // un problema de reloj, no una sesion vieja.
  const d = decidirSesion({ session_id: 's1', updated_at: new Date(T0 + 3600_000).toISOString() }, T0);
  ok('una fecha en el futuro no rota', d.nueva === false);
}

console.log('test_sesiones: ' + pasados + ' comprobaciones OK');
