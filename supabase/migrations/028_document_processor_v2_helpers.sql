-- =====================================================================
-- 028_document_processor_v2_helpers.sql
-- =====================================================================
-- Doc Processor v2 — Phase v2.0 server-side helpers.
--
-- v1 (migration 025/025b) handles DETECT + FILE + ALERT — runs on every
-- 30-minute cron tick today.  v2 adds STAGE C: parse the PDF inside the
-- Edge Function (no human in the loop) and call sf_comp_recap_ingest with
-- the resulting payload.
--
-- This migration ships the two RPCs the v2 Edge Function needs:
--   1. mark_document_parsed         — atomic per-document status update
--      after stage C completes (success OR failure).
--   2. run_document_processor_backfill — admin-invoked planner returning
--      a jsonb plan for the Edge Function backfill endpoint.
--
-- Phase v2.0 is BEHIND A FLAG (`input_config.groq_parse_enabled=false`)
-- — zero behavior change until the flag flips.
-- =====================================================================

BEGIN;

-- ---------------------------------------------------------------------
-- 1. mark_document_parsed
-- ---------------------------------------------------------------------
-- Called once per document at end of stage C.  Idempotent — re-calling
-- with the same status is a no-op other than processed_at refresh.
--
-- p_status one of:
--   'success'        — parse + ingest both succeeded
--   'parse_failed'   — LLM returned malformed JSON / schema-validation failed
--   'ingest_failed'  — parsed JSON OK but sf_comp_recap_ingest raised
--   'skipped'        — parser ineligible doc_type (shouldn't normally fire)
-- ---------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.mark_document_parsed(
  p_doc_id    uuid,
  p_status    text,
  p_records   integer DEFAULT 0,
  p_error     text DEFAULT NULL,
  p_tables    text[] DEFAULT NULL,
  p_response  jsonb DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row    documents%ROWTYPE;
  v_notes  text;
BEGIN
  -- Lock the row to prevent concurrent stage C reruns from racing
  SELECT * INTO v_row
  FROM   documents
  WHERE  id = p_doc_id
  FOR    UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'mark_document_parsed: document % not found', p_doc_id;
  END IF;

  -- Append a structured audit-trail note; keep prior notes intact
  v_notes := COALESCE(v_row.notes || E'\n', '') ||
             '[parse_v2 ' || to_char(NOW(), 'YYYY-MM-DD HH24:MI:SS') || ' ' || p_status ||
             ' records=' || COALESCE(p_records, 0) ||
             CASE WHEN p_error IS NOT NULL THEN ' err=' || left(p_error, 200) ELSE '' END ||
             ']';

  UPDATE documents
  SET    processing_status = CASE p_status
                               WHEN 'success'       THEN 'parse_success'
                               WHEN 'parse_failed'  THEN 'parse_failed'
                               WHEN 'ingest_failed' THEN 'ingest_failed'
                               WHEN 'skipped'       THEN COALESCE(v_row.processing_status, 'processed')
                               ELSE p_status
                             END,
         records_created  = COALESCE(p_records, v_row.records_created, 0),
         tables_updated   = COALESCE(p_tables,  v_row.tables_updated),
         processed_at     = NOW(),
         notes            = v_notes
  WHERE  id = p_doc_id;

  -- If the parse failed, fire an alert (uses the canonical v1 schema:
  -- alert_type / severity / title / message / module_reference / related_id / is_resolved).
  IF p_status IN ('parse_failed','ingest_failed') THEN
    INSERT INTO alerts (
      agency_id, alert_type, severity, title, message,
      module_reference, related_id, is_resolved, created_at
    )
    VALUES (
      v_row.agency_id,
      'doc_parse_failed',
      'warning',
      'Document parse failed: ' || COALESCE(v_row.file_name, p_doc_id::text),
      'Stage C (' || p_status || ') for document ' || p_doc_id ||
        ' (doc_type=' || COALESCE(v_row.processing_type, '?') || ')' ||
        CASE WHEN p_error IS NOT NULL THEN E'\nError: ' || left(p_error, 500) ELSE '' END ||
        CASE WHEN p_response IS NOT NULL THEN E'\nResponse: ' || left(p_response::text, 500) ELSE '' END,
      'documents:parse_v2',
      p_doc_id,
      false,
      NOW()
    );
  END IF;

  RETURN jsonb_build_object(
    'document_id', p_doc_id,
    'status',      p_status,
    'records',     COALESCE(p_records, 0)
  );
END
$$;

GRANT EXECUTE ON FUNCTION public.mark_document_parsed(uuid,text,integer,text,text[],jsonb)
  TO service_role, authenticated, anon;


-- ---------------------------------------------------------------------
-- 2. run_document_processor_backfill
-- ---------------------------------------------------------------------
-- Returns a jsonb plan for the Edge Function backfill endpoint.
--
-- Capped at 10 documents per call to stay inside the ~60-second Edge
-- Function execution window (each parse leg is ~10-20s of LLM latency).
--
-- IMPORTANT: documents use `processing_type` (NOT `groq_classification`)
-- as the canonical doc-type column.  v1 sets processing_type='sf_comp_recap'
-- for SF Compensation Recap PDFs.
-- ---------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.run_document_processor_backfill(
  p_agency   uuid,
  p_doc_ids  uuid[]
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_plan       jsonb := '[]'::jsonb;
  v_docs_count integer;
  v_doc        record;
BEGIN
  IF p_doc_ids IS NULL OR cardinality(p_doc_ids) = 0 THEN
    RAISE EXCEPTION 'run_document_processor_backfill: p_doc_ids must contain at least 1 uuid';
  END IF;

  v_docs_count := cardinality(p_doc_ids);
  IF v_docs_count > 10 THEN
    RAISE EXCEPTION 'run_document_processor_backfill: max 10 docs per call (got %); split into batches', v_docs_count;
  END IF;

  -- Mark all selected docs as pending_parse so the orchestrator's
  -- regular Gmail-driven path leaves them alone.  Skip rows already
  -- in flight.
  UPDATE documents
  SET    processing_status = 'pending_parse'
  WHERE  agency_id = p_agency
    AND  id = ANY(p_doc_ids)
    AND  processing_status NOT IN ('parse_in_progress');

  -- Build the plan: include every requested doc with its parse-eligibility
  -- flag.  v2.0 ships sf_comp_recap.  paychex_payroll and sf_deduction_stmt
  -- arrive in v2.4 (separate task).
  FOR v_doc IN
    SELECT id, file_name, drive_file_id, drive_url, processing_type, processing_status
    FROM   documents
    WHERE  agency_id = p_agency
      AND  id = ANY(p_doc_ids)
    ORDER BY uploaded_at NULLS LAST
  LOOP
    v_plan := v_plan || jsonb_build_object(
      'document_id',     v_doc.id,
      'file_name',       v_doc.file_name,
      'drive_file_id',   v_doc.drive_file_id,
      'drive_url',       v_doc.drive_url,
      'doc_type',        v_doc.processing_type,
      'current_status',  v_doc.processing_status,
      'parser_eligible', v_doc.processing_type IN ('sf_comp_recap')
    );
  END LOOP;

  RETURN jsonb_build_object(
    'agency_id',       p_agency,
    'requested_count', v_docs_count,
    'documents',       v_plan,
    'generated_at',    to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
  );
END
$$;

GRANT EXECUTE ON FUNCTION public.run_document_processor_backfill(uuid, uuid[])
  TO service_role, authenticated;


-- ---------------------------------------------------------------------
-- 3. Index for backfill / parse-status filtering
-- ---------------------------------------------------------------------

CREATE INDEX IF NOT EXISTS documents_processing_status_type_idx
  ON documents (agency_id, processing_status, processing_type);


-- ---------------------------------------------------------------------
-- 4. Smoke tests (executed at apply-time)
-- ---------------------------------------------------------------------

DO $$
DECLARE
  v_result    jsonb;
BEGIN
  BEGIN
    PERFORM mark_document_parsed(
      '00000000-0000-0000-0000-000000000001'::uuid,
      'success', 0, NULL, NULL, NULL
    );
    RAISE EXCEPTION 'TEST_FAIL: mark_document_parsed should have failed on missing doc';
  EXCEPTION
    WHEN raise_exception THEN
      IF SQLERRM NOT LIKE '%not found%' AND SQLERRM NOT LIKE '%TEST_FAIL%' THEN
        RAISE;
      END IF;
      IF SQLERRM LIKE '%TEST_FAIL%' THEN
        RAISE EXCEPTION '%', SQLERRM;
      END IF;
  END;

  BEGIN
    v_result := run_document_processor_backfill(
      '98aa8b9b-92e4-4ebc-8727-aa00ce696fab'::uuid,
      NULL
    );
    RAISE EXCEPTION 'TEST_FAIL: backfill should have failed on null list';
  EXCEPTION
    WHEN raise_exception THEN
      IF SQLERRM NOT LIKE '%at least 1 uuid%' AND SQLERRM NOT LIKE '%TEST_FAIL%' THEN
        RAISE;
      END IF;
      IF SQLERRM LIKE '%TEST_FAIL%' THEN
        RAISE EXCEPTION '%', SQLERRM;
      END IF;
  END;

  BEGIN
    v_result := run_document_processor_backfill(
      '98aa8b9b-92e4-4ebc-8727-aa00ce696fab'::uuid,
      ARRAY[
        '00000000-0000-0000-0000-000000000001'::uuid,
        '00000000-0000-0000-0000-000000000002'::uuid,
        '00000000-0000-0000-0000-000000000003'::uuid,
        '00000000-0000-0000-0000-000000000004'::uuid,
        '00000000-0000-0000-0000-000000000005'::uuid,
        '00000000-0000-0000-0000-000000000006'::uuid,
        '00000000-0000-0000-0000-000000000007'::uuid,
        '00000000-0000-0000-0000-000000000008'::uuid,
        '00000000-0000-0000-0000-000000000009'::uuid,
        '00000000-0000-0000-0000-000000000010'::uuid,
        '00000000-0000-0000-0000-000000000011'::uuid
      ]
    );
    RAISE EXCEPTION 'TEST_FAIL: backfill should have failed on > 10 docs';
  EXCEPTION
    WHEN raise_exception THEN
      IF SQLERRM NOT LIKE '%max 10%' AND SQLERRM NOT LIKE '%TEST_FAIL%' THEN
        RAISE;
      END IF;
      IF SQLERRM LIKE '%TEST_FAIL%' THEN
        RAISE EXCEPTION '%', SQLERRM;
      END IF;
  END;

  RAISE NOTICE '028_document_processor_v2_helpers: smoke tests passed';
END
$$;

COMMIT;
