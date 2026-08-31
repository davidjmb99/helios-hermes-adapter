"use strict";

/**
 * Que un reintento vuelva a llamar a Hermes de verdad — y que un exito NO se toque nunca.
 *
 * EL PROBLEMA QUE ARREGLA. Los mismos mensajes de origen dan la misma `request_key`. Si
 * esa clave ya esta `completed`, el Adapter devuelve el resultado GUARDADO y no llega a
 * hablar con Hermes. Lo vio David leyendo un diagnostico: «el modo recovery no funciona,
 * ni siquiera mando la solicitud a hermes».
 *
 * Y UN TURNO PUEDE QUEDAR «completed» HABIENDO FALLADO: Hermes contesta, el guard de
 * salida veta la respuesta, y se persiste un resultado con `ok: false`. El paciente no
 * recibe nada. Desde el 18 de agosto eso no entra en bucle -se abandona-, asi que hoy el
 * mensaje de ese paciente se pierde para siempre por un fallo que pudo ser pasajero.
 *
 * LO QUE MAS IMPORTA DE ESTA PRUEBA NO ES QUE REABRA: ES QUE NO REABRA DE MAS. Reabrir un
 * exito significa contestarle DOS VECES al mismo paciente, que es peor que el problema que
 * se venia a resolver. Por eso los casos que no deben reabrirse van primero y son mas.
 */

const assert = require("assert");
const { createExecutionStore } = require("./execution-store");

const IDENTITY = {
  request_key: "rk-1",
  tenant_id: "democoi1",
  account_id: "2",
  clinic_id: "coi",
  hermes_profile: "helios",
  conversation_id: "77",
  contact_id: "8",
  source_message_ids_hash: "hash-1"
};

function tiendaCon(normalizedResult, extra = {}) {
  const store = createExecutionStore({});
  // Se pasa por el camino normal para no inventarse la forma de la fila.
  return store.claim(IDENTITY)
    .then(() => store.complete(IDENTITY.request_key, { normalized_result: normalizedResult }))
    .then(() => {
      if (Object.keys(extra).length > 0) {
        // `attempt_count` solo se puede subir reclamando otra vez, y aqui hace falta
        // poder fijarlo para probar el limite.
        return store.claim(IDENTITY)
          .then(() => store.complete(IDENTITY.request_key, { normalized_result: normalizedResult }));
      }
    })
    .then(() => store);
}

const FALLO_NO_ENVIADO = {
  ok: false,
  error_code: "OUTPUT_CONTRACT_VIOLATION",
  safe_to_send: false,
  response_sent: false
};

