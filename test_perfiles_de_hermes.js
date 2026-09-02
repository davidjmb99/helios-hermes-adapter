"use strict";

/**
 * A qué Hermes le habla cada clínica.
 *
 * EL FALLO QUE ESTO ARREGLA. El Adapter construía el cliente de la Agent API una sola
 * vez al arrancar, con una URL, una clave y un `model` globales, y llamaba siempre al
 * mismo. El `hermes_profile` del tenant se usaba para los logs y para la clave de
 * conversación, pero NO para decidir quién contesta.
 *
 * Con una clínica no dolía. Con dos, los pacientes de la segunda hablarían con el
 * Hermes de la primera —y ninguna alarma diría nada, porque la respuesta llegaría
 * perfectamente escrita, solo que de la clínica equivocada—.
 *
 * LO QUE MÁS IMPORTA DE ESTA PRUEBA NO ES QUE ENCAMINE BIEN: ES QUE SE NIEGUE A
 * ENCAMINAR CUANDO NO SABE. La tentación al escribir esto es caer al cliente por
 * defecto «para que al menos conteste algo», y eso es exactamente el fallo original.
 */

const assert = require("assert");
const { leerMapaDePerfiles, crearDirectorioDePerfiles } = require("./perfiles-de-hermes");

// Un `createHermesAgentClient` de mentira que solo anota con qué lo llamaron.
function fabrica() {
  const construidos = [];
  return {
    construidos,
    crear: (opciones) => {
      construidos.push(opciones);
      return { soyElCliente: true, ...opciones };
    }
  };
}

const POR_DEFECTO = { soyElDeSiempre: true };

function directorio(mapaCrudo, fab = fabrica()) {
  return {
    fab,
    dir: crearDirectorioDePerfiles({
      perfilDelAdapter: "helios",
      clientePorDefecto: POR_DEFECTO,
      crearCliente: fab.crear,
      mapaCrudo,
      timeoutMs: 30000
    })
  };
}

const MAPA = JSON.stringify({
  "helios-prueba-wh": { base_url: "http://hermes-agent:8644", api_key: "clave-de-prueba" }
});

// --- 1. SIN MAPA, TODO SIGUE EXACTAMENTE COMO ANTES --------------------------
//
// Es la propiedad que hace que desplegar esto no pueda romper a COI. Si esta falla,
// el despliegue cambia el comportamiento de una clínica en producción.

{
  const { dir, fab } = directorio(undefined);

  assert.equal(dir.clienteDe("helios"), POR_DEFECTO, "el perfil del Adapter va al de siempre");
  assert.equal(dir.clienteDe(""), POR_DEFECTO, "sin perfil, tambien");
  assert.equal(dir.clienteDe(null), POR_DEFECTO);
  assert.equal(dir.clienteDe(undefined), POR_DEFECTO);
  assert.deepEqual(dir.perfilesConDestino, [], "y no hay ningun destino propio");
  assert.equal(dir.aviso, null, "ni aviso: no tener mapa es normal, no un error");
  assert.equal(fab.construidos.length, 0, "no se construye ningun cliente nuevo");
}

// --- 2. LO QUE NO SE SABE ENCAMINAR, NO SE CONTESTA ---------------------------
//
// AQUÍ ESTÁ TODO EL VALOR DE ESTE FICHERO. Un perfil desconocido NO puede caer al
// cliente por defecto: eso mandaría a los pacientes de una clínica al Hermes de otra,
// en silencio. Un error visible es mejor que una respuesta de la clínica equivocada.

{
  const { dir } = directorio(undefined);

  for (const desconocido of ["helios-prueba-wh", "otra-clinica", "default", "meridian"]) {
    assert.throws(
      () => dir.clienteDe(desconocido),
      (e) => {
        assert.equal(
          e.code, "HERMES_PROFILE_SIN_DESTINO",
          `«${desconocido}» tiene que dar un error con codigo, no caer al de siempre`
        );
        assert.ok(
          e.message.includes(desconocido),
          "y el error tiene que decir QUE perfil, para poder arreglarlo"
        );
        return true;
      },
      `«${desconocido}» NO puede acabar hablando con el Hermes de otra clinica`
    );
  }
}

// --- 3. CON MAPA, CADA UNA A SU SITIO ----------------------------------------

{
  const { dir, fab } = directorio(MAPA);

  assert.equal(dir.clienteDe("helios"), POR_DEFECTO, "COI no cambia de sitio");
  assert.equal(fab.construidos.length, 0, "y no se le construye cliente nuevo");

  const otro = dir.clienteDe("helios-prueba-wh");
  assert.notEqual(otro, POR_DEFECTO, "la clinica nueva NO usa el cliente de COI");
  assert.equal(fab.construidos.length, 1);
  assert.deepEqual(fab.construidos[0], {
    baseUrl: "http://hermes-agent:8644",
    apiKey: "clave-de-prueba",
    // EL `model` NO ELIGE PERFIL -eso lo hace el puerto- pero viaja en el cuerpo y sale
    // en la telemetria. Que diga el perfil de verdad y no «helios» para todas.
    model: "helios-prueba-wh",
    timeoutMs: 30000
  });

  // Y EL CLIENTE SE REUTILIZA. Construir uno por mensaje tira a la basura las
  // conexiones reutilizadas, y esto se llama en cada turno.
  for (let i = 0; i < 5; i++) dir.clienteDe("helios-prueba-wh");
  assert.equal(fab.construidos.length, 1, "el cliente se guarda, no se rehace cada vez");
  assert.equal(dir.clienteDe("helios-prueba-wh"), otro, "y es el mismo objeto");

  assert.deepEqual(dir.perfilesConDestino, ["helios-prueba-wh"]);
}

