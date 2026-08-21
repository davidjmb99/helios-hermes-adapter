/**
 * Dónde vive la sesión de Hermes de cada conversación.
 *
 * ANTES ESTABA EN /tmp, dentro del contenedor, y eso costó tres cosas distintas:
 *
 *   1. Un redeploy las borraba TODAS a la vez y sin avisar.
 *   2. No se podían consultar desde ningún sitio: para saber qué sesión tenía una
 *      conversación había que entrar al contenedor con `docker exec`.
 *   3. EL PROCESO LAS TENÍA EN MEMORIA. `loadSessionMap()` corría una sola vez al
 *      arrancar, así que editar el archivo no hacía nada: el proceso seguía con su
 *      copia y la sobrescribía en el siguiente mensaje. Se descubrió el 20 de agosto
 *      de 2026 intentando exactamente eso.
 *
 * SE LEE DE LA BASE EN CADA TURNO, sin caché, y es deliberado. La caché en memoria
 * es justo lo que hizo imposible tocar una sesión desde fuera, y un SELECT de una
 * fila por clave primaria al lado de una llamada a DeepSeek de tres segundos no se
 * nota. Que el panel pueda pedir «empezar de cero» y que surta efecto en el
 * siguiente mensaje vale infinitamente más que ese milisegundo.
 *
 * PERO NO PUEDE TUMBAR AL BOT. Si Supabase no contesta, se cae a un mapa en memoria
 * de este proceso. Un paciente pierde el hilo de su conversación —le sigue
 * respondiendo, y su nombre y su cita vienen en el payload del Gateway— pero nadie
 * se queda sin respuesta porque el almacén de sesiones esté de mal humor. La
 * degradación es explícita y se registra.
 */

"use strict";

const TABLA = "helios_hermes_sessions";

/** Descompone la clave para poder consultar por clínica sin parsear cadenas. */
function partesDeLaClave(sessionKey) {
  const m = /^tenant:(.+):profile:(.+):conversation:(.+):contact:(.+)$/.exec(String(sessionKey || ""));
  if (!m) return null;
  return { tenant_id: m[1], hermes_profile: m[2], conversation_id: m[3], contact_id: m[4] };
}

