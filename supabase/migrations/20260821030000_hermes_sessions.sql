-- Las sesiones de Hermes, en la base y no en /tmp.
--
-- DONDE ESTABAN: /tmp/helios-hermes-sessions.json, dentro del contenedor del
-- Adapter. Eso tiene tres problemas, y los tres se han pagado:
--
--   1. UN REDEPLOY LAS BORRA TODAS. Contenedor nuevo, /tmp vacio, y todas las
--      conversaciones abiertas pierden su hilo a la vez y sin avisar.
--   2. NO SE PUEDEN CONSULTAR NI TOCAR desde ningun sitio. Para saber que sesion
--      tenia una conversacion habia que entrar al contenedor con docker exec.
--   3. EL PROCESO LAS TIENE EN MEMORIA. loadSessionMap() corre una vez al arrancar,
--      asi que editar el archivo no hace nada: el proceso sigue con su copia y la
--      sobreescribe en el siguiente mensaje. Se descubrio el 20-ago intentando
--      justamente eso.
--
-- Con la tabla: sobreviven al redeploy, se ven desde el panel, y el boton de
-- «empezar de cero» es un UPDATE en vez de tres comandos y un reinicio.
--
-- POR QUE HAY CONTADORES. turnos y ultimo_input_tokens no son telemetria decorativa:
-- son lo que decide cuando rotar. Una sesion que arrastra 60.000 tokens de entrada
-- hace que el modelo se imite a si mismo -tuteaba, decia «hueco» y repetia una
-- direccion de Madrid de hace un mes- y ninguna regla del prompt gana esa pelea.

CREATE TABLE IF NOT EXISTS public.helios_hermes_sessions (
  -- tenant:<t>:profile:<p>:conversation:<c>:contact:<k>, tal como lo arma el Adapter.
  session_key       text PRIMARY KEY,

  -- Desglosado ademas de estar en la clave, para poder consultar por clinica o por
  -- conversacion sin parsear cadenas. AISLAMIENTO: toda lectura filtra por tenant_id.
  tenant_id         text NOT NULL,
  hermes_profile    text NOT NULL,
  conversation_id   text NOT NULL,
  contact_id        text NOT NULL,

  -- LA GENERACION ES EL MECANISMO DE «EMPEZAR DE CERO».
  --
  -- En el transporte agent_api -el de produccion- la conversacion de Hermes se
  -- identifica con una cadena determinista: helios-<hash de la clave>. Hermes guarda
  -- el hilo de su lado con esa clave, asi que no hay nada que borrar: se le cambia el
  -- nombre. generacion 0 rinde la cadena de siempre -para que desplegar esto NO
  -- reinicie todas las conversaciones abiertas- y a partir de 1 se le añade el
  -- sufijo -gN. Incrementar = conversacion nueva para Hermes.
  generacion        integer NOT NULL DEFAULT 0,

  -- Solo para el transporte webui, que si maneja session_id propios de Hermes.
  -- En agent_api va en null.
  session_id        text,

  created_at        timestamptz NOT NULL DEFAULT now(),
  -- Ultimo turno atendido con esta sesion. Es la referencia de la inactividad.
  updated_at        timestamptz NOT NULL DEFAULT now(),

  turnos            integer NOT NULL DEFAULT 0,
  -- Tokens de entrada del ULTIMO turno. Se mide el anterior porque al decidir la
  -- sesion todavia no se ha llamado a nadie.
  ultimo_input_tokens integer,

  -- Cuantas veces se ha empezado de cero en esta conversacion, y por que la ultima.
  rotaciones        integer NOT NULL DEFAULT 0,
  ultimo_motivo     text,

  -- Lo pone el panel al pedir «empezar de cero». El Adapter lo compara con
  -- updated_at: si es posterior, rota; si es anterior, ya se aplico. Sin esa
  -- comparacion el reset se quedaria pegado y cada mensaje abriria sesion nueva.
  reset_pedido_at   timestamptz,
  reset_pedido_por  text
);

CREATE INDEX IF NOT EXISTS helios_hermes_sessions_conversacion_idx
  ON public.helios_hermes_sessions (tenant_id, conversation_id);

COMMENT ON TABLE public.helios_hermes_sessions IS
  'Sesion de Hermes por conversacion. Sustituye a /tmp/helios-hermes-sessions.json, que se borraba en cada redeploy y no se podia consultar. En agent_api lo que manda es generacion: la conversacion de Hermes es helios-<hash>[-gN] y subir N equivale a empezar de cero. Los contadores deciden cuando rotar: un contexto grande hace que el modelo imite su propio historial.';
