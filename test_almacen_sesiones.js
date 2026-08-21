/**
 * El almacén de sesiones, que antes era un archivo en /tmp.
 *
 * Lo que se protege, por orden de daño si falla:
 *  1. QUE UN FALLO DE SUPABASE NO PAREZCA «NO HAY SESIÓN». Si se confundieran, un
 *     parpadeo de la base abriría una sesión nueva y el paciente perdería el hilo en
 *     mitad de una reserva. Es el error más fácil de cometer aquí.
 *  2. Que la sesión nueva NO herede los tokens de la vieja. Si los heredara, nacería
 *     creyéndose grande y rotaría otra vez en el siguiente mensaje: un bucle en el
 *     que Helios no recuerda ni la frase anterior.
 *  3. Que al rotar se limpie la petición de reset. Si se quedara, cada mensaje
 *     abriría sesión nueva para siempre.
 *  4. Que sin Supabase el bot siga funcionando, degradado y diciéndolo.
 */
const assert = require('assert');
const { crearAlmacenDeSesiones, partesDeLaClave, conversacionDeHermes } = require('./almacen-sesiones.js');

let pasados = 0;
const ok = (etiqueta, condicion) => {
  assert.ok(condicion, 'FALLO: ' + etiqueta);
  pasados += 1;
  console.log('  PASS: ' + etiqueta);
};

const CLAVE = 'tenant:democoi1:profile:helios:conversation:75:contact:c1';

/** Un Supabase de mentira, con interruptor para que falle. */
function fakeSupabase() {
  const filas = new Map();
  const registro = { upserts: [], updates: [], deletes: [] };
  let falla = false;
  const api = {
    filas, registro,
    romper(v) { falla = v; },
    from() {
      const q = {
        _clave: null,
        select() { return q; },
        eq(_col, valor) { q._clave = valor; return q; },
        async maybeSingle() {
          if (falla) return { data: null, error: { code: 'SUPABASE_NETWORK', message: 'fetch failed' } };
          return { data: filas.get(q._clave) || null, error: null };
        },
        async upsert(fila) {
          if (falla) return { error: { code: 'SUPABASE_NETWORK' } };
          registro.upserts.push(fila);
          filas.set(fila.session_key, { ...(filas.get(fila.session_key) || {}), ...fila });
          return { error: null };
        },
        update(parche) {
          return {
            async eq(_c, valor) {
              if (falla) return { error: { code: 'SUPABASE_NETWORK' } };
              registro.updates.push({ clave: valor, parche });
              filas.set(valor, { ...(filas.get(valor) || {}), ...parche });
              return { error: null };
            }
          };
        },
        delete() {
          return {
            async eq(_c, valor) { registro.deletes.push(valor); filas.delete(valor); return { error: null }; }
          };
        }
      };
      return q;
    }
  };
  return api;
}

