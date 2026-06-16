-- Adds current-month ingestion gap detection to producer_underperformance_watcher.
-- BEFORE: if a producer had no producer_production rows for the current month,
--   v_mtd_premium = 0 and v_pace_ratio = 0% → false-positive underperformance alert.
-- AFTER: if no current-month rows exist for a producer, fire a data_gap alert
--   (deduped per day per producer) and skip the underperformance pace check.

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
    -- ===== NEW: ingestion gap guard =====
    -- If no producer_production rows exist for the current year/month for this
    -- producer, the input is missing — not the production. Fire a data_gap
    -- alert (deduped per day per producer) and skip the pace check.
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
          AND created_at::date = v_today
      );
      v_gap_count := v_gap_count + 1;
      CONTINUE;
    END IF;
    -- ===== END gap guard =====

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
          AND created_at::date = v_today
      );
      v_alert_count := v_alert_count + 1;
    END IF;
  END LOOP;

  RETURN jsonb_build_object(
    'records_processed', v_alert_count + v_gap_count,
    'output_summary', v_alert_count || ' producers flagged underperforming, ' ||
                       v_gap_count || ' producers skipped (current month not ingested)'
  );
END;
$function$;
