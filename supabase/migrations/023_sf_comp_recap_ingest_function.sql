-- ============================================================================
-- sf_comp_recap_ingest — persistent, idempotent ingest function for SF Compensation Recap data.
-- ============================================================================
-- INPUT CONTRACT (p_payload jsonb):
-- {
--   "period_year": 2026,
--   "period_month": 5,
--   "period_half": "first" | "second",
--   "recap_date": "2026-05-31",
--   "reconciliation": {
--     "half_month_total_pdf": 266777.60,
--     "ytd_total_pdf": 1097824.69
--   },
--   "lines": [
--     {
--       "line_sequence": 1,
--       "comp_type": "MUTL",
--       "comp_category": "new_business",
--       "description": "AUTO NEW BUSINESS",
--       "current_amount": 2488.23,
--       "ytd_amount": 14818.23,
--       "is_aipp_eligible": true,
--       "is_scoreboard_eligible": true
--     }, ...
--   ]
-- }
--
-- RETURNS jsonb:
-- {
--   "status": "ok" | "error",
--   "error_reason": "...",
--   "rows_inserted": 60,
--   "rows_deleted": 60,
--   "reconciliation": {
--     "half_month_sum_db": 266777.60, "half_month_total_pdf": 266777.60, "half_month_delta": 0.00, "half_month_ok": true,
--     "ytd_sum_db":         1097824.69, "ytd_total_pdf":         1097824.69, "ytd_delta":         0.00, "ytd_ok":         true
--   }
-- }
--
-- Idempotency: keyed on (agency_id, period_year, period_month, period_half).
-- Re-running with the same period replaces all rows for that half.
-- Safety: errors if any existing rows for that period_half have journal_entry_id set
-- unless p_force_replace=true (which will orphan the JEs and should be paired with
-- manual GL reversal).
-- ============================================================================