async function main() {
  // --- La clave se descompone bien --------------------------------------------
  {
    const p = partesDeLaClave(CLAVE);
    ok('la clave se descompone en sus cuatro partes',
      p.tenant_id === 'democoi1' && p.hermes_profile === 'helios'
      && p.conversation_id === '75' && p.contact_id === 'c1');
    ok('una clave con otra forma se rechaza', partesDeLaClave('cualquier-cosa') === null);
  }

  // --- Leer: no hay fila vs no se pudo leer -----------------------------------
  {
    const sb = fakeSupabase();
    const almacen = crearAlmacenDeSesiones({ supabase: sb });

    const vacio = await almacen.leer(CLAVE);
    ok('sin fila devuelve null y NO degradado', vacio.fila === null && vacio.degradado === false);

    await almacen.abrirNueva(CLAVE, 'sin_sesion', null, 'sesion-1');
    const leida = await almacen.leer(CLAVE);
    ok('lo guardado se lee', leida.fila?.session_id === 'sesion-1' && leida.degradado === false);
  }

  {
    // EL CASO 1, el que mas daño hace. Supabase falla teniendo la sesion respaldada en
    // memoria: NO puede parecer «no hay sesion», porque entonces se abriria una nueva y
    // el paciente perderia el hilo por un parpadeo de la base.
    const sb = fakeSupabase();
    const almacen = crearAlmacenDeSesiones({ supabase: sb });
    await almacen.abrirNueva(CLAVE, 'sin_sesion', null, 'sesion-viva');

    sb.romper(true);
    const r = await almacen.leer(CLAVE);
    ok('con Supabase caido NO se pierde la sesion', r.fila?.session_id === 'sesion-viva');
    ok('y se dice que va degradado', r.degradado === true);
    ok('y queda contado', almacen.metricas.lecturas_degradadas >= 1);
  }

  // --- Rotar: que la nueva no herede nada de la vieja -------------------------
  {
    const sb = fakeSupabase();
    const almacen = crearAlmacenDeSesiones({ supabase: sb });

    await almacen.abrirNueva(CLAVE, 'sin_sesion', null, 'sesion-1');
    await almacen.anotarTurno(CLAVE, 42274);

    const antes = (await almacen.leer(CLAVE)).fila;
    ok('el turno anota los tokens de entrada', antes.ultimo_input_tokens === 42274);
    ok('y suma el turno', antes.turnos === 1);

    await almacen.abrirNueva(CLAVE, 'contexto_demasiado_grande', antes, 'sesion-2');
    const despues = (await almacen.leer(CLAVE)).fila;

    ok('la sesion nueva sustituye a la vieja', despues.session_id === 'sesion-2');
    ok('EL CASO 2: la nueva no hereda los tokens de la vieja', despues.ultimo_input_tokens === null);
    ok('los turnos vuelven a cero', despues.turnos === 0);
    ok('la rotacion queda contada en la fila', despues.rotaciones === 1);
    ok('y con su motivo', despues.ultimo_motivo === 'contexto_demasiado_grande');
  }

  {
    // La primera vez NO es una rotacion, es el principio.
    const sb = fakeSupabase();
    const almacen = crearAlmacenDeSesiones({ supabase: sb });
    await almacen.abrirNueva(CLAVE, 'sin_sesion', null, 's1');
    ok('abrir la primera sesion no cuenta como rotacion',
      (await almacen.leer(CLAVE)).fila.rotaciones === 0);
  }

  // --- EL CASO 3: el reset se limpia al aplicarse -----------------------------
  {
    const sb = fakeSupabase();
    const almacen = crearAlmacenDeSesiones({ supabase: sb });
    await almacen.abrirNueva(CLAVE, 'sin_sesion', null, 's1');

    // El panel pide empezar de cero.
    sb.filas.set(CLAVE, { ...sb.filas.get(CLAVE), reset_pedido_at: new Date().toISOString(), reset_pedido_por: 'david' });
    const conPeticion = (await almacen.leer(CLAVE)).fila;
    ok('la peticion de reset se lee', !!conPeticion.reset_pedido_at);

    await almacen.abrirNueva(CLAVE, 'reset_manual', conPeticion, 's2');
    const limpia = sb.filas.get(CLAVE);
    ok('al aplicar el reset se limpia la peticion', limpia.reset_pedido_at === null);
    ok('y quien lo pidio tambien', limpia.reset_pedido_por === null);
  }

  // --- Sin Supabase el bot sigue ----------------------------------------------
  {
    const almacen = crearAlmacenDeSesiones({ supabase: null });
    const vacio = await almacen.leer(CLAVE);
    ok('sin Supabase la primera lectura va degradada', vacio.degradado === true && vacio.fila === null);

    await almacen.abrirNueva(CLAVE, 'sin_sesion', null, 'solo-en-memoria');
    const r = await almacen.leer(CLAVE);
    ok('y aun asi la sesion se conserva en el proceso', r.fila?.session_id === 'solo-en-memoria');
  }

  // --- Olvidar ----------------------------------------------------------------
  {
    const sb = fakeSupabase();
    const almacen = crearAlmacenDeSesiones({ supabase: sb });
    await almacen.abrirNueva(CLAVE, 'sin_sesion', null, 's1');
    await almacen.olvidar(CLAVE);
    ok('olvidar borra la fila', (await almacen.leer(CLAVE)).fila === null);
    ok('y tambien el respaldo en memoria', sb.registro.deletes.includes(CLAVE));
  }

  // --- LA GENERACION, que es el mecanismo de empezar de cero -----------------
  {
    // LA 0 RINDE LA CADENA DE SIEMPRE. Si el sufijo se pusiera tambien en la 0,
    // desplegar esto le habria reiniciado el hilo a TODAS las conversaciones abiertas
    // de golpe. Empezar de cero es una decision sobre una conversacion, no un efecto
    // colateral de un despliegue.
    ok('la generacion 0 no lleva sufijo', conversacionDeHermes('abc', 0) === 'helios-abc');
    ok('y sin generacion tampoco', conversacionDeHermes('abc', null) === 'helios-abc');
    ok('a partir de la 1 si', conversacionDeHermes('abc', 1) === 'helios-abc-g1');
    ok('y son distintas entre si', conversacionDeHermes('abc', 1) !== conversacionDeHermes('abc', 2));
  }

  {
    const sb = fakeSupabase();
    const almacen = crearAlmacenDeSesiones({ supabase: sb });

    const g0 = await almacen.abrirNueva(CLAVE, 'sin_sesion', null);
    ok('la primera conversacion es la generacion 0', g0 === 0);

    const fila0 = (await almacen.leer(CLAVE)).fila;
    const g1 = await almacen.abrirNueva(CLAVE, 'reset_manual', fila0);
    ok('un reset sube a la generacion 1', g1 === 1);

    const fila1 = (await almacen.leer(CLAVE)).fila;
    const g2 = await almacen.abrirNueva(CLAVE, 'inactividad', fila1);
    ok('y la siguiente rotacion a la 2', g2 === 2);
    ok('la generacion queda guardada', fila1.generacion === 1);
  }

  {
    // Si la escritura falla, la generacion se devuelve igual: el turno tiene que
    // seguir. Perderla significa recalcularla en el proximo mensaje, no dejar al
    // paciente sin respuesta.
    const sb = fakeSupabase();
    const almacen = crearAlmacenDeSesiones({ supabase: sb });
    sb.romper(true);
    const g = await almacen.abrirNueva(CLAVE, 'sin_sesion', null);
    ok('con la base caida se devuelve una generacion usable', g === 0);
  }

  // --- Una escritura fallida se cuenta, no se traga ---------------------------
  {
    const sb = fakeSupabase();
    const almacen = crearAlmacenDeSesiones({ supabase: sb });
    sb.romper(true);
    await almacen.abrirNueva(CLAVE, 'sin_sesion', null, 's1');
    ok('una escritura fallida queda contada', almacen.metricas.escrituras_fallidas >= 1);
    ok('y con su codigo de error', !!almacen.metricas.ultimo_error);
  }

}

main().then(() => {
  console.log('test_almacen_sesiones: ' + pasados + ' comprobaciones OK');
}).catch(e => { console.error(e.message); process.exit(1); });