(async () => {

  // --- 1. LO QUE NO SE PUEDE REABRIR NUNCA -----------------------------------

  {
    // UN EXITO. Es la idempotencia entera: reabrirlo es contestarle dos veces al paciente.
    const store = await tiendaCon({
      ok: true,
      message_for_client: "Su cita quedo agendada para manana a las 10:00.",
      safe_to_send: true,
      response_sent: true
    });
    assert.equal(
      await store.reabrirSiFallo(IDENTITY.request_key, 2), false,
      "UN EXITO NO SE REABRE JAMAS: seria contestarle dos veces al mismo paciente"
    );
  }

  {
    // UN FALLO QUE SI SE ENVIO. Si `safe_to_send` era true, el Gateway lo publico: al
    // paciente le llego algo, aunque fuera un mensaje de error. Volver a ejecutar le
    // mandaria un segundo mensaje.
    const store = await tiendaCon({ ...FALLO_NO_ENVIADO, safe_to_send: true });
    assert.equal(
      await store.reabrirSiFallo(IDENTITY.request_key, 2), false,
      "si safe_to_send era true, al paciente le llego algo: no se reabre"
    );
  }

  {
    const store = await tiendaCon({ ...FALLO_NO_ENVIADO, response_sent: true });
    assert.equal(
      await store.reabrirSiFallo(IDENTITY.request_key, 2), false,
      "y si response_sent era true, lo mismo"
    );
  }

  {
    // UN RESULTADO SIN ESOS CAMPOS. Un resultado viejo, o de otra version, que no traiga
    // `ok` ni `safe_to_send`. AL NO SABER, SE SUPONE QUE SALIO BIEN Y QUE SE ENVIO: la
    // suposicion segura es la que no le manda un segundo mensaje a nadie.
    const store = await tiendaCon({ message_for_client: "algo" });
    assert.equal(
      await store.reabrirSiFallo(IDENTITY.request_key, 2), false,
      "sin los campos no se sabe, y sin saber no se reabre"
    );
  }

  {
    // CON EL INTERRUPTOR APAGADO, NADA. Es como se despliega: cero.
    const store = await tiendaCon(FALLO_NO_ENVIADO);
    for (const apagado of [0, -1, null, undefined, "2", 1.5, NaN]) {
      assert.equal(
        await store.reabrirSiFallo(IDENTITY.request_key, apagado), false,
        `con maxIntentos = ${String(apagado)} no se reabre nada`
      );
    }
  }

  // --- 2. LO QUE SI SE REABRE ------------------------------------------------

  {
    const store = await tiendaCon(FALLO_NO_ENVIADO);
    assert.equal(
      await store.reabrirSiFallo(IDENTITY.request_key, 1), true,
      "un fallo que no llego al paciente SI se reabre: es todo el objetivo"
    );

    // Y AL VOLVER A RECLAMARLA, EL ADAPTER LLAMA A HERMES. Reabrir sin que esto pase no
    // serviria de nada, y es el eslabon que une las dos piezas.
    const segundo = await store.claim(IDENTITY);
    assert.equal(
      segundo.action, "execute",
      "reabrir tiene que dejarla en «execute»: es lo que hace que se llame a Hermes"
    );
    assert.ok(
      segundo.execution.attempt_count > 1,
      "y el intento se cuenta, que es lo que permite frenar"
    );
  }

  // --- 3. QUE NO SE REABRA DOS VECES A LA VEZ --------------------------------
  //
  // Si dos peticiones simultaneas reabrieran la misma ejecucion, las dos llamarian a
  // Hermes y el paciente recibiria DOS respuestas. Es el riesgo mayor de todo esto.
  //
  // ESTO NO SE PUEDE PROBAR CON EL ALMACEN EN MEMORIA, y conviene decirlo antes de que
  // alguien lea la prueba de abajo y se quede tranquilo: la rama de memoria no tiene
  // ningun `await` entre comprobar y escribir, asi que la primera llamada termina entera
  // antes de que empiece la segunda. Pasaria igual con el codigo mal escrito.
  //
  // LA ATOMICIDAD DE VERDAD ESTA EN EL `WHERE` DE POSTGRES: la fila se busca y se cambia
  // en una sola sentencia, asi que solo una de las dos la encuentra en «completed». Eso
  // es lo que se comprueba aqui, leyendo la migracion.

  {
    const fs = require("fs");
    const sql = fs.readFileSync(
      require.resolve("./supabase/migrations/20260831210000_reabrir_ejecucion_fallida.sql"),
      "utf8"
    );

    const update = sql.slice(sql.indexOf("UPDATE public.helios_adapter_executions"));
    const where = update.slice(update.indexOf("WHERE"), update.indexOf("RETURNING"));

    // LAS CINCO CONDICIONES TIENEN QUE ESTAR EN EL `WHERE`, no en un IF anterior.
    // Comprobar antes y actualizar despues es exactamente el hueco por el que se le
    // contesta dos veces al mismo paciente.
    for (const [condicion, porque] of [
      ["status = 'completed'", "sin esto se reabre algo que ya se estaba ejecutando"],
      ["attempt_count <= p_max_intentos", "sin esto no frena nunca"],
      ["'ok')::boolean, true) = false", "sin esto SE REABRE UN EXITO"],
      ["'safe_to_send')::boolean, true) = false", "sin esto se reabre algo que si se envio"],
      ["'response_sent')::boolean, true) = false", "lo mismo por el otro lado"]
    ]) {
      assert.ok(
        where.includes(condicion),
        `falta «${condicion}» en el WHERE de la migracion: ${porque}`
      );
    }

    // Y LOS COALESCE CON EL VALOR SEGURO. Si el campo no esta, hay que suponer que salio
    // bien y que se envio -o sea, NO reabrir-. Un `false` ahi invertiria el criterio y
    // reabriria todo resultado antiguo que no traiga estos campos.
    for (const campo of ["ok", "safe_to_send", "response_sent"]) {
      assert.ok(
        where.includes(`COALESCE((normalized_result->>'${campo}')::boolean, true)`),
        `el COALESCE de '${campo}' tiene que suponer «true» cuando el campo no esta`
      );
    }

    // La logica en memoria vale para probar el criterio, no la concurrencia.
    const store = await tiendaCon(FALLO_NO_ENVIADO);
    const [a, b] = await Promise.all([
      store.reabrirSiFallo(IDENTITY.request_key, 2),
      store.reabrirSiFallo(IDENTITY.request_key, 2)
    ]);
    assert.equal([a, b].filter(Boolean).length, 1);
  }

  // --- 4. Y EL LIMITE FRENA --------------------------------------------------

  {
    // Un fallo permanente -un SOUL mal escrito, una herramienta caida- no se puede
    // reintentar para siempre: solo gastaria tokens.
    const store = await tiendaCon(FALLO_NO_ENVIADO);
    let reaperturas = 0;
    for (let i = 0; i < 10; i++) {
      if (await store.reabrirSiFallo(IDENTITY.request_key, 2)) {
        reaperturas += 1;
        await store.claim(IDENTITY);
        await store.complete(IDENTITY.request_key, { normalized_result: FALLO_NO_ENVIADO });
      }
    }
    assert.ok(
      reaperturas > 0 && reaperturas <= 2,
      `con el limite en 2 se reabre como mucho 2 veces, y se reabrio ${reaperturas}`
    );
  }

  // --- 5. Y QUE EL SERVIDOR LO LLAME DE VERDAD -------------------------------
  //
  // La funcion puede estar perfecta y no llamarse desde ningun sitio. Es el mismo fallo de
  // la guarda del webhook: se prueba el modulo, no el uso.

  {
    const fs = require("fs");
    const fuente = fs.readFileSync(require.resolve("./server.js"), "utf8")
      .split("\r\n").join("\n");

    assert.ok(
      fuente.includes("executionStore.reabrirSiFallo("),
      "server.js no llama a reabrirSiFallo: la funcion no sirve de nada"
    );
    assert.ok(
      fuente.includes("ADAPTER_MAX_REINTENTOS_DE_FALLO"),
      "y tiene que estar detras del interruptor"
    );

    // Y QUE VUELVA A RECLAMAR DESPUES. Reabrir sin reclamar deja la ejecucion en
    // `failed_recoverable` y devuelve el resultado guardado igual: todo el trabajo para
    // nada, y sin que nada avise.
    const i = fuente.indexOf("executionStore.reabrirSiFallo(");
    const despues = fuente.slice(i, i + 1400);
    assert.ok(
      despues.includes("executionStore.claim(executionIdentity)"),
      "despues de reabrir hay que volver a reclamar, o no se llama a Hermes igualmente"
    );

    // EL VALOR POR DEFECTO ES CERO. Si algun dia alguien lo sube «para probar», que sea una
    // decision escrita y no un descuido: asi se despliega sin cambiarle nada a nadie.
    const decl = fuente.slice(
      fuente.indexOf("const ADAPTER_MAX_REINTENTOS_DE_FALLO"),
      fuente.indexOf("const ADAPTER_MAX_REINTENTOS_DE_FALLO") + 260
    );
    assert.ok(
      /ADAPTER_MAX_REINTENTOS_DE_FALLO\s*\|\|\s*0/.test(decl),
      "el valor por defecto tiene que ser 0: desplegar no puede cambiar comportamiento"
    );
  }

  console.log("test_reabrir_ejecucion: OK");
})().catch(error => {
  console.error(error);
  process.exit(1);
});