CREATE OR REPLACE FUNCTION public.sf_comp_recap_ingest(
  p_agency_id uuid,
  p_document_id uuid,
  p_payload jsonb,
  p_force_replace boolean DEFAULT false
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
AS $function$
DECLARE
  v_period_year       int;
  v_period_month      int;
  v_period_half       text;
  v_recap_date        date;
  v_pdf_half_total    numeric;
  v_pdf_ytd_total     numeric;
  v_lines             jsonb;
  v_line              jsonb;
  v_existing_count    int;
  v_posted_count      int;
  v_rows_deleted      int;
  v_rows_inserted     int := 0;
  v_db_half_sum       numeric;
  v_db_ytd_sum        numeric;
  v_half_delta        numeric;
  v_ytd_delta         numeric;
  v_half_ok           boolean;
  v_ytd_ok            boolean;
  v_tolerance         numeric := 0.10;
BEGIN
  -- ============================================================
  -- 1. Validate payload structure
  -- ============================================================
  IF p_payload IS NULL OR jsonb_typeof(p_payload) <> 'object' THEN
    RETURN jsonb_build_object('status','error','error_reason','payload must be a JSON object');
  END IF;

  v_period_year    := (p_payload->>'period_year')::int;
  v_period_month   := (p_payload->>'period_month')::int;
  v_period_half    := p_payload->>'period_half';
  v_recap_date     := (p_payload->>'recap_date')::date;
  v_pdf_half_total := (p_payload->'reconciliation'->>'half_month_total_pdf')::numeric;
  v_pdf_ytd_total  := (p_payload->'reconciliation'->>'ytd_total_pdf')::numeric;
  v_lines          := p_payload->'lines';

  IF v_period_year IS NULL OR v_period_month IS NULL OR v_period_half IS NULL THEN
    RETURN jsonb_build_object('status','error','error_reason','period_year, period_month, period_half are required');
  END IF;
  IF v_period_month < 1 OR v_period_month > 12 THEN
    RETURN jsonb_build_object('status','error','error_reason','period_month must be 1-12');
  END IF;
  IF v_period_half NOT IN ('first','second') THEN
    RETURN jsonb_build_object('status','error','error_reason','period_half must be ''first'' or ''second''');
  END IF;
  IF v_recap_date IS NULL THEN
    RETURN jsonb_build_object('status','error','error_reason','recap_date is required');
  END IF;
  IF v_pdf_half_total IS NULL OR v_pdf_ytd_total IS NULL THEN
    RETURN jsonb_build_object('status','error','error_reason','reconciliation.half_month_total_pdf and ytd_total_pdf are required');
  END IF;
  IF v_lines IS NULL OR jsonb_typeof(v_lines) <> 'array' OR jsonb_array_length(v_lines) = 0 THEN
    RETURN jsonb_build_object('status','error','error_reason','lines must be a non-empty array');
  END IF;

  -- ============================================================
  -- 2. Check for prior rows for this period_half + GL-posted safety check
  -- ============================================================
  SELECT COUNT(*), COUNT(*) FILTER (WHERE journal_entry_id IS NOT NULL)
    INTO v_existing_count, v_posted_count
  FROM public.comp_recap
  WHERE agency_id = p_agency_id
    AND period_year = v_period_year
    AND period_month = v_period_month
    AND period_half = v_period_half;

  IF v_posted_count > 0 AND NOT p_force_replace THEN
    RETURN jsonb_build_object(
      'status','error',
      'error_reason', format(
        'Period %s-%s-%s already has %s GL-posted comp_recap rows. Pass p_force_replace=true to override (will orphan journal_entries — pair with manual GL reversal).',
        v_period_year, lpad(v_period_month::text,2,'0'), v_period_half, v_posted_count
      ),
      'existing_rows', v_existing_count,
      'posted_rows', v_posted_count
    );
  END IF;

  -- ============================================================
  -- 3. Delete existing rows for the period (idempotent re-ingest)
  -- ============================================================
  DELETE FROM public.comp_recap
  WHERE agency_id = p_agency_id
    AND period_year = v_period_year
    AND period_month = v_period_month
    AND period_half = v_period_half;
  GET DIAGNOSTICS v_rows_deleted = ROW_COUNT;

  -- ============================================================
  -- 4. Insert two rows per line (half_month_activity + ytd_snapshot)
  -- ============================================================
  FOR v_line IN SELECT * FROM jsonb_array_elements(v_lines)
  LOOP
    -- half_month_activity row
    INSERT INTO public.comp_recap (
      agency_id, period_year, period_month, period_half, recap_date,
      line_sequence, comp_type, comp_category, description,
      amount, amount_type, is_aipp_eligible, is_scoreboard_eligible,
      source_document_id, created_at
    ) VALUES (
      p_agency_id, v_period_year, v_period_month, v_period_half, v_recap_date,
      (v_line->>'line_sequence')::int,
      NULLIF(v_line->>'comp_type',''),
      NULLIF(v_line->>'comp_category',''),
      v_line->>'description',
      COALESCE((v_line->>'current_amount')::numeric, 0),
      'half_month_activity',
      COALESCE((v_line->>'is_aipp_eligible')::boolean, false),
      COALESCE((v_line->>'is_scoreboard_eligible')::boolean, false),
      p_document_id, NOW()
    );
    v_rows_inserted := v_rows_inserted + 1;

    -- ytd_snapshot row
    INSERT INTO public.comp_recap (
      agency_id, period_year, period_month, period_half, recap_date,
      line_sequence, comp_type, comp_category, description,
      amount, amount_type, is_aipp_eligible, is_scoreboard_eligible,
      source_document_id, created_at
    ) VALUES (
      p_agency_id, v_period_year, v_period_month, v_period_half, v_recap_date,
      (v_line->>'line_sequence')::int,
      NULLIF(v_line->>'comp_type',''),
      NULLIF(v_line->>'comp_category',''),
      v_line->>'description',
      COALESCE((v_line->>'ytd_amount')::numeric, 0),
      'ytd_snapshot',
      COALESCE((v_line->>'is_aipp_eligible')::boolean, false),
      COALESCE((v_line->>'is_scoreboard_eligible')::boolean, false),
      p_document_id, NOW()
    );
    v_rows_inserted := v_rows_inserted + 1;
  END LOOP;

  -- ============================================================
  -- 5. Reconcile DB sums vs PDF reported totals
  -- ============================================================
  SELECT
    COALESCE(SUM(amount) FILTER (WHERE amount_type='half_month_activity'), 0),
    COALESCE(SUM(amount) FILTER (WHERE amount_type='ytd_snapshot'),         0)
    INTO v_db_half_sum, v_db_ytd_sum
  FROM public.comp_recap
  WHERE agency_id = p_agency_id
    AND period_year = v_period_year
    AND period_month = v_period_month
    AND period_half = v_period_half;

  v_half_delta := round(v_db_half_sum - v_pdf_half_total, 2);
  v_ytd_delta  := round(v_db_ytd_sum  - v_pdf_ytd_total,  2);
  v_half_ok    := abs(v_half_delta) <= v_tolerance;
  v_ytd_ok     := abs(v_ytd_delta)  <= v_tolerance;

  -- ============================================================
  -- 6. Stamp the documents row with the result
  -- ============================================================
  IF p_document_id IS NOT NULL THEN
    UPDATE public.documents
    SET processing_status = CASE WHEN v_half_ok AND v_ytd_ok THEN 'processed' ELSE 'processed_with_warnings' END,
        processing_type   = 'sf_comp_recap',
        tables_updated    = ARRAY['comp_recap']::text[],
        records_created   = v_rows_inserted,
        processed_at      = NOW(),
        notes             = format(
          'SF Comp Recap %s-%s-%s ingested via sf_comp_recap_ingest. %s rows inserted (%s replaced). Recon: half=$%s (PDF $%s, delta $%s, %s); ytd=$%s (PDF $%s, delta $%s, %s).',
          v_period_year, lpad(v_period_month::text,2,'0'), v_period_half,
          v_rows_inserted, v_rows_deleted,
          to_char(v_db_half_sum,'FM999G999G990D00'), to_char(v_pdf_half_total,'FM999G999G990D00'),
          to_char(v_half_delta,'FM999G990D00'),       CASE WHEN v_half_ok THEN 'OK' ELSE 'FAIL' END,
          to_char(v_db_ytd_sum,'FM999G999G990D00'),  to_char(v_pdf_ytd_total,'FM999G999G990D00'),
          to_char(v_ytd_delta,'FM999G990D00'),        CASE WHEN v_ytd_ok  THEN 'OK' ELSE 'FAIL' END
        )
    WHERE id = p_document_id AND agency_id = p_agency_id;
  END IF;

  -- ============================================================
  -- 7. Return result
  -- ============================================================
  RETURN jsonb_build_object(
    'status', CASE WHEN v_half_ok AND v_ytd_ok THEN 'ok' ELSE 'reconciliation_failed' END,
    'period_year', v_period_year,
    'period_month', v_period_month,
    'period_half', v_period_half,
    'recap_date', v_recap_date,
    'rows_inserted', v_rows_inserted,
    'rows_deleted', v_rows_deleted,
    'reconciliation', jsonb_build_object(
      'half_month_sum_db',    v_db_half_sum,
      'half_month_total_pdf', v_pdf_half_total,
      'half_month_delta',     v_half_delta,
      'half_month_ok',        v_half_ok,
      'ytd_sum_db',           v_db_ytd_sum,
      'ytd_total_pdf',        v_pdf_ytd_total,
      'ytd_delta',            v_ytd_delta,
      'ytd_ok',               v_ytd_ok,
      'tolerance',            v_tolerance
    )
  );
END;
$function$;

COMMENT ON FUNCTION public.sf_comp_recap_ingest IS
'Persistent, idempotent ingest contract for SF Compensation Recap data. See migration 023 header for payload schema. Future Document Processor / parser invocations call this function with parsed PDF data and receive a structured reconciliation result. Safe by default: errors if existing rows for the period are GL-posted (use p_force_replace=true to override, but pair with manual GL reversal).';
