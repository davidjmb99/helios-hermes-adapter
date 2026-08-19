/**
 * El desglose de caché de UN turno, a partir de contadores acumulados.
 *
 * POR QUE ESTO EXISTE. La entrada cacheada cuesta $0.007 por millón y la nueva
 * $0.22: treinta y una veces más. Sin saber cuánta entrada vino de caché, el coste
 * de un turno solo se puede dar como rango — para un turno real de 126.601 tokens,
 * entre $0.001263 y $0.028229. Veintidós veces de diferencia. Con eso no se puede
 * decidir nada, ni saber cuánto cuesta de verdad una conversación.
 *
 * DeepSeek sí manda el desglose. Hermes sí lo guarda. Pero lo guarda ACUMULADO POR
 * SESIÓN, y su endpoint lo descarta al serializar la respuesta. Exponerlo por
 * respuesta exigiría tocar el runtime que comparten los tres perfiles, y eso está
 * fuera de límites por una razón buena: un parche ahí se pierde en el siguiente
 * despliegue y puede tumbar a las otras dos clínicas.
 *
 * LA SALIDA, y es exacta y no una estimación: si el guard del perfil helios manda
 * los CONTADORES ACUMULADOS en cada turno, la resta entre dos turnos consecutivos
 * de la misma sesión ES el desglose de ese turno. Aritmética, no adivinanza.
 *
 * Y LO MEJOR: trae su propia verificación. La suma de los dos deltas tiene que
 * coincidir con los input_tokens que el propio turno reporta. Si coincide, el
 * desglose es correcto por construcción. Si no coincide —porque se perdió un turno,
 * porque la sesión se reinició, porque Hermes cambió cómo cuenta— NO se afirma nada
 * y se vuelve al rango. Un coste exacto equivocado es peor que un rango honesto.
 */

/** Cuántos tokens de diferencia se toleran en la comprobación. */
const TOLERANCIA_TOKENS = 0;

function entero(valor) {
  const n = Number(valor);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : null;
}

/**
 * Calcula el desglose del turno actual.
 *
 * @param actual   {hit, nuevos, input_tokens} acumulados que reporta ESTE turno, y
 *                 la entrada lógica del turno según el propio proveedor.
 * @param anterior {hit, nuevos} acumulados del turno ANTERIOR de la misma sesión,
 *                 o null si es el primero.
 */
function calcularDesgloseDeCache(actual, anterior) {
  const hitAhora = entero(actual?.hit);
  const nuevosAhora = entero(actual?.nuevos);
  const entradaDelTurno = entero(actual?.input_tokens);

  if (hitAhora === null || nuevosAhora === null) {
    return { exacto: false, motivo: "sin_contadores_acumulados", cached_tokens: null };
  }

  // PRIMER TURNO DE LA SESION. Los acumulados SON los del turno, porque no hay nada
  // antes que restar. Se comprueba igual: si no cuadran con la entrada reportada,
  // es que esta sesion ya venia con historia y este no es su primer turno de verdad.
  const hitPrevio = anterior ? entero(anterior.hit) : 0;
  const nuevosPrevio = anterior ? entero(anterior.nuevos) : 0;

  if (hitPrevio === null || nuevosPrevio === null) {
    return { exacto: false, motivo: "acumulados_previos_ilegibles", cached_tokens: null };
  }

  const deltaHit = hitAhora - hitPrevio;
  const deltaNuevos = nuevosAhora - nuevosPrevio;

  // UN DELTA NEGATIVO SIGNIFICA QUE LOS CONTADORES SE REINICIARON. Pasa cuando la
  // sesion de Hermes se recrea. Restar ahi daria un numero sin sentido, y peor:
  // daria un coste que parece exacto.
  if (deltaHit < 0 || deltaNuevos < 0) {
    return { exacto: false, motivo: "contadores_reiniciados", cached_tokens: null };
  }

  // LA COMPROBACION QUE HACE QUE ESTO SEA FIABLE. La suma de los deltas tiene que
  // ser la entrada logica del turno. Si no lo es, falta un turno intermedio o el
  // proveedor cuenta de otra forma, y en cualquiera de los dos casos el desglose
  // seria inventado.
  if (entradaDelTurno !== null) {
    const suma = deltaHit + deltaNuevos;
    if (Math.abs(suma - entradaDelTurno) > TOLERANCIA_TOKENS) {
      return {
        exacto: false,
        motivo: "los_deltas_no_cuadran_con_la_entrada",
        cached_tokens: null,
        delta_hit: deltaHit,
        delta_nuevos: deltaNuevos,
        suma_deltas: suma,
        entrada_reportada: entradaDelTurno
      };
    }
  }

  return {
    exacto: true,
    motivo: null,
    cached_tokens: deltaHit,
    nuevos_tokens: deltaNuevos,
    // El porcentaje se guarda calculado para no repetir la division en cada
    // pantalla, y redondeado a dos decimales porque mas precision no significa nada.
    porcentaje_cache: deltaHit + deltaNuevos > 0
      ? Math.round((deltaHit / (deltaHit + deltaNuevos)) * 10000) / 100
      : null
  };
}

/**
 * Saca los contadores acumulados de donde el guard los deja: dentro de state_patch.
 *
 * SE USA state_patch PORQUE ES EL UNICO OBJETO ABIERTO DEL CONTRATO. Las claves de
 * primer nivel son exactas y el esquema las valida, asi que no se puede añadir una
 * nueva sin una migracion coordinada de esquema, prompt, guard y Adapter. state_patch
 * en cambio acepta claves libres, y el Gateway solo lee de ahi tres campos concretos
 * -status, pending_question y pending_intent- e ignora el resto, asi que meter estos
 * dos contadores no puede romper nada aguas abajo. Se verifico en el codigo del
 * Gateway antes de elegir este sitio.
 */
function leerAcumuladosDelContrato(contrato) {
  const patch = contrato?.state_patch;
  if (!patch || typeof patch !== "object") return null;
  const hit = entero(patch.cache_acumulado_hit);
  const nuevos = entero(patch.cache_acumulado_nuevos);
  if (hit === null || nuevos === null) return null;
  return { hit, nuevos };
}

module.exports = {
  calcularDesgloseDeCache,
  leerAcumuladosDelContrato,
  TOLERANCIA_TOKENS
};
