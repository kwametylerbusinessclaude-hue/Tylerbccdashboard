-- Migration 031: sf_comp_recap_ingest benefits-aware reconciliation
-- Author: Claude (in-session, 2026-06-18 ~01:10 UTC)
-- Companion to: docs/DOC_PROCESSOR_V2_2_PARSE_LEG.md (v2.1 reconciliation extension)
--
-- Background:
--   2026-06-17 discovery — the SF Comp Recap PDF's "GROSS COMPENSATION YTD" line
--   on page 2 EXCLUDES the page-3 BENEFITS contribution lines (MEDICAL INSURANCE,
--   GROUP DENTAL, LIFE INSURANCE CONTRIBUTION), but those lines DO appear as
--   comp_recap.lines rows. Empirical gap May 15 2026: DB sum $266,675.21 vs PDF
--   gross_ytd $261,435.21 = $5,240. Without this fix, v9 Path A parsing fails
--   the $0.10 reconciliation tolerance on every recap.
--
-- Fix:
--   Optional payload fields reconciliation.total_with_benefits_half_pdf and
--   reconciliation.total_with_benefits_ytd_pdf. When present, reconciliation
--   uses these inclusive totals as the target. When absent, falls back to
--   legacy gross-only behavior (back-compat with historical re-parses).
--
-- Return shape:
--   reconciliation object now exposes BOTH 'gross_only' and 'with_benefits'
--   sub-objects with their respective deltas. Top-level recon_target field
--   tells callers which was used.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.sf_comp_recap_ingest(p_agency_id uuid, p_document_id uuid, p_payload jsonb, p_force_replace boolean DEFAULT false)
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
  v_pdf_half_with_b   numeric;
  v_pdf_ytd_with_b    numeric;
  v_recon_target      text;
  v_lines             jsonb;
  v_line              jsonb;
  v_existing_count    int;
  v_posted_count      int;
  v_rows_deleted      int;
  v_rows_inserted     int := 0;
  v_db_half_sum       numeric;
  v_db_ytd_sum        numeric;
  v_half_delta_gross  numeric;
  v_ytd_delta_gross   numeric;
  v_half_delta_recon  numeric;
  v_ytd_delta_recon   numeric;
  v_half_ok           boolean;
  v_ytd_ok            boolean;
  v_tolerance         numeric := 0.10;
