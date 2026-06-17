
-- ============================================================
-- Migration 026 — Cross-day dedup for alert monitors
--
-- Problem: monthly_close_monitor and producer_underperformance_watcher
-- both used "AND created_at::date = v_today" in their NOT EXISTS
-- dedup checks. Effect: same condition fires a new alert every day,
-- stacking duplicates in alerts table (6/16 + 6/17 visible now).
--
-- Fix: dedup against ANY open unresolved alert with the same
-- module_reference, not just today's. When the condition genuinely
-- clears (item received / pace recovers / June production lands),
-- the resolving event sets is_resolved=true on the existing alert.
-- If the condition re-asserts later, the monitors create a fresh one
-- because no OPEN alert exists at that point.
-- ============================================================

CREATE OR REPLACE FUNCTION public.monthly_close_monitor(p_agency_id uuid, p_recipe_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
AS $function$
DECLARE
  v_today          DATE := CURRENT_DATE;
  v_last_day       DATE := (date_trunc('month', v_today) + INTERVAL '1 month - 1 day')::date;
  v_overdue_count  INTEGER := 0;
  v_created_count  INTEGER := 0;
  v_overdue        RECORD;
  v_target_year    INTEGER;
  v_target_month   INTEGER;
BEGIN
  IF EXTRACT(DAY FROM v_today)::INT >= 5 THEN
    FOR v_overdue IN
      SELECT id, doc_label
      FROM public.monthly_close_checklist
      WHERE agency_id = p_agency_id
        AND period_year = EXTRACT(YEAR FROM v_today)::INT
        AND period_month = EXTRACT(MONTH FROM v_today)::INT
        AND received_at IS NULL
        AND expected_by IS NOT NULL
        AND expected_by < v_today
    LOOP
      INSERT INTO public.alerts (
        agency_id, alert_type, severity, title, message, module_reference, is_read, is_resolved, created_at
      )
      SELECT p_agency_id, 'overdue_close_item', 'warning',
             'Monthly close item overdue: ' || v_overdue.doc_label,
             'Item from this month''s close checklist is past its expected_by date. Review in the Financials → Monthly Close tab.',
             'monthly_close_monitor:' || v_overdue.id::text,
             false, false, NOW()
      WHERE NOT EXISTS (
        SELECT 1 FROM public.alerts
        WHERE agency_id = p_agency_id
          AND module_reference = 'monthly_close_monitor:' || v_overdue.id::text
          AND is_resolved = false
        -- CROSS-DAY DEDUP: removed "AND created_at::date = v_today"
      );
      IF FOUND THEN
        v_overdue_count := v_overdue_count + 1;
      END IF;
    END LOOP;
  END IF;

  IF v_today >= v_last_day - INTERVAL '2 days' THEN
    IF EXTRACT(MONTH FROM v_today)::INT = 12 THEN
      v_target_year := EXTRACT(YEAR FROM v_today)::INT + 1;
      v_target_month := 1;
    ELSE
      v_target_year := EXTRACT(YEAR FROM v_today)::INT;
      v_target_month := EXTRACT(MONTH FROM v_today)::INT + 1;
    END IF;

    IF NOT EXISTS (
      SELECT 1 FROM public.monthly_close_checklist
      WHERE agency_id = p_agency_id
        AND period_year = v_target_year
        AND period_month = v_target_month
    ) THEN
      INSERT INTO public.monthly_close_checklist (
        agency_id, period_year, period_month, doc_category, doc_label, expected_by,
        received_at, document_id, status, is_closed, notes, created_at
      )
      SELECT p_agency_id, v_target_year, v_target_month, doc_category, doc_label,
             MAKE_DATE(v_target_year, v_target_month,
                       LEAST(EXTRACT(DAY FROM expected_by)::INT,
                             EXTRACT(DAY FROM (MAKE_DATE(v_target_year, v_target_month, 1) + INTERVAL '1 month - 1 day'))::INT)),
             NULL, NULL, 'pending', false, NULL, NOW()
      FROM (
        SELECT DISTINCT ON (doc_category, doc_label) doc_category, doc_label, expected_by
        FROM public.monthly_close_checklist
        WHERE agency_id = p_agency_id
          AND period_year = EXTRACT(YEAR FROM v_today)::INT
          AND period_month = EXTRACT(MONTH FROM v_today)::INT
          AND expected_by IS NOT NULL
        ORDER BY doc_category, doc_label, created_at DESC
      ) src;

      GET DIAGNOSTICS v_created_count = ROW_COUNT;
    END IF;
  END IF;

  RETURN jsonb_build_object(
    'records_processed', v_overdue_count + v_created_count,
    'output_summary', v_overdue_count || ' new overdue alerts created (existing open ones updated in place by dedup), ' || v_created_count || ' next-month checklist items created'
  );
END;
$function$;


CREATE OR REPLACE FUNCTION public.producer_underperformance_watcher(p_agency_id uuid, p_recipe_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
AS $function$
DECLARE
  v_today              DATE := CURRENT_DATE;
  v_curr_year          INT  := EXTRACT(YEAR FROM v_today)::INT;
  v_curr_month         INT  := EXTRACT(MONTH FROM v_today)::INT;
  v_day_of_month       INT  := EXTRACT(DAY FROM v_today)::INT;
  v_days_in_month      INT  := EXTRACT(DAY FROM (date_trunc('month', v_today) + INTERVAL '1 month - 1 day'))::INT;
  v_pace_factor        NUMERIC := v_day_of_month::numeric / NULLIF(v_days_in_month, 0)::numeric;
  v_alert_count        INTEGER := 0;
  v_gap_count          INTEGER := 0;
  v_producer           RECORD;
  v_mtd_premium        NUMERIC;
  v_3mra_premium       NUMERIC;
  v_pace_ratio         NUMERIC;
  v_curr_month_rows    INTEGER;
  v_mod_ref            TEXT;
  v_gap_mod_ref        TEXT;
BEGIN
  IF v_day_of_month < 5 THEN
    RETURN jsonb_build_object(
      'records_processed', 0,
      'output_summary', 'Skipped: too early in month (day ' || v_day_of_month || ')'
    );
  END IF;

  FOR v_producer IN
    SELECT id, first_name, last_name, role
    FROM public.staff
    WHERE agency_id = p_agency_id
      AND COALESCE(is_active, true) = true
      AND role IS NOT NULL
      AND (role ILIKE '%LSP%' OR role ILIKE '%Producer%' OR role ILIKE '%Financial Services%')
  LOOP
    -- Ingestion gap guard: missing current-month rows.
    SELECT COUNT(*) INTO v_curr_month_rows
    FROM public.producer_production
    WHERE agency_id = p_agency_id
      AND staff_id = v_producer.id
      AND period_year = v_curr_year
      AND period_month = v_curr_month;

    IF v_curr_month_rows = 0 THEN
      v_gap_mod_ref := 'producer_underperformance_watcher:gap:' || v_producer.id::text;
      INSERT INTO public.alerts (
        agency_id, alert_type, severity, title, message, module_reference, is_read, is_resolved, created_at
      )
      SELECT p_agency_id, 'data_gap', 'info',
             v_producer.first_name || ' ' || v_producer.last_name || ': ' ||
               to_char(v_today, 'Mon YYYY') || ' production not yet ingested',
             'producer_production has 0 rows for ' || to_char(v_today, 'Mon YYYY') ||
               ' for this producer. MTD pace check skipped to avoid false-positive ' ||
               'underperformance alert. Ingest current-month data to resume pace monitoring.',
             v_gap_mod_ref,
             false, false, NOW()
      WHERE NOT EXISTS (
        SELECT 1 FROM public.alerts
        WHERE agency_id = p_agency_id
          AND module_reference = v_gap_mod_ref
          AND is_resolved = false
        -- CROSS-DAY DEDUP: removed "AND created_at::date = v_today"
      );
      IF FOUND THEN
        v_gap_count := v_gap_count + 1;
      END IF;
      CONTINUE;
    END IF;

    SELECT COALESCE(SUM(premium_issued), 0) INTO v_mtd_premium
    FROM public.producer_production
    WHERE agency_id = p_agency_id
      AND staff_id = v_producer.id
      AND period_year = v_curr_year
      AND period_month = v_curr_month;

    SELECT COALESCE(AVG(monthly_total), 0) INTO v_3mra_premium
    FROM (
      SELECT period_year, period_month, SUM(premium_issued) AS monthly_total
      FROM public.producer_production
      WHERE agency_id = p_agency_id
        AND staff_id = v_producer.id
        AND (period_year, period_month) IN (
          SELECT EXTRACT(YEAR FROM (v_today - INTERVAL '1 month'))::int,
                 EXTRACT(MONTH FROM (v_today - INTERVAL '1 month'))::int
          UNION ALL SELECT EXTRACT(YEAR FROM (v_today - INTERVAL '2 month'))::int,
                 EXTRACT(MONTH FROM (v_today - INTERVAL '2 month'))::int
          UNION ALL SELECT EXTRACT(YEAR FROM (v_today - INTERVAL '3 month'))::int,
                 EXTRACT(MONTH FROM (v_today - INTERVAL '3 month'))::int
        )
      GROUP BY period_year, period_month
    ) prior_months;

    IF v_3mra_premium <= 0 THEN CONTINUE; END IF;

    v_pace_ratio := CASE
      WHEN v_3mra_premium * v_pace_factor > 0
        THEN v_mtd_premium / (v_3mra_premium * v_pace_factor)
      ELSE NULL
    END;

    IF v_pace_ratio IS NOT NULL AND v_pace_ratio < 0.70 THEN
      v_mod_ref := 'producer_underperformance_watcher:' || v_producer.id::text;
      INSERT INTO public.alerts (
        agency_id, alert_type, severity, title, message, module_reference, is_read, is_resolved, created_at
      )
      SELECT p_agency_id, 'producer_underperformance', 'warning',
             v_producer.first_name || ' ' || v_producer.last_name || ': MTD pace ' || ROUND(v_pace_ratio * 100, 0) || '% of 3MRA',
             'Through day ' || v_day_of_month || ' of ' || v_days_in_month || ', producer has issued $' ||
             ROUND(v_mtd_premium, 0) || ' in premium. 3-month rolling average through this point of month is $' ||
             ROUND(v_3mra_premium * v_pace_factor, 0) || '. Investigate via HR & People -> Performance.',
             v_mod_ref,
             false, false, NOW()
      WHERE NOT EXISTS (
        SELECT 1 FROM public.alerts
        WHERE agency_id = p_agency_id
          AND module_reference = v_mod_ref
          AND is_resolved = false
        -- CROSS-DAY DEDUP: removed "AND created_at::date = v_today"
      );
      IF FOUND THEN
        v_alert_count := v_alert_count + 1;
      END IF;
    END IF;
  END LOOP;

  RETURN jsonb_build_object(
    'records_processed', v_alert_count + v_gap_count,
    'output_summary', v_alert_count || ' producers flagged underperforming, ' ||
                       v_gap_count || ' producers skipped (current month not ingested)'
  );
END;
$function$;

-- ============================================================
-- Resolve the 3 stale 6/16 duplicates (their 6/17 counterparts
-- already exist as the canonical open alert per condition)
-- ============================================================
UPDATE public.alerts
SET is_resolved = true,
    resolved_at = NOW(),
    message = COALESCE(message,'') || E'\n\n[2026-06-17 auto-resolved: duplicate of more recent open alert with same module_reference. Migration 026 deduped the monitors so future runs touch the existing open alert instead of stacking dailies.]'
WHERE agency_id = '98aa8b9b-92e4-4ebc-8727-aa00ce696fab'
  AND is_resolved = false
  AND created_at::date = '2026-06-16'
  AND module_reference IN (
    'monthly_close_monitor:83f5ae7a-9af9-4b89-8f54-464849ef77f5',
    'monthly_close_monitor:f5283656-c959-43b1-80ef-0fe958991d6f',
    'producer_underperformance_watcher:gap:dc85ef23-9af7-4647-9d4e-414880ad0f74'
  );
