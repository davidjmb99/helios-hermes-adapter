-- Reabrir una ejecucion que se guardo como «completed» pero cuyo resultado fue un fallo.
--
-- EL PROBLEMA, EN UNA FRASE: un reintento no vuelve a llamar a Hermes.
--
-- Los mismos mensajes de origen producen la misma `request_key`. Si esa clave ya esta
-- `completed`, `claim_helios_adapter_execution` devuelve el resultado GUARDADO y el
-- Adapter no llega a hablar con Hermes. Eso es correcto cuando el turno salio bien -es
-- justo lo que impide contestarle dos veces al mismo paciente-.
--
-- PERO UN TURNO PUEDE QUEDAR «completed» HABIENDO FALLADO. El caso real: Hermes contesta,
-- el guard de salida veta la respuesta, y lo que se persiste es un `normalized_result` con
-- `ok: false`. El estado de la EJECUCION es «completed» -termino- pero el RESULTADO es un
-- fallo, y el paciente no recibio nada.
--
-- Desde el 18 de agosto eso no entra en bucle: el Adapter lo detecta y devuelve
-- REINTENTO_ABANDONADO con `recoverable: false`. O sea que hoy no se repite, SE RINDE. El
-- mensaje de ese paciente se pierde para siempre por un fallo que pudo ser pasajero.
--
-- LO QUE HACE ESTA FUNCION: devolver la ejecucion a `failed_recoverable`, que es el estado
-- que el `claim` ya sabe re-ejecutar. Un reintento vuelve a llamar a Hermes de verdad.
--
-- LAS TRES CONDICIONES SON DE SEGURIDAD, NO DE ESTILO:
--
--   ok = false          el resultado guardado fue un fallo. Un exito NO se reabre nunca:
--                       eso es la idempotencia y romperla es peor que el problema.
--   safe_to_send        el Gateway solo publica cuando esto es true. Si no lo es, al
--                       paciente NO le llego nada, y por eso re-ejecutar no puede
--                       duplicarle un mensaje. Es la garantia que sostiene todo esto.
--   response_sent       lo mismo por el otro lado.
--
-- Y EL LIMITE DE INTENTOS NO SOBRA. Si el fallo es permanente -un SOUL mal escrito, una
-- herramienta caida- re-ejecutar solo gasta tokens. Con el limite, se intenta un par de
-- veces y despues se abandona como hasta ahora.
--
-- LO QUE ESTA FUNCION NO PUEDE GARANTIZAR, Y HAY QUE SABERLO: re-ejecutar vuelve a correr
-- las HERRAMIENTAS del turno. La agenda es segura -el id del evento es determinista y
-- Google devuelve 409, que se lee como exito-, pero las demas herramientas viven en Hermes
-- y desde aqui no se pueden comprobar. Por eso el limite es bajo.
--
-- SE ENTREGA APAGADA. El Adapter solo la llama si ADAPTER_MAX_REINTENTOS_DE_FALLO es mayor
-- que cero, y por defecto es cero. Desplegar esto no cambia el comportamiento de nadie.

BEGIN;

CREATE OR REPLACE FUNCTION public.reabrir_helios_adapter_execution(
  p_request_key text,
  p_max_intentos integer DEFAULT 1
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO pg_catalog, public
AS $function$
DECLARE
  updated_row public.helios_adapter_executions%ROWTYPE;
BEGIN
  IF p_max_intentos IS NULL OR p_max_intentos < 1 THEN
    RETURN jsonb_build_object('reabierta', false, 'motivo', 'desactivada');
  END IF;

  -- TODAS LAS CONDICIONES VAN EN EL `WHERE` A PROPOSITO. Si dos peticiones llegan a la
  -- vez, solo una encuentra la fila en `completed` y la cambia; la otra no actualiza nada
  -- y se le dice que no. Comprobar antes y actualizar despues abriria justo el hueco por
  -- el que se le contesta dos veces al mismo paciente.
  UPDATE public.helios_adapter_executions
  SET status = 'failed_recoverable',
      lease_owner = null,
      lease_expires_at = null,
      updated_at = now()
  WHERE request_key = p_request_key
    AND status = 'completed'
    AND attempt_count <= p_max_intentos
    -- COALESCE con el valor SEGURO en cada caso: si el campo no esta, se supone que el
    -- turno salio bien y que si se envio. Un resultado sin estos campos no se reabre.
    AND COALESCE((normalized_result->>'ok')::boolean, true) = false
    AND COALESCE((normalized_result->>'safe_to_send')::boolean, true) = false
    AND COALESCE((normalized_result->>'response_sent')::boolean, true) = false
  RETURNING * INTO updated_row;

  IF updated_row.request_key IS NULL THEN
    RETURN jsonb_build_object('reabierta', false, 'motivo', 'no_procede');
  END IF;

  RETURN jsonb_build_object(
    'reabierta', true,
    'intentos_previos', updated_row.attempt_count,
    'error_code_original', updated_row.normalized_result->>'error_code'
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.reabrir_helios_adapter_execution(text, integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reabrir_helios_adapter_execution(text, integer)
  TO service_role;

COMMIT;