BEGIN
  -- 1. Validate payload
  IF p_payload IS NULL OR jsonb_typeof(p_payload) <> 'object' THEN
    RETURN jsonb_build_object('status','error','error_reason','payload must be a JSON object');
  END IF;

  v_period_year    := (p_payload->>'period_year')::int;
  v_period_month   := (p_payload->>'period_month')::int;
  v_period_half    := p_payload->>'period_half';
  v_recap_date     := (p_payload->>'recap_date')::date;
  v_pdf_half_total := (p_payload->'reconciliation'->>'half_month_total_pdf')::numeric;
  v_pdf_ytd_total  := (p_payload->'reconciliation'->>'ytd_total_pdf')::numeric;
  v_pdf_half_with_b := (p_payload->'reconciliation'->>'total_with_benefits_half_pdf')::numeric;
  v_pdf_ytd_with_b  := (p_payload->'reconciliation'->>'total_with_benefits_ytd_pdf')::numeric;
  v_lines          := p_payload->'lines';

  -- Pick reconciliation target: benefits-inclusive if both with-benefits totals present,
  -- otherwise legacy gross-only.
  IF v_pdf_half_with_b IS NOT NULL AND v_pdf_ytd_with_b IS NOT NULL THEN
    v_recon_target := 'total_with_benefits';
  ELSE
    v_recon_target := 'gross_compensation_legacy';
  END IF;

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

  -- 2. GL-posted safety check
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

  -- 3. Delete existing
  DELETE FROM public.comp_recap
  WHERE agency_id = p_agency_id
    AND period_year = v_period_year
    AND period_month = v_period_month
    AND period_half = v_period_half;
  GET DIAGNOSTICS v_rows_deleted = ROW_COUNT;

  -- 4. Insert two rows per line
  FOR v_line IN SELECT * FROM jsonb_array_elements(v_lines)
  LOOP
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

  -- 5. Reconcile DB sums vs both PDF totals
  SELECT
    COALESCE(SUM(amount) FILTER (WHERE amount_type='half_month_activity'), 0),
    COALESCE(SUM(amount) FILTER (WHERE amount_type='ytd_snapshot'),         0)
    INTO v_db_half_sum, v_db_ytd_sum
  FROM public.comp_recap
  WHERE agency_id = p_agency_id
    AND period_year = v_period_year
    AND period_month = v_period_month
    AND period_half = v_period_half;

  -- Legacy gross deltas (always computed for audit)
  v_half_delta_gross := round(v_db_half_sum - v_pdf_half_total, 2);
  v_ytd_delta_gross  := round(v_db_ytd_sum  - v_pdf_ytd_total,  2);

  -- Reconciliation target deltas
  IF v_recon_target = 'total_with_benefits' THEN
    v_half_delta_recon := round(v_db_half_sum - v_pdf_half_with_b, 2);
    v_ytd_delta_recon  := round(v_db_ytd_sum  - v_pdf_ytd_with_b,  2);
  ELSE
    v_half_delta_recon := v_half_delta_gross;
    v_ytd_delta_recon  := v_ytd_delta_gross;
  END IF;

  v_half_ok := abs(v_half_delta_recon) <= v_tolerance;
  v_ytd_ok  := abs(v_ytd_delta_recon)  <= v_tolerance;

  -- 6. Stamp documents row
  IF p_document_id IS NOT NULL THEN
    UPDATE public.documents
    SET processing_status = CASE WHEN v_half_ok AND v_ytd_ok THEN 'processed' ELSE 'processed_with_warnings' END,
        processing_type   = 'sf_comp_recap',
        tables_updated    = ARRAY['comp_recap']::text[],
        records_created   = v_rows_inserted,
        processed_at      = NOW(),
        notes             = format(
          'SF Comp Recap %s-%s-%s ingested. %s rows inserted (%s replaced). Recon target: %s. Half: DB $%s vs PDF $%s (delta $%s, %s). YTD: DB $%s vs PDF $%s (delta $%s, %s).',
          v_period_year, lpad(v_period_month::text,2,'0'), v_period_half,
          v_rows_inserted, v_rows_deleted, v_recon_target,
          to_char(v_db_half_sum,'FM999G999G990D00'),
          to_char(CASE WHEN v_recon_target='total_with_benefits' THEN v_pdf_half_with_b ELSE v_pdf_half_total END,'FM999G999G990D00'),
          to_char(v_half_delta_recon,'FM999G990D00'),
          CASE WHEN v_half_ok THEN 'OK' ELSE 'FAIL' END,
          to_char(v_db_ytd_sum,'FM999G999G990D00'),
          to_char(CASE WHEN v_recon_target='total_with_benefits' THEN v_pdf_ytd_with_b ELSE v_pdf_ytd_total END,'FM999G999G990D00'),
          to_char(v_ytd_delta_recon,'FM999G990D00'),
          CASE WHEN v_ytd_ok THEN 'OK' ELSE 'FAIL' END
        )
    WHERE id = p_document_id AND agency_id = p_agency_id;
  END IF;

  -- 7. Return result with both reconciliation views
  RETURN jsonb_build_object(
    'status', CASE WHEN v_half_ok AND v_ytd_ok THEN 'ok' ELSE 'reconciliation_failed' END,
    'period_year', v_period_year,
    'period_month', v_period_month,
    'period_half', v_period_half,
    'recap_date', v_recap_date,
    'rows_inserted', v_rows_inserted,
    'rows_deleted', v_rows_deleted,
    'recon_target', v_recon_target,
    'reconciliation', jsonb_build_object(
      'half_month_sum_db',           v_db_half_sum,
      'ytd_sum_db',                  v_db_ytd_sum,
      'gross_only', jsonb_build_object(
        'half_month_total_pdf', v_pdf_half_total,
        'ytd_total_pdf',        v_pdf_ytd_total,
        'half_delta',           v_half_delta_gross,
        'ytd_delta',            v_ytd_delta_gross
      ),
      'with_benefits', jsonb_build_object(
        'half_month_total_pdf', v_pdf_half_with_b,
        'ytd_total_pdf',        v_pdf_ytd_with_b,
        'half_delta',           CASE WHEN v_pdf_half_with_b IS NOT NULL THEN round(v_db_half_sum - v_pdf_half_with_b, 2) ELSE NULL END,
        'ytd_delta',            CASE WHEN v_pdf_ytd_with_b IS NOT NULL THEN round(v_db_ytd_sum - v_pdf_ytd_with_b, 2) ELSE NULL END
      ),
      'half_month_ok', v_half_ok,
      'ytd_ok',        v_ytd_ok,
      'tolerance',     v_tolerance
    )
  );
END;
$function$
;
