-- =========================================================================
-- 025_document_processor_orchestrator_helpers.sql
-- =========================================================================
-- Canonical consolidated file representing the final DB state after the
-- 2026-06-17 Layer 3 v1 ship. Combines two timestamped migrations that
-- were applied in sequence to the live database:
--   20260617021429  025_document_processor_orchestrator_helpers
--   20260617021514  025b_fix_log_document_processor_result_remove_related_table
--
-- Both sections use CREATE OR REPLACE so this file is idempotent.
-- =========================================================================

-- =========================================================================
-- 025_document_processor_orchestrator_helpers
-- =========================================================================
-- Two Postgres helper functions consumed by runDocumentProcessorOrchestrator()
-- in supabase/functions/automation-runner/index.ts (Edge Function v6+).
--
-- Mirrors the Email Archiver pattern shipped in migration 024:
--   payload_rpc -> prepare_document_processor_batch
--   result_rpc  -> log_document_processor_result
--
-- The orchestrator handles three document types from kwametyler.businessclaude@gmail.com:
--   1. SF Compensation Recap PDFs (sender ~ statefarm.com, subj ~ "recap")
--   2. Paychex payroll reports (sender ~ paychex.com)
--   3. SF Deduction Statements (sender ~ statefarm.com, subj ~ "deduction")
--
-- v1 SCOPE (this migration + Edge Function v6):
--   - Detect, dedup, file to Drive, INSERT documents row, fire alert
--     "<type> arrived — needs ingest" with the parser script reference.
--   - No LLM-driven parse yet. The actual sf_comp_recap_ingest call still happens
--     via scripts/parsers/sf_comp_recap.py (manual backstop) on Kwame's command.
--   - Layer 3 v2 will add the in-Edge-Function LLM parse (Option B multimodal).
-- =========================================================================

