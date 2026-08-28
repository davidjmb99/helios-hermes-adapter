/**
 * Quien entra al panel del adapter, y que cuentas puede ver.
 *
 * ESTO DEJA DE SER COMODIDAD EN CUANTO ENTRA UNA CLINICA. Mientras el panel era solo del
 * equipo tecnico, elegir cuenta quitaba ruido. Con clinicas dentro, en esas trazas van los
 * mensajes de los pacientes: elegir cuenta pasa a ser un permiso.
 *
 * LO QUE SE PROTEGE, POR ORDEN DE DAÑO:
 *
 *  1. QUE UNA CLINICA NO VEA LAS TRAZAS DE OTRA. Es la unica pared que hay. El parametro
 *     `?cuenta=` se le IGNORA, no se le rechaza: rechazarlo distinto segun la cuenta
 *     existiera o no le diria cuales existen.
 *
 *  2. QUE NADIE SE ASCIENDA A OPERADOR editando una cookie. El `operador` va dentro del
 *     token y firmado.
 *
 *  3. QUE UNA FIRMA INVENTADA NO ABRA NADA, ni un token caducado.
 *
 *  4. Que a una clinica no se le enseñen los NOMBRES de las demas en el desplegable: eso
 *     ya seria contarle quienes son los otros clientes.
 */

const assert = require("assert");
const crypto = require("crypto");
const {
  crearSesion, leerSesion, cuentaQueSeVe, cuentasQueSeVen, DURACION_MS
} = require("./sesion-de-panel");

const SECRETO = "un-secreto-de-prueba-largo-y-tonto";
const AHORA = 1800000000000;

const operador = crearSesion({ tenantId: "democoi1", operador: true, secreto: SECRETO, ahora: AHORA });
const clinica = crearSesion({ tenantId: "lapaz", operador: false, secreto: SECRETO, ahora: AHORA });

// --- LO QUE SI ------------------------------------------------------------

{
  assert.deepEqual(
    leerSesion(operador, SECRETO, AHORA),
    { tenant_id: "democoi1", operador: true }
  );
  assert.deepEqual(
    leerSesion(clinica, SECRETO, AHORA),
    { tenant_id: "lapaz", operador: false }
  );
}

// --- 1. UNA CLINICA SOLO VE LO SUYO --------------------------------------

{
  const suya = leerSesion(clinica, SECRETO, AHORA);

  // Pida lo que pida, ve la suya. ES LA UNICA PARED QUE HAY.
  assert.equal(cuentaQueSeVe(suya, "democoi1"), "lapaz", "pedir otra cuenta no sirve de nada");
  assert.equal(cuentaQueSeVe(suya, "cualquiera"), "lapaz");
  assert.equal(cuentaQueSeVe(suya, ""), "lapaz");
  assert.equal(cuentaQueSeVe(suya, null), "lapaz", "y «todas» tampoco: todas es la suya");

  // SE IGNORA, NO SE RECHAZA. Un error distinto segun la cuenta existiera o no le diria
  // cuales existen; esto no dice nada y le devuelve lo suyo, que es lo que venia a ver.
  assert.equal(typeof cuentaQueSeVe(suya, "democoi1"), "string");
}

{
  // Un operador si elige, y «todas» sigue siendo el defecto.
  const op = leerSesion(operador, SECRETO, AHORA);
  assert.equal(cuentaQueSeVe(op, "lapaz"), "lapaz");
  assert.equal(cuentaQueSeVe(op, null), null, "null es «todas»");
  assert.equal(cuentaQueSeVe(op, ""), null);
}

{
  // LA PUERTA DE SERVICIO -la contraseña de entorno- ve todo. Existe para entrar a mirar
  // cuando la tabla de clinicas no responde, que es justo cuando mas falta hace.
  assert.equal(cuentaQueSeVe(null, "lapaz"), "lapaz");
  assert.equal(cuentaQueSeVe(null, null), null);
}

