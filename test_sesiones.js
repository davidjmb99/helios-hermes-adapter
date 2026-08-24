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
  TECHO_DE_TURNOS
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
  // ESTA ASERCION AFIRMABA EL FALLO, y por eso no lo caz'o. Decia que una fila sin
  // session_id cuenta como «sin sesion», y en agent_api -el transporte de produccion-
  // NUNCA hay session_id: la conversacion se identifica con una cadena y abrirNueva
  // guarda null a proposito. Con esa regla se abria una generacion nueva EN CADA
  // MENSAJE, y el paciente perdia el hilo entre una frase y la siguiente.
  //
  // LA SEÑAL CORRECTA ES QUE LA FILA EXISTA.
  ok('EL FALLO: una fila SIN session_id es una sesion valida, porque en agent_api no hay',
    decidirSesion({ updated_at: haceHoras(1), turnos: 1, generacion: 0 }, T0).nueva === false);
  ok('y se sigue con ella, no se abre otra',
    decidirSesion({ updated_at: haceHoras(1), turnos: 1, generacion: 0 }, T0).motivo === 'vigente');
}

// --- Dentro de la jornada NO se rota ----------------------------------------
{
  const d = decidirSesion({ session_id: 's1', updated_at: haceHoras(2), turnos: 4, ultimo_input_tokens: 12000 }, T0);
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

// --- El techo de turnos -----------------------------------------------------
//
// AQUI HABIA UN TECHO DE TOKENS Y ESTABA MAL. Lo puse en 60.000 afirmando que «una
// reserva normal de seis turnos va por 10.000». David lo cuestiono y los datos de esa
// misma noche le dieron la razon:
//
//   conversacion 82, LIMPIA        turno 3 -> 37.307   (+28.659 de golpe, HubSpot)
//   conversacion 75, CONTAMINADA   turno ~15 -> 42.274
//
// Una conversacion de tres turnos SIN HISTORIAL pesa casi lo mismo que una envenenada
// de quince: el salto es de los esquemas y resultados de las herramientas. Los tokens
// no distinguen las dos cosas y con 60.000 de techo una reserva real habria rotado en
// mitad de la identificacion del paciente.
//
// Lo que si mide la contaminacion son los TURNOS: el daño es que el modelo imita sus
// propias respuestas anteriores, y cuantas mas haya, mas presion para repetirlas.

{
  // EL CASO QUE LO MOTIVA: una reserva real, tercer turno, 37.307 tokens por HubSpot.
  // NO puede rotar. Si rota, el paciente acaba de dar su correo y Helios lo olvida.
  const d = decidirSesion(
    { session_id: 's1', updated_at: haceHoras(0.2), turnos: 3, ultimo_input_tokens: 37307 },
    T0
  );
  ok('una reserva real de 37.307 tokens en el turno 3 NO rota', d.nueva === false);
}
{
  // ESTE ES EL CASO QUE DE VERDAD CAZA EL TECHO VIEJO, y la primera version de esta
  // prueba no lo tenia: con 37.307 no se notaba nada, porque 37.307 < 60.000. Hacia
  // falta un turno legitimo POR ENCIMA del techo que puse.
  //
  // La conversacion 66 -reserva completa, seis turnos- gasto 246.075 tokens en total.
  // Como el contexto crece turno a turno, sus ultimos turnos estan en la franja de los
  // 55.000-60.000, y una reserva de siete turnos la cruza. Con el techo de tokens, esa
  // reserva rotaba a mitad de la confirmacion de la cita.
  const d = decidirSesion(
    { session_id: 's1', updated_at: haceHoras(0.3), turnos: 7, ultimo_input_tokens: 61000 },
    T0
  );
  ok('una reserva legitima de 61.000 tokens en el turno 7 NO rota', d.nueva === false);
}
{
  // Y la contaminada de 42.274 tampoco rota por tamaño: la corta la inactividad, que
  // es lo que de verdad la distingue.
  const d = decidirSesion(
    { session_id: 's1', updated_at: haceHoras(1), turnos: 15, ultimo_input_tokens: 42274 },
    T0
  );
  ok('42.274 tokens tampoco rotan por si solos', d.nueva === false);
}
{
  const d = decidirSesion(
    { session_id: 's1', updated_at: haceHoras(1), turnos: TECHO_DE_TURNOS + 1 },
    T0
  );
  ok('pasados los 40 turnos se empieza de cero', d.nueva === true && d.motivo === 'demasiados_turnos');
}
{
  // EN EL TECHO EXACTO NO SE ROTA. El corte es «mas que», no «al menos».
  const d = decidirSesion({ session_id: 's1', updated_at: haceHoras(1), turnos: TECHO_DE_TURNOS }, T0);
  ok('en el turno 40 exacto todavia no', d.nueva === false);
}
{
  // Sin contador de turnos no se puede juzgar, y eso no puede provocar una rotacion.
  const d = decidirSesion({ session_id: 's1', updated_at: haceHoras(1), turnos: null }, T0);
  ok('sin contador de turnos no se rota', d.nueva === false && d.motivo === 'vigente');
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
      turnos: TECHO_DE_TURNOS + 5,
      reset_pedido_at: haceHoras(0.2)
    },
    T0
  );
  ok('el reset manual se registra como tal, no como los turnos', d.motivo === 'reset_manual');
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