// --- 4. UN MAPA ROTO NO PUEDE TUMBAR A LA CLINICA QUE YA FUNCIONA -------------
//
// Es lo contrario de lo que hace el mapa de CLINICAS, y la diferencia tiene motivo:
// aquel decide DE QUIEN es un mensaje y ante la duda hay que parar del todo. Este
// decide A DONDE se manda, y ante la duda hay que parar SOLO lo que no se sabe
// encaminar.

{
  for (const roto of [
    '{"a":',                       // JSON a medias
    '{"a":{"base_url":"x"},}',     // coma de mas
    "[1,2,3]",                     // no es un objeto
    '"una cadena"',
    "null",
    "42"
  ]) {
    const { dir } = directorio(roto);
    assert.equal(
      dir.clienteDe("helios"), POR_DEFECTO,
      `con el mapa roto «${roto}» la clinica del Adapter TIENE que seguir atendida`
    );
    assert.ok(dir.aviso, "pero con aviso, y fuerte: nada delata esto por si solo");
    assert.throws(() => dir.clienteDe("otra"), /SIN_DESTINO|no esta en/);
  }
}

// --- 5. UNA ENTRADA A MEDIAS SE DESCARTA, NO SE USA ---------------------------
//
// Con URL y sin clave, Hermes devolveria 401 en CADA mensaje de esa clinica. Es peor
// que no tener la entrada: parece configurada y falla siempre.

{
  const casos = [
    { "x": { base_url: "http://a:1" } },                    // sin clave
    { "x": { api_key: "k" } },                              // sin url
    { "x": {} },
    { "x": { base_url: "  ", api_key: "k" } },
    { "x": { base_url: "http://a:1", api_key: "   " } },
    { "": { base_url: "http://a:1", api_key: "k" } }        // sin nombre
  ];
  for (const caso of casos) {
    const { dir } = directorio(JSON.stringify(caso));
    assert.deepEqual(
      dir.perfilesConDestino, [],
      `entrada incompleta descartada: ${JSON.stringify(caso)}`
    );
    assert.ok(dir.aviso, "y avisada");
    assert.throws(() => dir.clienteDe("x"), /SIN_DESTINO|no esta en/);
  }
}

// --- 6. LA BARRA FINAL DE LA URL NO PUEDE DUPLICARSE -------------------------
//
// El cliente añade `/v1/responses`. Con la URL acabada en barra saldria `//v1/responses`,
// que segun el servidor es un 404 o una redireccion silenciosa.

{
  const { dir, fab } = directorio(JSON.stringify({
    "x": { base_url: "http://hermes-agent:8644///", api_key: "k" }
  }));
  dir.clienteDe("x");
  assert.equal(fab.construidos[0].baseUrl, "http://hermes-agent:8644");
}

// --- 7. Y QUE EL SERVIDOR LO USE DE VERDAD -----------------------------------
//
// El directorio puede estar perfecto y no servir de nada si server.js sigue llamando al
// cliente global. Es el mismo fallo que la guarda del webhook: se prueba el modulo, no
// el uso. Y aqui el precio de no verlo es que una clinica hable con el Hermes de otra.

{
  const fs = require("fs");
  const fuente = fs.readFileSync(require.resolve("./server.js"), "utf8")
    .split("\r\n").join("\n");

  assert.ok(
    fuente.includes("directorioDePerfiles.clienteDe(tenantContext.hermes_profile)"),
    "server.js no elige el cliente por el perfil de la clinica: el arreglo no esta puesto"
  );

  // Y QUE NO QUEDE NINGUNA LLAMADA AL CLIENTE GLOBAL EN EL CAMINO DEL TURNO. Si
  // sobrevive una, esa es la que manda a la clinica equivocada.
  const llamadasGlobales = [...fuente.matchAll(/hermesAgentClient\.sendMessage/g)];
  assert.equal(
    llamadasGlobales.length, 0,
    `quedan ${llamadasGlobales.length} llamadas directas a hermesAgentClient.sendMessage`
  );

  // El cliente global sigue existiendo -es el de la clinica del Adapter- pero solo
  // como `clientePorDefecto` del directorio.
  assert.ok(
    fuente.includes("clientePorDefecto: hermesAgentClient"),
    "el cliente de siempre tiene que seguir siendo el del perfil del Adapter"
  );
}

console.log("test_perfiles_de_hermes: OK");
