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
 * Tope de tokens de entrada del último turno.
 *
 * Es un techo, no un objetivo: en una conversación normal de reserva -seis turnos-
 * se llega a unos 10.000 y esto no salta nunca. Salta en las patológicas, que son
 * justo las que envenenan al modelo. La conversación 75 del 20 de agosto iba por
 * 42.000 después de unos quince turnos.
 *
 * SE MIDE EL TURNO ANTERIOR, no el actual, porque cuando hay que decidir la sesión
 * todavía no se ha llamado a nadie y no hay cifra del turno en curso. Con 60.000 de
 * techo, el turno que lo cruza se atiende con la sesión vieja y el siguiente ya
 * empieza limpio. Un turno de más con contexto grande no rompe nada; cortar a mitad
 * de una frase del paciente, sí.
 */
const TECHO_DE_TOKENS_DE_ENTRADA = 60000;

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

  const tokens = Number(fila.ultimo_input_tokens);
  if (Number.isFinite(tokens) && tokens > TECHO_DE_TOKENS_DE_ENTRADA) {
    return { nueva: true, motivo: "contexto_demasiado_grande", horas_inactiva: horasInactiva };
  }

  return { nueva: false, motivo: "vigente", horas_inactiva: horasInactiva };
}

module.exports = {
  decidirSesion,
  HORAS_PARA_EMPEZAR_DE_CERO,
  TECHO_DE_TOKENS_DE_ENTRADA
};
