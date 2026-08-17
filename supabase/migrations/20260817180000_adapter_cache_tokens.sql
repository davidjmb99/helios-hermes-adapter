-- Tokens servidos desde caché, para poder calcular el coste EXACTO.
--
-- POR QUÉ HACE FALTA. El coste de un mensaje depende sobre todo de cuántos tokens
-- de entrada vinieron de caché: en DeepSeek un token cacheado cuesta una
-- cincuentava parte de uno nuevo, y en Helios el acierto de caché ronda el 97-98%.
-- Sin ese dato solo se puede dar un RANGO, y con ese factor el rango va de
-- 0,0001 a 0,0056 dólares para el mismo mensaje: inútil para decidir nada.
--
-- El Adapter YA leía cache_read_tokens de la sesión de Hermes, pero no lo
-- guardaba: no existía la columna. Se perdía en cada turno.
--
-- ES ADITIVA. Las columnas nacen NULL y el cálculo ya sabe qué hacer con NULL:
-- devolver el rango, como hasta ahora. Aplicarla no cambia nada por sí sola; lo
-- que cambia es que a partir del despliegue los turnos nuevos sí traen el dato.
-- Los turnos ANTERIORES seguirán mostrando rango para siempre, porque ese dato no
-- se puede recuperar.

BEGIN;

ALTER TABLE public.helios_adapter_events
  ADD COLUMN IF NOT EXISTS cache_read_tokens bigint,
  ADD COLUMN IF NOT EXISTS cache_write_tokens bigint;

ALTER TABLE public.helios_adapter_executions
  ADD COLUMN IF NOT EXISTS cache_read_tokens bigint,
  ADD COLUMN IF NOT EXISTS cache_write_tokens bigint;

COMMENT ON COLUMN public.helios_adapter_events.cache_read_tokens IS
  'Tokens de entrada servidos desde cache. NULL = Hermes no lo reporto en ese turno.';

COMMIT;
