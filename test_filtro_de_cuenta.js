/**
 * Ver el panel del adapter de una clinica sola.
 *
 * LO QUE SE PROTEGE, POR ORDEN DE DAÑO:
 *
 *  1. QUE «UNA CUENTA» SEA UNA CUENTA. Si el filtro se pierde por el camino, el panel
 *     enseña la suma de TODAS las clinicas con el desplegable diciendo el nombre de una.
 *     Ese numero se usa para decidir, y equivocarse ahi es peor que no tenerlo.
 *
 *  2. QUE LOS DOS ENDPOINTS FILTREN IGUAL. El gasto y las trazas se miran a la vez; si uno
 *     filtra y el otro no, se comparan dos cosas distintas creyendo que son la misma.
 *
 *  3. Que lo que no tiene forma de cuenta se diga, en vez de caer en «todas» sin avisar.
 */

const assert = require("assert");
const fs = require("fs");
const { leerCuenta, filtrarPorCuenta, cuentasDeFilas } = require("./filtro-de-cuenta");

// --- 3. LO QUE LLEGA POR LA URL -------------------------------------------

{
  // Sin parametro, todas: es lo que habia antes y no puede cambiar por sorpresa.
  assert.deepEqual(leerCuenta(undefined), { cuenta: null });
  assert.deepEqual(leerCuenta(null), { cuenta: null });

  // El desplegable manda cadena vacia al volver a «Todas»; un enlace a mano puede traer
  // la palabra. Son la misma peticion escrita de dos formas.
  assert.deepEqual(leerCuenta(""), { cuenta: null });
  assert.deepEqual(leerCuenta("   "), { cuenta: null });
  assert.deepEqual(leerCuenta("todas"), { cuenta: null });
  assert.deepEqual(leerCuenta("TODAS"), { cuenta: null });

  // Una cuenta de verdad.
  assert.deepEqual(leerCuenta("democoi1"), { cuenta: "democoi1" });
  assert.deepEqual(leerCuenta("  democoi1  "), { cuenta: "democoi1" }, "con espacios de mas");
  assert.deepEqual(leerCuenta("helios-la-paz"), { cuenta: "helios-la-paz" });

  // 3. LO QUE NO TIENE FORMA DE CUENTA SE DICE. Caer en «todas» sin avisar enseñaria el
  //    total de todas las clinicas a quien pidio una.
  for (const malo of [
    "democoi1; drop", "de mo", "démocoi", "a".repeat(65), "../otra", "*", "%",
    "democoi1'", "<script>"
  ]) {
    assert.deepEqual(leerCuenta(malo), { error: "CUENTA_INVALIDA" }, `«${malo}» no es una cuenta`);
  }
}

// --- 1. EL FILTRO LLEGA A LA CONSULTA -------------------------------------

{
  // Una consulta de mentira que apunta lo que le piden.
  const consulta = () => {
    const filtros = [];
    const q = { filtros, eq: (col, val) => { filtros.push([col, val]); return q; } };
    return q;
  };

  const conUna = filtrarPorCuenta(consulta(), "democoi1");
  assert.deepEqual(conUna.filtros, [["tenant_id", "democoi1"]], "filtra por tenant_id");

  const conTodas = filtrarPorCuenta(consulta(), null);
  assert.deepEqual(conTodas.filtros, [], "«todas» NO añade filtro: es el comportamiento de antes");

  // Y devuelve la consulta para poder encadenar, que es como se usa en los endpoints.
  const q = consulta();
  assert.equal(filtrarPorCuenta(q, null), q);
}

// --- 2. LOS DOS ENDPOINTS FILTRAN, Y NINGUNO SE QUEDA FUERA ---------------

{
  // El gasto y las trazas se miran a la vez. Si uno filtra y el otro no, se comparan dos
  // cosas distintas creyendo que son la misma, y no hay nada en pantalla que lo delate.
  const fuente = fs.readFileSync("server.js", "utf8");

  for (const endpoint of ['/debug/metricas', '/debug/events']) {
    const i = fuente.indexOf(`app.get("${endpoint}"`);
    assert.ok(i > 0, `${endpoint} existe`);
    const cuerpo = fuente.slice(i, i + 6000);
    assert.ok(
      cuerpo.includes("leerCuenta("),
      `${endpoint} tiene que leer la cuenta de la URL`
    );
    assert.ok(
      cuerpo.includes("filtrarPorCuenta("),
      `${endpoint} tiene que APLICAR el filtro, no solo leerlo`
    );
    assert.ok(
      cuerpo.includes("CUENTA_INVALIDA"),
      `${endpoint} tiene que rechazar una cuenta con mala forma en vez de enseñar todas`
    );
  }

  // Y LAS DOS CONSULTAS DE `/debug/metricas`: el gasto de texto y el de los archivos salen
  // de tablas distintas. Filtrar solo una daria un total mezclado con pinta de exacto.
  const metricas = fuente.slice(
    fuente.indexOf('app.get("/debug/metricas"'),
    fuente.indexOf('app.get("/debug/events"')
  );
  assert.ok(metricas.includes("helios_adapter_events"), "la de texto");
  assert.ok(metricas.includes("helios_media_events"), "y la de archivos");
  assert.ok(
    (metricas.match(/filtrarPorCuenta\(/g) || []).length >= 2,
    "las DOS consultas tienen que filtrar, no solo la de texto"
  );
}

// --- EL DESPLEGABLE ------------------------------------------------------

{
  const filas = [
    { tenant_id: "democoi1", name: "Centro Odontológico Integral" },
    { tenant_id: "lapaz", name: "Clínica La Paz" },
    { tenant_id: "democoi1", name: "duplicada" },
    { tenant_id: "  ", name: "sin id" },
    { tenant_id: "recien", name: "" }
  ];
  const cuentas = cuentasDeFilas(filas);

  assert.equal(cuentas.length, 3, "sin duplicados y sin filas vacias");
  assert.deepEqual(cuentas.map(c => c.tenant_id), ["democoi1", "lapaz", "recien"]);

  // SIN NOMBRE SE USA EL ID. Una clinica recien dada de alta puede no tener nombre, y es
  // peor que desaparezca del desplegable que verla con su identificador.
  assert.equal(cuentas.find(c => c.tenant_id === "recien").nombre, "recien");

  // Ordenadas por nombre, que es como se buscan con la vista.
  assert.deepEqual(cuentas.map(c => c.nombre), ["Centro Odontológico Integral", "Clínica La Paz", "recien"]);

  assert.deepEqual(cuentasDeFilas([]), []);
  assert.deepEqual(cuentasDeFilas(null), []);
}

console.log("test_filtro_de_cuenta: OK");
