"use strict";

/**
 * A QUÉ HERMES LE HABLA CADA CLÍNICA.
 *
 * HASTA HOY, A UNO SOLO. El Adapter construía el cliente de la Agent API UNA VEZ al
 * arrancar, con una `HERMES_AGENT_API_BASE_URL`, una clave y un `model` globales, y
 * llamaba siempre al mismo:
 *
 *     hermesAgentClient.sendMessage({ input, conversation, ... })   <- sin perfil
 *
 * El `hermes_profile` del tenant SÍ se usaba —para los logs, para la clave de
 * conversación, para leer la sesión— pero NO para decidir quién contesta. El Adapter
 * comprobaba el billete y sentaba al pasajero en otro avión.
 *
 * NUNCA DOLIÓ PORQUE SOLO HABÍA UNA CLÍNICA. En cuanto entra la segunda, sus pacientes
 * hablarían con el Hermes de la primera. Es exactamente lo que la multitenancy existe
 * para impedir.
 *
 * POR QUÉ UN MAPA Y NO UN CAMPO EN LA PETICIÓN. Se comprobó en la instalación real: el
 * campo `model` del cuerpo NO selecciona el perfil. Lo selecciona el LISTENER al que
 * llega la petición, o sea el puerto. Cada perfil de Hermes tiene su propio gateway
 * supervisado, con su puerto y su clave —y el código de Hermes «falla cerrado»: un
 * perfil con nombre no hereda la clave del listener de otro-.
 *
 *     hermes-agent:8643  ->  helios
 *     hermes-agent:86XX  ->  otro perfil
 *
 * Existe una alternativa —multiplexar todo por un solo puerto con prefijos
 * `/p<perfil>/`— y se descartó: el código de Hermes hace que ese listener único sea el
 * del perfil `default`, que es justo donde se experimenta. Habría puesto el tráfico de
 * una clínica real detrás del perfil que más se reinicia.
 *
 * LA REGLA, Y ES LO ÚNICO QUE HAY QUE ENTENDER DE ESTE FICHERO:
 *
 *     el perfil es el del Adapter   ->  el cliente de siempre, sin cambiar nada
 *     el perfil está en el mapa     ->  su URL y su clave
 *     ni una cosa ni la otra        ->  ERROR, y no se contesta
 *
 * ESE ÚLTIMO CASO ES DELIBERADO Y ES LO MÁS IMPORTANTE DE AQUÍ. La tentación es caer
 * al cliente por defecto «para que al menos conteste algo». Eso sería mandar a los
 * pacientes de una clínica al Hermes de OTRA, en silencio y sin que nada avise. Un
 * error visible es mucho mejor que una respuesta correcta de la clínica equivocada.
 *
 * Y POR ESO DESPLEGAR ESTO NO CAMBIA NADA: sin mapa, la única clínica que existe usa
 * el cliente de siempre porque su perfil es el del Adapter.
 */

/**
 * Lee el mapa de perfiles.
 *
 * Formato:
 *
 *   {
 *     "helios-prueba-wh": {
 *       "base_url": "http://hermes-agent:8644",
 *       "api_key": "..."
 *     }
 *   }
 *
 * UN MAPA MAL FORMADO NO PUEDE TUMBAR A LA CLÍNICA QUE YA FUNCIONA, y por eso esto no
 * lanza: devuelve el mapa vacío y un aviso. La clínica cuyo perfil es el del Adapter
 * sigue atendida; las demás caen en el error de arriba, que es lo correcto.
 *
 * Es lo contrario de lo que hace el mapa de CLÍNICAS -que sí falla cerrado del todo-,
 * y la diferencia tiene motivo: aquel decide DE QUIÉN es un mensaje, y ante la duda
 * hay que parar. Este decide A DÓNDE se manda, y ante la duda hay que parar SOLO lo
 * que no se sabe encaminar.
 */
function leerMapaDePerfiles(crudo) {
  const texto = String(crudo ?? "").trim();
  if (!texto) return { mapa: {}, aviso: null };

  let parseado;
  try {
    parseado = JSON.parse(texto);
  } catch (_) {
    return {
      mapa: {},
      aviso: "HERMES_AGENT_PROFILES_JSON no es JSON valido: se ignora entera. Las "
        + "clinicas cuyo perfil no sea el del Adapter no seran atendidas."
    };
  }

  if (!parseado || typeof parseado !== "object" || Array.isArray(parseado)) {
    return {
      mapa: {},
      aviso: "HERMES_AGENT_PROFILES_JSON tiene que ser un objeto {perfil: {...}}."
    };
  }

  const mapa = {};
  const malas = [];

  for (const [perfil, valor] of Object.entries(parseado)) {
    const nombre = String(perfil || "").trim();
    const baseUrl = String(valor?.base_url ?? "").trim().replace(/\/+$/, "");
    const apiKey = String(valor?.api_key ?? "").trim();

    // LAS TRES COSAS O NINGUNA. Una entrada a medias es peor que no tenerla: con la
    // URL y sin clave, Hermes devolvería 401 en cada mensaje de esa clínica.
    if (!nombre || !baseUrl || !apiKey) {
      malas.push(nombre || "(sin nombre)");
      continue;
    }
    mapa[nombre] = { base_url: baseUrl, api_key: apiKey };
  }

  return {
    mapa,
    aviso: malas.length
      ? `HERMES_AGENT_PROFILES_JSON: entradas incompletas y descartadas -> ${malas.join(", ")}. `
        + "Cada perfil necesita base_url Y api_key."
      : null
  };
}

/**
 * El directorio: dado un perfil, devuelve el cliente que le corresponde.
 *
 * `crearCliente` se inyecta para poder probar esto sin hablar con nadie, y `porDefecto`
 * es el cliente global que ya existía.
 */
function crearDirectorioDePerfiles({
  perfilDelAdapter,
  clientePorDefecto,
  crearCliente,
  mapaCrudo,
  timeoutMs
}) {
  const { mapa, aviso } = leerMapaDePerfiles(mapaCrudo);
  const propio = String(perfilDelAdapter || "").trim();

  // LOS CLIENTES SE GUARDAN. Construir uno por mensaje no rompe nada pero tira a la
  // basura las conexiones reutilizadas, y esto se llama en cada turno.
  const cache = new Map();

  function clienteDe(perfil) {
    const nombre = String(perfil || "").trim();

    // Sin perfil no hay decisión que tomar: es el comportamiento de siempre.
    if (!nombre || nombre === propio) return clientePorDefecto;

    const entrada = mapa[nombre];
    if (!entrada) {
      const error = new Error(
        `El perfil «${nombre}» no esta en HERMES_AGENT_PROFILES_JSON y no es el del `
        + `Adapter («${propio}»). No se contesta para no mandar a esta clinica al `
        + `Hermes de otra.`
      );
      error.code = "HERMES_PROFILE_SIN_DESTINO";
      error.hermesProfile = nombre;
      throw error;
    }

    if (!cache.has(nombre)) {
      cache.set(nombre, crearCliente({
        baseUrl: entrada.base_url,
        apiKey: entrada.api_key,
        // EL `model` NO ELIGE PERFIL -lo elige el puerto-, pero viaja en el cuerpo y
        // sale en la telemetria. Que diga el perfil de verdad y no «helios» para todos.
        model: nombre,
        timeoutMs
      }));
    }
    return cache.get(nombre);
  }

  return {
    clienteDe,
    aviso,
    /** Para el arranque y el diagnostico: qué perfiles tienen destino propio. */
    perfilesConDestino: Object.keys(mapa).sort()
  };
}

module.exports = { leerMapaDePerfiles, crearDirectorioDePerfiles };
