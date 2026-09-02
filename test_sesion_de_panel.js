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

  // Y EL GET /logout, QUE ES EL QUE DE VERDAD LAS BORRA.
  //
  // AQUI SE COMPROBABA QUE EL JAVASCRIPT DEL BOTON BORRABA LAS DOS COOKIES, y esa
  // comprobacion estuvo VERDE mientras el boton no funcionaba. Comprobaba lo que no era.
  //
  // LAS DOS COOKIES SON HttpOnly, y eso significa exactamente que el JavaScript de la
  // pagina NO PUEDE TOCARLAS. El `document.cookie = ...` del boton no hacia nada: quien
  // entraba por la tabla de clinicas pulsaba «Cerrar sesion», la pagina se recargaba y
  // seguia dentro. Se vio en una ventana de incognito, o sea que no era el navegador
  // guardando nada.
  //
  // ASI QUE LO QUE HAY QUE COMPROBAR ES EL SERVIDOR, que es el unico que puede.
  const getLogout = fuente.slice(
    fuente.indexOf('app.get("/logout"'),
    fuente.indexOf('app.get("/logout"') + 1400
  );
  assert.ok(
    getLogout.includes("panel_token="),
    "GET /logout no borra panel_token: quien entra por la tabla de clinicas no sale nunca"
  );
  assert.ok(getLogout.includes("debug_token="), "y tiene que borrar la de la puerta de servicio");

  // Y CON LOS MISMOS ATRIBUTOS CON LOS QUE SE PUSIERON. Una cookie solo se borra si el
  // borrado coincide; con `Path=/; HttpOnly; Max-Age=0` a secas, un navegador puede
  // conservar la que se puso con Secure y SameSite y dejar al usuario dentro.
  //
  // SOLO LA LINEA DE LOS ATRIBUTOS. Un trozo mas ancho coge los `Set-Cookie` de los
  // logins de al lado, que si llevan Secure y SameSite, y la comprobacion pasaria sola.
  // Se vio inyectando el fallo: quitando los atributos del borrado, la prueba seguia
  // verde porque los encontraba en la funcion vecina.
  const lineaAtributos = getLogout.slice(
    getLogout.indexOf("const atributos"),
    getLogout.indexOf("\n", getLogout.indexOf("const atributos"))
  );
  assert.ok(lineaAtributos.includes("Secure"), "el borrado tiene que llevar Secure cuando toca");
  assert.ok(lineaAtributos.includes("SameSite=Lax"), "y SameSite, igual que al ponerlas");
  assert.ok(lineaAtributos.includes("Max-Age=0"), "y caducarlas");
  assert.ok(lineaAtributos.includes("Path=/"), "y el mismo Path");
}


// --- EL DESPLEGABLE, TAL COMO SE VE ---------------------------------------

{
  const fs = require("fs");
  const fuente = fs.readFileSync("server.js", "utf8");

  // 1. LAS OPCIONES SE PINTAN APARTE DEL SELECT. En Windows la lista la dibuja el sistema
  //    con fondo blanco: con solo el select pintado, el texto claro no se leia.
  assert.ok(
    /#selector-cuenta option\s*\{/.test(fuente),
    "las option necesitan su propio color: el select y su lista son dos superficies"
  );

  // 2. UN OPERADOR NO ES UNA CLINICA. Su fila no tiene pacientes: elegirla enseña ceros.
  const cuentas = fuente.slice(
    fuente.indexOf('app.get("/debug/cuentas"'),
    fuente.indexOf('app.get("/debug/events"')
  );
  assert.ok(
    cuentas.includes("es_operador !== true"),
    "las cuentas de operador no salen en la lista de clinicas"
  );

  // 3. «Todas» SOLO PARA UN OPERADOR. Para una clinica, «todas» es la suya: ofrecerlo
  //    seria una segunda forma de elegir lo mismo, e insinuaria que hay otras.
  const cargar = fuente.indexOf("async function cargarCuentas()");
  const cuerpo = fuente.slice(cargar, cargar + 2200);
  assert.ok(cuerpo.includes("data.operador === true"), "mira si quien pregunta es operador");
  assert.ok(
    cuerpo.includes("Todas las cuentas · Escala365"),
    "y para el, «todas» se llama por su nombre: el total de la empresa"
  );
  assert.ok(
    /esOperador\s*\?/.test(cuerpo),
    "la primera opcion depende de eso, no sale siempre"
  );
}

console.log("test_sesion_de_panel: OK");
