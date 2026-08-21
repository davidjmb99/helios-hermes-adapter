/**
 * Cuánto vive una sesión de Hermes, y cuándo se empieza de cero.
 *
 * EL PROBLEMA, descubierto el 20 de agosto de 2026 después de perder media tarde.
 * Una sesión de Hermes duraba PARA SIEMPRE: una conversación abierta hace un mes
 * seguía arrastrando cada turno de ese mes en el contexto de hoy. Y Hermes reinyecta
 * ese historial en cada petición.
 *
 * Se pensaba que era un problema de coste —unos 42.000 tokens de entrada en una
 * conversación de WhatsApp— y con el 97% de acierto de caché el dinero era
 * despreciable. Resulta que el coste era lo de menos. EL MODELO SE IMITA A SÍ MISMO:
 *
 *   - Repetía «Calle de Velázquez 45, Madrid» leyéndola de sus propios mensajes
 *     cuatro semanas después de que ese dato desapareciera de todas partes.
 *   - Tuteaba en la conversación vieja y trataba de usted en una nueva, con el mismo
 *     prompt y en el mismo minuto.
 *   - Decía «hueco» después de que la palabra se quitara de todos los prompts.
 *   - Se negaba a dar la dirección porque en cuatro turnos anteriores se había
 *     negado.
 *
 * Una regla nueva del prompt es una línea. El historial son cuarenta mil tokens de
 * ejemplos de lo contrario. No hay prompt que gane esa pelea.
 *
 * POR QUÉ SE ARREGLA AQUÍ Y NO EN HERMES. La duplicación vive en
 * `_build_response_conversation_history`, que es runtime compartido por los tres
 * perfiles: parchearlo ahí se pierde en el siguiente redespliegue y puede tumbar a
 * default y meridian. Pero el Adapter es quien decide CUÁNTO VIVE una sesión, y eso
 * acota el daño sin tocar nada de aguas arriba.
 *
 * QUÉ NO SE PIERDE AL ROTAR, que es lo que hace esto seguro: la identidad del
 * paciente —nombre, apellidos, correo, teléfono, id de HubSpot— y el estado de la
 * conversación —`pending_question`, `pending_intent`, la cita en curso— los guarda el
 * Gateway en Supabase y VIAJAN EN CADA PETICIÓN. Rotar la sesión no le hace olvidar
 * a Helios quién es el paciente ni qué estaba haciendo. Solo le quita los ejemplos
 * de cómo hablaba antes.
 */

/**
 * Horas de inactividad tras las que se empieza de cero.
 *
 * Doce horas es «de un día para otro». Dentro de la misma jornada, seguir el hilo
 * literal de la conversación aporta: el paciente dice «entonces el martes» y esa
 * frase solo se entiende con lo anterior. Al día siguiente ya no: lo que importa
 * -quién es y qué quería- llega en el payload, y el resto son ejemplos viejos.
 *
 * Doce y no veinticuatro porque el turno de mañana de la clínica no debería heredar
 * el tono de una conversación de las once de la noche anterior.
 */
const HORAS_PARA_EMPEZAR_DE_CERO = 12;

