/**
 * ¿Es esta respuesta la de ahora, o una vieja que se ha colado?
 *
 * EL FALLO, con nombre y fecha. El 19 de agosto de 2026, tres pacientes recibieron
 * el saludo del principio de la conversación como si fuera una respuesta nueva:
 *
 *   Darliana, tras decir «un dolor de muela»
 *   David Mercado, tras decir «el sábado a las 2pm»
 *   Antonella, tras decir «el martes me parece perfecto»
 *
 * A los tres, Helios les contestó «¡Hola! Claro, te ayudo a agendar una cita. Para
 * poder reservarte el turno necesito que me digas tu nombre y apellidos…» — pidiendo
 * datos que ya tenía. David tuvo que responder «ya te di mi nombre esos datos».
 *
 * LA CAUSA. extractResponseOutputText recorre `output[]` y recoge TODOS los mensajes
 * del asistente. Cuando el turno no produce mensaje final —y la auditoría de Hermes
 * confirmó que en esos tres turnos no lo hubo— el `output[]` solo contiene mensajes
 * VIEJOS del historial reinyectado por compactación. El extractor encuentra ahí un
 * contrato perfectamente válido, y el Adapter lo entrega como si fuera de ahora.
 *
 * Y no lo frenaba nada: la clave del outbox se deriva del contenido MÁS los mensajes
 * de origen, así que el mismo texto con un mensaje distinto del paciente produce una
 * clave distinta y se envía otra vez.
 *
 * POR QUÉ SE COMPARA CON LA ANTERIOR Y NO SE ARREGLA EL EXTRACTOR. Se podría coger
 * solo el último mensaje del array en vez de todos, y ayudaría — pero no resuelve el
 * caso: si el turno no generó nada, el último sigue siendo uno viejo. Lo que de
 * verdad distingue una respuesta nueva de una reciclada es que sea DISTINTA de la
 * que ya se envió. Eso es un hecho comprobable, no una suposición sobre la forma de
 * la respuesta.
 *
 * Y ES CONSERVADOR A PROPÓSITO: solo se rechaza la repetición LITERAL de la última
 * respuesta enviada en esa misma conversación. Un paciente puede preguntar dos veces
 * lo mismo y merecer la misma contestación, pero eso ocurre separado por otras
 * respuestas; repetir palabra por palabra la inmediatamente anterior no es una
 * conversación, es un bucle.
 */

/** Normaliza para comparar: los espacios y el caso no hacen distinta una respuesta. */
function comparable(texto) {
  return String(texto ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/**
 * Longitud mínima para que una repetición cuente como sospechosa.
 *
 * «Perfecto.» o «De nada.» pueden repetirse legítimamente y no dicen nada malo. Un
 * párrafo entero idéntico al anterior sí. Ochenta caracteres deja fuera las
 * cortesías y coge los mensajes con contenido.
 */
const LARGO_MINIMO = 80;

/**
 * @param respuestaAhora   El texto que se iba a enviar en este turno.
 * @param respuestaAnterior La última respuesta enviada en esta conversación, o null.
 * @returns {{repetida: boolean, motivo: string|null}}
 */
function esRepeticionDeLaAnterior(respuestaAhora, respuestaAnterior) {
  const ahora = comparable(respuestaAhora);
  const antes = comparable(respuestaAnterior);

  if (!ahora || !antes) return { repetida: false, motivo: null };
  if (ahora.length < LARGO_MINIMO) return { repetida: false, motivo: "demasiado_corta_para_juzgar" };
  if (ahora !== antes) return { repetida: false, motivo: null };

  return { repetida: true, motivo: "identica_a_la_respuesta_anterior" };
}

module.exports = { esRepeticionDeLaAnterior, comparable, LARGO_MINIMO };