// --- EL INTERRUPTOR DE EMERGENCIA -------------------------------------------
//
// HELIOS_ROTAR_SESIONES=off apaga la rotacion AUTOMATICA sin desplegar nada. Existe
// porque era la unica pieza del 20-ago sin apagado por variable: la direccion se vacia
// en el panel, el reloj de atencion tiene su ajuste, el handoff su flag, y esta
// obligaba a un redeploy al commit anterior —llevandose por delante el almacen durable
// y el backend del boton, que no tienen nada que ver—.

{
  const antes = process.env.HELIOS_ROTAR_SESIONES;
  process.env.HELIOS_ROTAR_SESIONES = 'off';

  // Lo que el interruptor SI apaga.
  ok('apagado, la inactividad no rota',
    decidirSesion({ session_id: 's1', updated_at: haceHoras(24 * 30) }, T0).nueva === false);
  ok('apagado, el motivo lo dice',
    decidirSesion({ session_id: 's1', updated_at: haceHoras(24 * 30) }, T0).motivo === 'rotacion_apagada');
  ok('apagado, el techo de turnos tampoco rota',
    decidirSesion({ session_id: 's1', updated_at: haceHoras(1), turnos: 500 }, T0).nueva === false);

  // LO QUE NO PUEDE APAGAR, y es la mitad del sentido de esta prueba.
  //
  // 1. El reset manual. Lo pide una persona desde el panel para poder probar algo. Si
  //    una variable pudiera vetarlo, el boton seria una mentira, y ya tuvimos un panel
  //    que respondia «hecho» sin hacer nada.
  ok('apagado, el reset manual SIGUE funcionando',
    decidirSesion(
      { session_id: 's1', updated_at: haceHoras(3), reset_pedido_at: haceHoras(0.1) }, T0
    ).motivo === 'reset_manual');

  // 2. Abrir la primera sesion de una conversacion. Si esto se apagara, una
  //    conversacion nueva no tendria sesion y no se podria contestar a nadie.
  ok('apagado, una conversacion sin sesion sigue abriendo una',
    decidirSesion(null, T0).nueva === true);

  // Y CUALQUIER VALOR QUE NO SEA «off» DEJA LA ROTACION ENCENDIDA. Una variable mal
  // escrita no puede apagar una proteccion en silencio.
  for (const valor of ['on', 'OFF ', '', 'no', 'false', '0', 'apagado']) {
    process.env.HELIOS_ROTAR_SESIONES = valor;
    const rota = decidirSesion({ session_id: 's1', updated_at: haceHoras(24) }, T0).nueva;
    // «OFF » con espacio y mayusculas SI cuenta: se normaliza. El resto, no.
    const deberiaApagar = valor.trim().toLowerCase() === 'off';
    ok(`con HELIOS_ROTAR_SESIONES="${valor}" la rotacion ${deberiaApagar ? 'esta apagada' : 'sigue encendida'}`,
      rota === !deberiaApagar);
  }

  delete process.env.HELIOS_ROTAR_SESIONES;
  ok('sin la variable, la rotacion esta encendida',
    decidirSesion({ session_id: 's1', updated_at: haceHoras(24) }, T0).nueva === true);

  if (antes === undefined) delete process.env.HELIOS_ROTAR_SESIONES;
  else process.env.HELIOS_ROTAR_SESIONES = antes;
}

console.log('test_sesiones: ' + pasados + ' comprobaciones OK');