/**
 * Tope de turnos de la sesión.
 *
 * AQUÍ HABÍA UN TECHO DE TOKENS Y ESTABA MAL CALIBRADO. Lo puse en 60.000 diciendo
 * que «una reserva normal de seis turnos va por 10.000 y no salta nunca». David lo
 * cuestionó y los datos de esa misma noche le dieron la razón:
 *
 *   conversación 82, LIMPIA     turno 1 ->  7.156
 *                               turno 2 ->  8.648
 *                               turno 3 -> 37.307   <- +28.659 de golpe
 *   conversación 75, CONTAMINADA  turno ~15 -> 42.274
 *
 * El salto del tercer turno es la herramienta de HubSpot: los esquemas y el resultado
 * entran en el contexto. O sea que una conversación de tres turnos SIN NADA DE
 * HISTORIAL pesa casi lo mismo que una envenenada de quince. Los tokens no distinguen
 * las dos cosas, y con 60.000 de techo una reserva real habría rotado a mitad de la
 * identificación del paciente. Justo lo que dije que no iba a pasar.
 *
 * LO QUE SÍ MIDE LA CONTAMINACIÓN SON LOS TURNOS, porque el daño es que el modelo
 * IMITA SUS PROPIAS RESPUESTAS ANTERIORES: cuantas más haya, más presión para
 * repetirlas. Una reserva completa son seis u ocho. Cuarenta no las alcanza ninguna
 * conversación legítima de una sola jornada.
 *
 * ES UN CIERRE DE SEGURIDAD QUE NO DEBERÍA SALTAR NUNCA. Lo que de verdad corta el
 * historial son las 12 horas de inactividad y el botón del panel. Esto solo cubre una
 * conversación que se pase el día entero dando vueltas, y ahí cuarenta turnos de
 * ejemplos propios hacen más daño que perder el hilo.
 *
 * Los tokens se siguen guardando -son útiles para ver el gasto y para diagnosticar-
 * pero no deciden nada.
 */
const TECHO_DE_TURNOS = 40;

/**
 * ¿Se sigue con la sesión guardada o se abre una nueva?
 *
 * @param fila La fila guardada de esta conversación, o null si no hay ninguna.
 *   { session_id, updated_at, ultimo_input_tokens, reset_pedido_at }
 * @param ahora Instante de referencia, en ms.
 * @returns {{ nueva: boolean, motivo: string, horas_inactiva: number|null }}
 */
function decidirSesion(fila, ahora) {
  const ahoraMs = ahora instanceof Date ? ahora.getTime() : Number(ahora);

  if (!fila || !fila.session_id) {
    return { nueva: true, motivo: "sin_sesion", horas_inactiva: null };
  }

  // EL RESET MANUAL GANA SOBRE TODO. Lo pide una persona desde el panel para probar
  // algo sin que el historial contamine, y si algo lo pudiera vetar el boton seria
  // mentira. Se compara con updated_at: un reset pedido ANTES del ultimo turno ya se
  // aplico y no puede volver a aplicarse en cada mensaje a partir de entonces.
  if (fila.reset_pedido_at) {
    const pedido = new Date(fila.reset_pedido_at).getTime();
    const ultimo = new Date(fila.updated_at || 0).getTime();
    if (Number.isFinite(pedido) && (!Number.isFinite(ultimo) || pedido > ultimo)) {
      return { nueva: true, motivo: "reset_manual", horas_inactiva: null };
    }
  }

  const ultimoMs = new Date(fila.updated_at || fila.created_at || 0).getTime();
  if (!Number.isFinite(ultimoMs) || ultimoMs <= 0) {
    // Una fila sin fecha legible no se puede juzgar. Se empieza de cero, que es el
    // lado seguro: seguir con una sesion de antiguedad desconocida es justo el fallo
    // que esto viene a arreglar.
    return { nueva: true, motivo: "fecha_ilegible", horas_inactiva: null };
  }

  const horasInactiva = Math.round((ahoraMs - ultimoMs) / 36_000) / 100;

  if (horasInactiva >= HORAS_PARA_EMPEZAR_DE_CERO) {
    return { nueva: true, motivo: "inactividad", horas_inactiva: horasInactiva };
  }

  const turnos = Number(fila.turnos);
  if (Number.isFinite(turnos) && turnos > TECHO_DE_TURNOS) {
    return { nueva: true, motivo: "demasiados_turnos", horas_inactiva: horasInactiva };
  }

  return { nueva: false, motivo: "vigente", horas_inactiva: horasInactiva };
}

module.exports = {
  decidirSesion,
  HORAS_PARA_EMPEZAR_DE_CERO,
  TECHO_DE_TURNOS
};