// --- 2. NADIE SE ASCIENDE A OPERADOR -------------------------------------

{
  // Cambiar el cuerpo y dejar la firma es lo primero que se intenta.
  const [cuerpo, firma] = clinica.split(".");
  const ascendido = Buffer.from(JSON.stringify({
    t: "panel-v1", tenant_id: "lapaz", operador: true, exp: AHORA + DURACION_MS
  })).toString("base64url");
  assert.equal(
    leerSesion(`${ascendido}.${firma}`, SECRETO, AHORA),
    null,
    "cuerpo cambiado con firma ajena: no vale"
  );

  // Ni firmandolo con otro secreto.
  const conOtro = crypto.createHmac("sha256", "otro").update(ascendido).digest("base64url");
  assert.equal(leerSesion(`${ascendido}.${conOtro}`, SECRETO, AHORA), null);

  // Y el token de una clinica no se convierte en el de otra.
  const otra = Buffer.from(JSON.stringify({
    t: "panel-v1", tenant_id: "democoi1", operador: false, exp: AHORA + DURACION_MS
  })).toString("base64url");
  assert.equal(leerSesion(`${otra}.${firma}`, SECRETO, AHORA), null);
}

// --- 3. FIRMAS, CADUCIDAD Y BASURA ---------------------------------------

{
  for (const malo of ["", "   ", "sin-punto", ".", "a.b.c.d", null, undefined, 42, {}]) {
    assert.equal(leerSesion(malo, SECRETO, AHORA), null, `«${String(malo)}» no es una sesion`);
  }

  const [cuerpo] = operador.split(".");
  assert.equal(leerSesion(`${cuerpo}.inventada`, SECRETO, AHORA), null);
  assert.equal(leerSesion(cuerpo, SECRETO, AHORA), null, "sin firma tampoco");
  assert.equal(leerSesion(operador, "", AHORA), null, "sin secreto no se valida nada");
  assert.equal(leerSesion(operador, "otro-secreto", AHORA), null);

  // CADUCA. Ocho horas, como el panel del gateway.
  assert.ok(leerSesion(operador, SECRETO, AHORA + DURACION_MS - 1000), "antes de la hora, vale");
  assert.equal(leerSesion(operador, SECRETO, AHORA + DURACION_MS + 1000), null, "despues, no");

  // Un token de OTRO tipo firmado con el mismo secreto no abre esto. El de la agenda usa
  // el mismo secreto del servidor: compartirlo no puede significar compartir el alcance.
  const otroTipo = Buffer.from(JSON.stringify({
    t: "agenda-v1", tenant_id: "democoi1", exp: AHORA + DURACION_MS
  })).toString("base64url");
  const firmado = crypto.createHmac("sha256", SECRETO).update(otroTipo).digest("base64url");
  assert.equal(leerSesion(`${otroTipo}.${firmado}`, SECRETO, AHORA), null);

  // Y un token sin clinica dentro no es de nadie.
  const vacio = Buffer.from(JSON.stringify({
    t: "panel-v1", tenant_id: "", operador: true, exp: AHORA + DURACION_MS
  })).toString("base64url");
  const f2 = crypto.createHmac("sha256", SECRETO).update(vacio).digest("base64url");
  assert.equal(leerSesion(`${vacio}.${f2}`, SECRETO, AHORA), null);
}

// --- 4. EL DESPLEGABLE ----------------------------------------------------

{
  const todas = [
    { tenant_id: "democoi1", nombre: "Centro Odontológico Integral" },
    { tenant_id: "lapaz", nombre: "Clínica La Paz" }
  ];

  const op = leerSesion(operador, SECRETO, AHORA);
  assert.equal(cuentasQueSeVen(op, todas).length, 2, "el operador las ve todas");

  // A UNA CLINICA, LA SUYA Y NADA MAS. Enseñarle los nombres de las demas ya seria
  // contarle quienes son los otros clientes.
  const suya = cuentasQueSeVen(leerSesion(clinica, SECRETO, AHORA), todas);
  assert.equal(suya.length, 1);
  assert.equal(suya[0].tenant_id, "lapaz");
  assert.ok(
    !JSON.stringify(suya).includes("Odontológico"),
    "ni el nombre de la otra clinica aparece por ningun lado"
  );

  assert.equal(cuentasQueSeVen(null, todas).length, 2, "la puerta de servicio, todas");
  assert.deepEqual(cuentasQueSeVen(op, null), []);
}


