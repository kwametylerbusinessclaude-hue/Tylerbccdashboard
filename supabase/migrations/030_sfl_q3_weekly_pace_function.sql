-- Migration 030: SFL Q3 Weekly Pace Function
-- Author: Claude (in-session, 2026-06-18 ~01:00 UTC)
-- DB version: 20260618005536 (recorded as 028_sfl_q3_weekly_pace_function in schema_migrations
--   due to in-session numbering oversight; this filename is the canonical repo reference).
--
-- Purpose: returns a jsonb summary of where the agent is against the 13 weekly SFL Q3 targets.
-- Designed to be called by the Daily Briefing generator from Jun 29 through Sep 27.
-- Outside that window, returns {status: 'pre_q3' | 'post_q3'} so the briefing skips the panel
-- but can still show a countdown line.
--
-- Source of truth for weekly targets: hardcoded here (13 weeks totaling $4,430) — matches
--   the goals memory and the 13 weekly tasks in public.tasks.
-- Source of truth for actuals: comp_recap.half_month_activity rows where comp_type='SFL'
--   AND comp_category='first_year_writing', summed by recap_date.
--
-- Pace signal thresholds:
--   on_or_ahead: actual >= target
--   soft_warning: actual >= 80% of target
--   behind: actual < 80% of target
--   awaiting_first_week_close: target = 0 (first week not yet ended)

CREATE OR REPLACE FUNCTION public.get_sfl_q3_weekly_pace(p_agency_id uuid)
RETURNS jsonb
LANGUAGE plpgsql STABLE
AS $$
DECLARE
  v_today date := CURRENT_DATE;
  v_q3_start date := '2026-06-29';
  v_q3_end date := '2026-09-27';
  v_total_target numeric := 4430.00;
  v_ytd_actual numeric;
  v_ytd_target numeric;
  v_current_week int;
  v_result jsonb;
BEGIN
  IF v_today < v_q3_start THEN
    RETURN jsonb_build_object(
      'status', 'pre_q3',
      'days_until_q3', (v_q3_start - v_today),
      'q3_start', v_q3_start::text,
      'q3_total_target', v_total_target,
      'message', 'Q3 SFL push starts ' || (v_q3_start - v_today) || ' days from today (Jun 29, 2026).'
    );
  END IF;

  IF v_today > v_q3_end THEN
    RETURN jsonb_build_object(
      'status', 'post_q3',
      'q3_end', v_q3_end::text,
      'message', 'Q3 SFL push window closed ' || (v_today - v_q3_end) || ' days ago.'
    );
  END IF;

  v_current_week := FLOOR((v_today - v_q3_start)::numeric / 7) + 1;
  IF v_current_week > 13 THEN v_current_week := 13; END IF;

  WITH targets AS (
    SELECT * FROM (VALUES
      (1, 250.00), (2, 400.00), (3, 400.00), (4, 400.00), (5, 350.00),
      (6, 250.00), (7, 250.00), (8, 300.00), (9, 300.00),
      (10, 400.00), (11, 400.00), (12, 400.00), (13, 330.00)
    ) AS t(wk_num, wk_target)
  )
  SELECT COALESCE(SUM(wk_target), 0) INTO v_ytd_target
  FROM targets WHERE wk_num <= v_current_week;

  SELECT COALESCE(SUM(amount), 0) INTO v_ytd_actual
  FROM comp_recap
  WHERE agency_id = p_agency_id
    AND amount_type = 'half_month_activity'
    AND comp_type = 'SFL'
    AND comp_category = 'first_year_writing'
    AND recap_date >= v_q3_start
    AND recap_date <= v_today;

  v_result := jsonb_build_object(
    'status', 'in_q3',
    'current_week', v_current_week,
    'weeks_remaining', 13 - v_current_week,
    'q3_start', v_q3_start::text,
    'q3_end', v_q3_end::text,
    'total_target', v_total_target,
    'ytd_target', v_ytd_target,
    'ytd_actual', v_ytd_actual,
    'gap', v_ytd_actual - v_ytd_target,
    'pct_of_target', CASE WHEN v_ytd_target > 0
                         THEN ROUND((v_ytd_actual / v_ytd_target) * 100, 1)
                         ELSE NULL END,
    'pace_signal', CASE
                     WHEN v_ytd_target = 0 THEN 'awaiting_first_week_close'
                     WHEN v_ytd_actual >= v_ytd_target THEN 'on_or_ahead'
                     WHEN v_ytd_actual >= v_ytd_target * 0.80 THEN 'soft_warning'
                     ELSE 'behind'
                   END,
    'computed_at', NOW()
  );

  RETURN v_result;
END;
$$;

COMMENT ON FUNCTION public.get_sfl_q3_weekly_pace(uuid) IS 'Returns Q3 2026 SFL weekly pace summary; designed for Daily Briefing integration; pre_q3/in_q3/post_q3 states. Targets sourced from goals memory (13 weeks totaling $4430). Actuals from comp_recap.half_month_activity SFL.first_year_writing.';
