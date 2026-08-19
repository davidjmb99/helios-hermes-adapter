-- Coste EXACTO por mensaje, no un rango.
--
-- EL PROBLEMA: la entrada cacheada cuesta $0.007 por millon y la nueva $0.22, o sea
-- treinta y una veces mas. Sin saber cuanta entrada vino de cache, el coste de un
-- turno solo se puede dar como un rango: para un turno real de 126.601 tokens,
-- entre $0.001263 y $0.028229. Un rango de veintidos veces no sirve para decidir
-- nada.
--
-- POR QUE NO SE PODIA SABER: DeepSeek si manda el desglose y Hermes si lo guarda,
-- pero ACUMULADO POR SESION, no por respuesta. Y /v1/responses lo descarta al
-- serializar. Exponerlo por respuesta exigiria tocar codigo compartido, que esta
-- fuera de limites.
--
-- LA SALIDA: el guard del perfil helios -que si esta dentro de limites- inyecta los
-- dos contadores ACUMULADOS de la sesion en cada turno. Y como son acumulados, la
-- RESTA entre dos turnos consecutivos de la misma sesion da el desglose exacto de
-- ese turno. No es una estimacion: es aritmetica.
--
-- Y trae su propia comprobacion: si (delta_cache + delta_nuevos) coincide con los
-- input_tokens que reporta el turno, el desglose es correcto por construccion. Si
-- no coincide, no se afirma nada y se vuelve al rango.
ALTER TABLE public.helios_adapter_events
  ADD COLUMN IF NOT EXISTS cache_acumulado_hit bigint,
  ADD COLUMN IF NOT EXISTS cache_acumulado_nuevos bigint,
  ADD COLUMN IF NOT EXISTS cache_desglose_origen text;

-- El calculo del delta busca el turno ANTERIOR de la misma sesion de Hermes.
CREATE INDEX IF NOT EXISTS idx_adapter_events_sesion_hermes
  ON public.helios_adapter_events (hermes_conversation_id, created_at DESC)
  WHERE hermes_conversation_id IS NOT NULL;