// --- Y QUE LOS ENDPOINTS LO USEN DE VERDAD -------------------------------
//
// Las funciones de arriba pueden estar perfectas y no servir de nada si un endpoint pasa
// `filtro.cuenta` en vez de la cuenta acotada por la sesion. Eso no se ve leyendo el
// modulo: hay que mirar donde se usa.

{
  const fs = require("fs");
  const fuente = fs.readFileSync("server.js", "utf8");

  for (const endpoint of ['/debug/metricas', '/debug/events']) {
    const i = fuente.indexOf(`app.get("${endpoint}"`);
    assert.ok(i > 0, `${endpoint} existe`);
    const cuerpo = fuente.slice(i, i + 6000);
    assert.ok(
      cuerpo.includes("cuentaQueSeVe(sesionDelPanel(req)"),
      `${endpoint} tiene que acotar la cuenta con la SESION, no fiarse de la URL`
    );
    assert.ok(
      !/filtrarPorCuenta\((?!.*cuentaQueSeVe)[^)]*filtro\.cuenta/.test(cuerpo),
      `${endpoint} NO puede filtrar por lo que venga en la URL sin acotarlo`
    );
  }

  // El desplegable tambien: si devolviera todas las clinicas, una clinica veria los
  // nombres de las demas aunque luego no pudiera abrir sus datos.
  const cuentas = fuente.slice(fuente.indexOf('app.get("/debug/cuentas"'), fuente.indexOf('app.get("/debug/events"'));
  // Se comprueban las DOS piezas y no una llamada escrita de una forma concreta: el
  // handler puede guardar la sesion en una variable antes de usarla, y eso no lo hace peor.
  assert.ok(cuentas.includes("sesionDelPanel(req)"), "/debug/cuentas mira quien pregunta");
  assert.ok(cuentas.includes("cuentasQueSeVen("), "y acota la lista con eso");
  assert.ok(
    !/cuentas:\s*cuentasDeFilas\(/.test(cuentas),
    "y NO devuelve la lista entera sin acotar"
  );

  // Y LA SESION ABRE EL PANEL. Sin esto, quien entre por la tabla de clinicas tendria una
  // cookie valida y el panel le diria que no esta autorizado.
  const auth = fuente.slice(fuente.indexOf("function isDebugAuthorized("), fuente.indexOf("function isDebugAuthorized(") + 1200);
  assert.ok(auth.includes("sesionDelPanel(req)"), "isDebugAuthorized acepta la sesion de la tabla");
}


{
  const fs = require("fs");
  const fuente = fs.readFileSync("server.js", "utf8");

  // SALIR TIENE QUE BORRAR LAS DOS COOKIES. Hay dos puertas; borrar solo una deja dentro a
  // quien entro por la otra, y quien pulsa «salir» se cree fuera.
  const logout = fuente.slice(
    fuente.indexOf('app.post("/debug/logout"'),
    fuente.indexOf('app.post("/debug/logout"') + 700
  );
  assert.ok(logout.includes("debug_token="), "borra la de la puerta de servicio");
  assert.ok(logout.includes("panel_token="), "y la de la tabla de clinicas");

  // Y en el panel, el logout del navegador tambien.
  const enElPanel = fuente.indexOf("function logout()");
  const cuerpoLogout = fuente.slice(enElPanel, enElPanel + 800);
  assert.ok(cuerpoLogout.includes("panel_token="), "el logout del navegador borra las dos");
}

console.log("test_sesion_de_panel: OK");
