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
END $$;