-- -------------------------------------------------------------------------
-- prepare_document_processor_batch
-- -------------------------------------------------------------------------
-- Computes the Gmail query for the orchestrator's GMAIL_FETCH_EMAILS call
-- and returns the dedup set so already-processed messages are skipped.
--
-- gmail_query targets the BCC inbox for SF + Paychex content arrived in
-- the last <lookback_minutes> with attachments, excluding archive/trash/spam.
--
-- dedup_message_ids[] is pulled from documents.notes by regex 'gmail_msg=([a-f0-9]+)'
-- — same pattern Email Archiver uses.
-- -------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.prepare_document_processor_batch(
  p_agency_id        uuid,
  p_lookback_minutes int DEFAULT 60,
  p_max_batch        int DEFAULT 10
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_cutoff_epoch  bigint;
  v_dedup_ids     text[];
  v_dedup_count   int;
  v_gmail_query   text;
BEGIN
  -- Gmail's `after:` operator takes a unix epoch (seconds).
  v_cutoff_epoch := EXTRACT(EPOCH FROM (NOW() - (p_lookback_minutes || ' minutes')::interval))::bigint;

  -- Build dedup set from documents.notes (regex extract gmail_msg=<hex_id>)
  SELECT COALESCE(array_agg(DISTINCT msg_id), ARRAY[]::text[])
  INTO   v_dedup_ids
  FROM (
    SELECT (regexp_match(notes, 'gmail_msg=([a-f0-9]+)'))[1] AS msg_id
    FROM documents
    WHERE agency_id = p_agency_id
      AND notes IS NOT NULL
      AND notes ~ 'gmail_msg=[a-f0-9]+'
  ) sub
  WHERE msg_id IS NOT NULL;

  v_dedup_count := COALESCE(array_length(v_dedup_ids, 1), 0);

  -- Compose query. Targets SF + Paychex. has:attachment + after:<epoch> + not-archived.
  -- 'BCC-Processed' label is the post-archive marker — exclude messages already there.
  v_gmail_query := format(
    'has:attachment after:%s -in:trash -in:spam -label:BCC-Processed (from:statefarm.com OR from:paychex.com)',
    v_cutoff_epoch
  );

  RETURN jsonb_build_object(
    'gmail_query',        v_gmail_query,
    'cutoff_epoch',       v_cutoff_epoch,
    'lookback_minutes',   p_lookback_minutes,
    'max_batch',          LEAST(p_max_batch, 25),  -- safety ceiling
    'dedup_message_ids',  to_jsonb(v_dedup_ids),
    'dedup_count',        v_dedup_count,
    'settings', jsonb_build_object(
      'route_to_drive',            true,
      'drive_folder_template',     'BCC Financial Records/Live Documents (May 2026 forward)/{{category}}/{{year}}',
      'alert_on_ingest_pending',   true,
      'classify_by_filename_regex', true
    )
  );
END;
$$;

COMMENT ON FUNCTION public.prepare_document_processor_batch(uuid, int, int)
IS 'Layer 1 of Document Processor (Layer 3 orchestrator). Returns Gmail query + dedup set. Mirrors prepare_email_archive_batch.';


-- -------------------------------------------------------------------------
-- log_document_processor_result
-- -------------------------------------------------------------------------
-- Accepts the orchestrator's callback payload and:
--   1. Inserts a documents row for each successfully-filed PDF
--      (dedup'd against existing rows by drive_file_id).
--   2. Inserts an alert per pending-ingest item (Comp Recap especially).
--   3. Returns a summary that the Edge Function writes to automation_run_log.
--
-- Callback payload shape (from the orchestrator):
-- {
--   "processed": [
--     {
--       "message_id":       "19e559bc1ffaeacf",
--       "subject":           "Your 2026 Mid-Month Compensation Recap",
--       "from":              "noreply@statefarm.com",
--       "file_name":         "Compensation_Recap_2026_05_15.pdf",
--       "file_type":         "application/pdf",
--       "drive_file_id":     "1abc...",
--       "drive_url":         "https://drive.google.com/file/d/1abc.../view",
--       "doc_type":          "sf_comp_recap" | "paychex_payroll" | "sf_deduction_stmt" | "other",
--       "needs_ingest":      true,
--       "ingest_handler":    "sf_comp_recap_ingest" | null,
--       "period_hint":       "2026-05-second"  -- optional, from filename
--     },
--     ...
--   ],
--   "skipped":  [{message_id, reason}],
--   "errors":   [{message_id, error}]
-- }
-- -------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.log_document_processor_result(
  p_agency_id  uuid,
  p_recipe_id  uuid,
  p_result     jsonb
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_processed       jsonb := COALESCE(p_result->'processed', '[]'::jsonb);
  v_skipped         jsonb := COALESCE(p_result->'skipped',   '[]'::jsonb);
  v_errors          jsonb := COALESCE(p_result->'errors',    '[]'::jsonb);
  v_item            jsonb;
  v_documents_inserted int := 0;
  v_documents_skipped  int := 0;
  v_alerts_created     int := 0;
  v_doc_id          uuid;
  v_doc_type        text;
  v_summary         text;
  v_existing_id     uuid;
BEGIN
  -- Loop each processed item: insert documents row (dedup by drive_file_id),
  -- then fire alert if needs_ingest=true.
  FOR v_item IN SELECT * FROM jsonb_array_elements(v_processed)
  LOOP
    v_doc_type := COALESCE(v_item->>'doc_type', 'other');

    -- Dedup: skip if this drive_file_id already in documents
    SELECT id INTO v_existing_id
    FROM documents
    WHERE agency_id = p_agency_id
      AND drive_file_id = v_item->>'drive_file_id'
    LIMIT 1;

    IF v_existing_id IS NOT NULL THEN
      v_documents_skipped := v_documents_skipped + 1;
      CONTINUE;
    END IF;

    INSERT INTO documents (
      agency_id, file_name, file_type, drive_file_id, drive_url,
      processing_type, processing_status, processed_at,
      notes
    ) VALUES (
      p_agency_id,
      v_item->>'file_name',
      v_item->>'file_type',
      v_item->>'drive_file_id',
      v_item->>'drive_url',
      v_doc_type,
      CASE WHEN COALESCE((v_item->>'needs_ingest')::boolean, false)
           THEN 'awaiting_ingest'
           ELSE 'processed' END,
      NOW(),
      format(
        'Auto-filed by Document Processor (recipe_id=%s; gmail_msg=%s; subject=%s; from=%s)',
        p_recipe_id::text,
        v_item->>'message_id',
        COALESCE(v_item->>'subject', '?'),
        COALESCE(v_item->>'from', '?')
      )
    )
    RETURNING id INTO v_doc_id;

    v_documents_inserted := v_documents_inserted + 1;

    -- Fire alert for SF Comp Recap (which still needs manual parser run)
    IF v_doc_type = 'sf_comp_recap' AND COALESCE((v_item->>'needs_ingest')::boolean, false) THEN
      INSERT INTO alerts (
        agency_id, alert_type, severity, title, message,
        module_reference, related_id, related_table, is_resolved
      ) VALUES (
        p_agency_id,
        'document_pending_ingest',
        'info',
        'SF Compensation Recap PDF arrived — needs ingest',
        format(
          'Document Processor auto-filed "%s" to Drive (period: %s). Run scripts/parsers/sf_comp_recap.py from a Composio sandbox to ingest into comp_recap. See scripts/parsers/README.md for the runbook.',
          v_item->>'file_name',
          COALESCE(v_item->>'period_hint', 'unknown — read from PDF')
        ),
        'documents:sf_comp_recap',
        v_doc_id,
        'documents',
        false
      );
      v_alerts_created := v_alerts_created + 1;
    END IF;

    -- Fire alert for Paychex payroll report (needs CSV ingestion to payroll_runs)
    IF v_doc_type = 'paychex_payroll' AND COALESCE((v_item->>'needs_ingest')::boolean, false) THEN
      INSERT INTO alerts (
        agency_id, alert_type, severity, title, message,
        module_reference, related_id, related_table, is_resolved
      ) VALUES (
        p_agency_id,
        'document_pending_ingest',
        'info',
        'Paychex payroll report arrived — needs ingest',
        format(
          'Document Processor auto-filed "%s" to Drive. Payroll CSV ingestion to payroll_runs/payroll_detail is not yet wired — manual handling required.',
          v_item->>'file_name'
        ),
        'documents:paychex_payroll',
        v_doc_id,
        'documents',
        false
      );
      v_alerts_created := v_alerts_created + 1;
    END IF;

    -- Fire alert for SF Deduction Statement (cross-reference against comp_recap)
    IF v_doc_type = 'sf_deduction_stmt' AND COALESCE((v_item->>'needs_ingest')::boolean, false) THEN
      INSERT INTO alerts (
        agency_id, alert_type, severity, title, message,
        module_reference, related_id, related_table, is_resolved
      ) VALUES (
        p_agency_id,
        'document_pending_ingest',
        'info',
        'SF Deduction Statement arrived — review',
        format(
          'Document Processor auto-filed "%s" to Drive. Cross-reference against comp_recap deductions; mark monthly_close_checklist item received if reconciled.',
          v_item->>'file_name'
        ),
        'documents:sf_deduction_stmt',
        v_doc_id,
        'documents',
        false
      );
      v_alerts_created := v_alerts_created + 1;
    END IF;
  END LOOP;

  v_summary := format(
    '%s docs filed (%s dedup-skipped); %s alerts created; %s skipped; %s errors',
    v_documents_inserted,
    v_documents_skipped,
    v_alerts_created,
    jsonb_array_length(v_skipped),
    jsonb_array_length(v_errors)
  );

  RETURN jsonb_build_object(
    'status', 'ok',
    'documents_inserted', v_documents_inserted,
    'documents_dedup_skipped', v_documents_skipped,
    'alerts_created', v_alerts_created,
    'skipped_count', jsonb_array_length(v_skipped),
    'error_count', jsonb_array_length(v_errors),
    'output_summary', v_summary
  );
END;
$$;

COMMENT ON FUNCTION public.log_document_processor_result(uuid, uuid, jsonb)
IS 'Layer 1 result_rpc for Document Processor (Layer 3 orchestrator). Inserts documents rows + alerts. Mirrors log_email_archive_result.';

-- Smoke test: dry-run the prepare function so we see the resulting query shape
SELECT public.prepare_document_processor_batch(
  '98aa8b9b-92e4-4ebc-8727-aa00ce696fab'::uuid,
  60,   -- lookback minutes
  10    -- max batch
) AS smoke_test_output;;

-- =========================================================================
-- Part 2: 025b — fix log_document_processor_result (drop related_table col
-- references; alerts table has no such column). Supersedes the version of
-- log_document_processor_result defined in Part 1 above.
-- =========================================================================

-- Fix: alerts table has no related_table column. Drop those references from
-- log_document_processor_result. Function is otherwise unchanged.

CREATE OR REPLACE FUNCTION public.log_document_processor_result(
  p_agency_id  uuid,
  p_recipe_id  uuid,
  p_result     jsonb
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_processed       jsonb := COALESCE(p_result->'processed', '[]'::jsonb);
  v_skipped         jsonb := COALESCE(p_result->'skipped',   '[]'::jsonb);
  v_errors          jsonb := COALESCE(p_result->'errors',    '[]'::jsonb);
  v_item            jsonb;
  v_documents_inserted int := 0;
  v_documents_skipped  int := 0;
  v_alerts_created     int := 0;
  v_doc_id          uuid;
  v_doc_type        text;
  v_summary         text;
  v_existing_id     uuid;
BEGIN
  FOR v_item IN SELECT * FROM jsonb_array_elements(v_processed)
  LOOP
    v_doc_type := COALESCE(v_item->>'doc_type', 'other');

    SELECT id INTO v_existing_id
    FROM documents
    WHERE agency_id = p_agency_id
      AND drive_file_id = v_item->>'drive_file_id'
    LIMIT 1;

    IF v_existing_id IS NOT NULL THEN
      v_documents_skipped := v_documents_skipped + 1;
      CONTINUE;
    END IF;

    INSERT INTO documents (
      agency_id, file_name, file_type, drive_file_id, drive_url,
      processing_type, processing_status, processed_at,
      upload_source, uploaded_by, uploaded_at, notes
    ) VALUES (
      p_agency_id,
      v_item->>'file_name',
      v_item->>'file_type',
      v_item->>'drive_file_id',
      v_item->>'drive_url',
      v_doc_type,
      CASE WHEN COALESCE((v_item->>'needs_ingest')::boolean, false)
           THEN 'awaiting_ingest'
           ELSE 'processed' END,
      NOW(),
      'gmail_auto',
      'document_processor_orchestrator',
      NOW(),
      format(
        'Auto-filed by Document Processor (recipe_id=%s; gmail_msg=%s; subject=%s; from=%s)',
        p_recipe_id::text,
        v_item->>'message_id',
        COALESCE(v_item->>'subject', '?'),
        COALESCE(v_item->>'from', '?')
      )
    )
    RETURNING id INTO v_doc_id;

    v_documents_inserted := v_documents_inserted + 1;

    IF v_doc_type = 'sf_comp_recap' AND COALESCE((v_item->>'needs_ingest')::boolean, false) THEN
      INSERT INTO alerts (
        agency_id, alert_type, severity, title, message,
        module_reference, related_id, is_resolved
      ) VALUES (
        p_agency_id, 'document_pending_ingest', 'info',
        'SF Compensation Recap PDF arrived — needs ingest',
        format(
          'Document Processor auto-filed "%s" to Drive (period: %s). Run scripts/parsers/sf_comp_recap.py from a Composio sandbox to ingest into comp_recap. See scripts/parsers/README.md for the runbook.',
          v_item->>'file_name',
          COALESCE(v_item->>'period_hint', 'read from PDF')
        ),
        'documents:sf_comp_recap', v_doc_id, false
      );
      v_alerts_created := v_alerts_created + 1;
    END IF;

    IF v_doc_type = 'paychex_payroll' AND COALESCE((v_item->>'needs_ingest')::boolean, false) THEN
      INSERT INTO alerts (
        agency_id, alert_type, severity, title, message,
        module_reference, related_id, is_resolved
      ) VALUES (
        p_agency_id, 'document_pending_ingest', 'info',
        'Paychex payroll report arrived — needs ingest',
        format(
          'Document Processor auto-filed "%s" to Drive. Payroll CSV ingestion to payroll_runs/payroll_detail is not yet wired — manual handling required.',
          v_item->>'file_name'
        ),
        'documents:paychex_payroll', v_doc_id, false
      );
      v_alerts_created := v_alerts_created + 1;
    END IF;

    IF v_doc_type = 'sf_deduction_stmt' AND COALESCE((v_item->>'needs_ingest')::boolean, false) THEN
      INSERT INTO alerts (
        agency_id, alert_type, severity, title, message,
        module_reference, related_id, is_resolved
      ) VALUES (
        p_agency_id, 'document_pending_ingest', 'info',
        'SF Deduction Statement arrived — review',
        format(
          'Document Processor auto-filed "%s" to Drive. Cross-reference against comp_recap deductions; mark monthly_close_checklist item received if reconciled.',
          v_item->>'file_name'
        ),
        'documents:sf_deduction_stmt', v_doc_id, false
      );
      v_alerts_created := v_alerts_created + 1;
    END IF;
  END LOOP;

  v_summary := format(
    '%s docs filed (%s dedup-skipped); %s alerts created; %s skipped; %s errors',
    v_documents_inserted, v_documents_skipped, v_alerts_created,
    jsonb_array_length(v_skipped), jsonb_array_length(v_errors)
  );

  RETURN jsonb_build_object(
    'status', 'ok',
    'documents_inserted', v_documents_inserted,
    'documents_dedup_skipped', v_documents_skipped,
    'alerts_created', v_alerts_created,
    'skipped_count', jsonb_array_length(v_skipped),
    'error_count', jsonb_array_length(v_errors),
    'output_summary', v_summary
  );
END;
$$;

-- ============= SMOKE TEST: dry-run with a fake payload ===================
DO $$
DECLARE
  v_test_result jsonb;
BEGIN
  v_test_result := public.log_document_processor_result(
    '98aa8b9b-92e4-4ebc-8727-aa00ce696fab'::uuid,
    'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'::uuid,  -- fake recipe_id for the smoke test
    '{"processed":[],"skipped":[{"message_id":"x","reason":"test"}],"errors":[]}'::jsonb
  );
  RAISE NOTICE 'Smoke test result: %', v_test_result;
END $$;;