function crearAlmacenDeSesiones({ supabase, log = () => {} }) {
  /**
   * Respaldo para cuando Supabase no está. NO es una caché: solo se consulta y se
   * escribe cuando la base ha fallado. Si fuera una caché de verdad volveríamos al
   * problema 3.
   *
   * VA DENTRO DEL ALMACÉN, no en el módulo. Estaba fuera y lo cazó su propia prueba:
   * dos almacenes compartían respaldo, así que uno sin Supabase «encontraba» sesiones
   * que había guardado otro. En producción hay un solo almacén y no se habría notado
   * nunca, que es exactamente lo que hace peligroso ese tipo de estado.
   */
  const enMemoria = new Map();

  const metricas = {
    lecturas: 0,
    lecturas_degradadas: 0,
    escrituras: 0,
    escrituras_fallidas: 0,
    rotaciones: 0,
    ultimo_error: null
  };

  /**
   * La fila guardada de esta conversación, o null.
   *
   * Un fallo de lectura NO es «no hay sesión»: si se confundieran, un parpadeo de
   * Supabase abriría una sesión nueva y el paciente perdería el hilo en mitad de una
   * reserva. Se devuelve lo que haya en el respaldo y se marca la degradación.
   */
  async function leer(sessionKey) {
    metricas.lecturas += 1;

    if (!supabase) {
      metricas.lecturas_degradadas += 1;
      return { fila: enMemoria.get(sessionKey) || null, degradado: true };
    }

    try {
      const { data, error } = await supabase
        .from(TABLA)
        .select("session_key, session_id, generacion, created_at, updated_at, turnos, ultimo_input_tokens, rotaciones, reset_pedido_at")
        .eq("session_key", sessionKey)
        .maybeSingle();

      if (error) throw error;
      return { fila: data || null, degradado: false };
    } catch (error) {
      metricas.lecturas_degradadas += 1;
      metricas.ultimo_error = error?.code || error?.message || "LECTURA_SESION_FALLIDA";
      log({
        event: "almacen_sesiones_lectura_degradada",
        error_code: metricas.ultimo_error,
        // Sin la clave completa: lleva conversation_id y contact_id.
        tiene_respaldo: enMemoria.has(sessionKey)
      });
      return { fila: enMemoria.get(sessionKey) || null, degradado: true };
    }
  }

  /**
   * Abre una conversación nueva y devuelve su generación.
   *
   * `rotaciones` y `generacion` suben solo si ya había una fila: la primera vez no es
   * una rotación, es el principio, y la generación 0 tiene que rendir la cadena de
   * conversación de siempre para que desplegar esto no reinicie a nadie.
   */
  async function abrirNueva(sessionKey, motivo, filaAnterior, sessionId = null) {
    const partes = partesDeLaClave(sessionKey);
    if (!partes) {
      // Sin partes no se puede escribir la fila, pero el turno debe seguir. Se
      // registra y se usa el respaldo con la generacion de siempre.
      log({ event: "almacen_sesiones_clave_invalida", motivo });
      enMemoria.set(sessionKey, { session_id: sessionId, generacion: 0, updated_at: new Date().toISOString() });
      return 0;
    }

    const esLaPrimera = motivo === "sin_sesion" && !filaAnterior;
    if (!esLaPrimera) metricas.rotaciones += 1;

    const generacion = esLaPrimera ? 0 : (Number(filaAnterior?.generacion) || 0) + 1;

    const fila = {
      session_key: sessionKey,
      ...partes,
      generacion,
      session_id: sessionId,
      updated_at: new Date().toISOString(),
      // El turno que abre la sesión cuenta como el primero.
      turnos: 0,
      // La cifra del turno anterior es de OTRA sesión: arrastrarla haría que la nueva
      // naciera creyéndose grande y rotara otra vez en el siguiente mensaje.
      ultimo_input_tokens: null,
      rotaciones: (filaAnterior?.rotaciones || 0) + (esLaPrimera ? 0 : 1),
      ultimo_motivo: motivo,
      // Se limpia la peticion de reset: ya se ha atendido.
      reset_pedido_at: null,
      reset_pedido_por: null
    };

    enMemoria.set(sessionKey, fila);
    if (supabase) {
      try {
        const { error } = await supabase.from(TABLA).upsert(fila, { onConflict: "session_key" });
        if (error) throw error;
        metricas.escrituras += 1;
      } catch (error) {
        metricas.escrituras_fallidas += 1;
        metricas.ultimo_error = error?.code || error?.message || "ESCRITURA_SESION_FALLIDA";
        log({ event: "almacen_sesiones_escritura_fallida", error_code: metricas.ultimo_error });
      }
    }

    // SE DEVUELVE AUNQUE LA ESCRITURA HAYA FALLADO. El turno tiene que seguir: una
    // generacion que no se pudo guardar significa que en el proximo mensaje se
    // recalculara, no que el paciente se quede sin respuesta.
    return generacion;
  }

  /**
   * Cierra el turno: mueve `updated_at`, suma el turno y anota los tokens de entrada.
   *
   * ESE `ultimo_input_tokens` ES LO QUE DECIDE LA PRÓXIMA ROTACIÓN, así que si esto
   * no se escribe, una conversación puede crecer sin techo. Si falla, se registra:
   * no se traga en silencio.
   */
  async function anotarTurno(sessionKey, inputTokens) {
    const previa = enMemoria.get(sessionKey) || {};
    const parche = {
      updated_at: new Date().toISOString(),
      ultimo_input_tokens: Number.isFinite(Number(inputTokens)) ? Number(inputTokens) : null
    };
    enMemoria.set(sessionKey, { ...previa, ...parche });

    if (!supabase) return;

    try {
      // El incremento se hace leyendo y escribiendo porque el cliente de Supabase no
      // tiene un `increment` y una RPC para sumar uno no vale la pena. Dos turnos
      // simultáneos de la MISMA conversación no ocurren: el Gateway los agrupa en
      // lotes y el Adapter los atiende en serie.
      const { data } = await supabase.from(TABLA).select("turnos").eq("session_key", sessionKey).maybeSingle();
      const { error } = await supabase
        .from(TABLA)
        .update({ ...parche, turnos: (data?.turnos || 0) + 1 })
        .eq("session_key", sessionKey);
      if (error) throw error;
      metricas.escrituras += 1;
    } catch (error) {
      metricas.escrituras_fallidas += 1;
      metricas.ultimo_error = error?.code || error?.message || "ANOTAR_TURNO_FALLIDO";
      log({ event: "almacen_sesiones_turno_no_anotado", error_code: metricas.ultimo_error });
    }
  }

  /**
   * Olvida esta sesión. Se usa cuando Hermes dice que ya no existe: la fila apunta a
   * algo que no está y hay que dejar de creérsela.
   */
  async function olvidar(sessionKey) {
    enMemoria.delete(sessionKey);
    if (!supabase) return;
    try {
      await supabase.from(TABLA).delete().eq("session_key", sessionKey);
    } catch (error) {
      metricas.ultimo_error = error?.code || error?.message || "OLVIDO_FALLIDO";
      log({ event: "almacen_sesiones_olvido_fallido", error_code: metricas.ultimo_error });
    }
  }

  return { leer, abrirNueva, anotarTurno, olvidar, metricas };
}

/**
 * El nombre de la conversación que se le manda a Hermes en agent_api.
 *
 * LA GENERACIÓN 0 RINDE LA CADENA DE SIEMPRE, y eso no es un detalle: si el sufijo se
 * pusiera también en la 0, desplegar esto le habría reiniciado el hilo a TODAS las
 * conversaciones abiertas de golpe. Empezar de cero tiene que ser una decisión sobre
 * una conversación concreta, no un efecto colateral de un despliegue.
 */
function conversacionDeHermes(hashDeLaClave, generacion) {
  const g = Number(generacion) || 0;
  return g > 0 ? `helios-${hashDeLaClave}-g${g}` : `helios-${hashDeLaClave}`;
}

module.exports = { crearAlmacenDeSesiones, partesDeLaClave, conversacionDeHermes, TABLA };
