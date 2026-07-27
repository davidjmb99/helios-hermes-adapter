BEGIN;

ALTER TABLE public.helios_adapter_events
  ADD COLUMN IF NOT EXISTS trace_id text,
  ADD COLUMN IF NOT EXISTS tenant_id text,
  ADD COLUMN IF NOT EXISTS conversation_id text,
  ADD COLUMN IF NOT EXISTS contact_id text,
  ADD COLUMN IF NOT EXISTS request_key text,
  ADD COLUMN IF NOT EXISTS parent_trace_id text,
  ADD COLUMN IF NOT EXISTS account_id text,
  ADD COLUMN IF NOT EXISTS clinic_id text,
  ADD COLUMN IF NOT EXISTS hermes_profile text,
  ADD COLUMN IF NOT EXISTS patient_first_name text,
  ADD COLUMN IF NOT EXISTS patient_last_name text,
  ADD COLUMN IF NOT EXISTS patient_display_name text,
  ADD COLUMN IF NOT EXISTS phone text,
  ADD COLUMN IF NOT EXISTS message_content text,
  ADD COLUMN IF NOT EXISTS response_content text,
  ADD COLUMN IF NOT EXISTS processing_stage text,
  ADD COLUMN IF NOT EXISTS hermes_transport text,
  ADD COLUMN IF NOT EXISTS hermes_conversation_id text,
  ADD COLUMN IF NOT EXISTS hermes_response_id text,
  ADD COLUMN IF NOT EXISTS idempotency_status text,
  ADD COLUMN IF NOT EXISTS input_tokens bigint,
  ADD COLUMN IF NOT EXISTS output_tokens bigint,
  ADD COLUMN IF NOT EXISTS total_tokens bigint,
  ADD COLUMN IF NOT EXISTS model text,
  ADD COLUMN IF NOT EXISTS tool_names jsonb,
  ADD COLUMN IF NOT EXISTS tool_count integer,
  ADD COLUMN IF NOT EXISTS duration_ms bigint,
  ADD COLUMN IF NOT EXISTS hermes_duration_ms bigint,
  ADD COLUMN IF NOT EXISTS http_status integer,
  ADD COLUMN IF NOT EXISTS error_code text,
  ADD COLUMN IF NOT EXISTS started_at timestamptz,
  ADD COLUMN IF NOT EXISTS finished_at timestamptz,
  ADD COLUMN IF NOT EXISTS completed_at timestamptz,
  ADD COLUMN IF NOT EXISTS telemetry_incomplete boolean NOT NULL DEFAULT false;

DO $block$
DECLARE
  status_attnum smallint;
  constraint_name text;
BEGIN
  SELECT attnum INTO status_attnum
  FROM pg_attribute
  WHERE attrelid = 'public.helios_adapter_events'::regclass
    AND attname = 'status'
    AND NOT attisdropped;

  FOR constraint_name IN
    SELECT conname
    FROM pg_constraint
    WHERE conrelid = 'public.helios_adapter_events'::regclass
      AND contype = 'c'
      AND status_attnum = ANY (conkey)
  LOOP
    EXECUTE format(
      'ALTER TABLE public.helios_adapter_events DROP CONSTRAINT %I',
      constraint_name
    );
  END LOOP;
END;
$block$;

ALTER TABLE public.helios_adapter_events
  ADD CONSTRAINT helios_adapter_events_status_check
  CHECK (status IN (
    'processing',
    'completed',
    'failed_recoverable',
    'failed_final',
    'deduplicated',
    'waiting_existing_execution',
    'ok',
    'error',
    'buffered'
  )) NOT VALID;

CREATE INDEX IF NOT EXISTS idx_adapter_events_request_key
  ON public.helios_adapter_events(request_key);
CREATE INDEX IF NOT EXISTS idx_adapter_events_processing
  ON public.helios_adapter_events(status, started_at)
  WHERE status = 'processing';

COMMIT;
