-- ============================================================================
-- Migration 015 — Daily Briefing generator
-- ----------------------------------------------------------------------------
-- Creates:
--   1. briefings audit table (one row per agency per day)
--   2. generate_daily_briefing(p_agency_id, p_tz) function which composes
--      the email payload AND inserts/updates the audit row.
--
-- Used by the Daily Briefing Email recipe via the input_config.payload_rpc
-- pattern in Edge Function automation-runner v4+. Reusable for any future
-- recipe whose Composio arguments must be computed from live DB state.
-- ============================================================================

CREATE TABLE IF NOT EXISTS briefings (
  id               uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  agency_id        uuid NOT NULL,
  briefing_date    date NOT NULL,
  briefing_for_tz  text DEFAULT 'America/New_York',
  recipient_email  text NOT NULL,
  subject          text NOT NULL,
  body_html        text NOT NULL,
  generated_at     timestamptz NOT NULL DEFAULT NOW(),
  sent_at          timestamptz,
  metadata         jsonb DEFAULT '{}'::jsonb,
  CONSTRAINT briefings_unique_per_agency_per_day UNIQUE (agency_id, briefing_date)
);

CREATE INDEX IF NOT EXISTS briefings_agency_date_idx ON briefings (agency_id, briefing_date DESC);

-- ----------------------------------------------------------------------------
-- generate_daily_briefing(p_agency_id, p_tz)
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION generate_daily_briefing(
  p_agency_id uuid,
  p_tz text DEFAULT 'America/New_York'
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $func$
DECLARE
  v_now_tz         timestamp;
  v_today          date;
  v_hour           int;
  v_greeting       text;
  v_owner          text;
  v_agency_name    text;
  v_recipient      text;
  v_subject        text;
  v_body           text;
  v_cutover_date   date;
  v_days_since_cut int;
  v_latest_recap   date;
  v_latest_ytd     numeric;
  v_2026_ytd       numeric;
  v_prod_ytd       numeric;
  v_aipp_ytd       numeric;
  v_bonus_ytd      numeric;
  v_benefits_ytd   numeric;
  v_gfa_ytd        numeric;
  v_last_je_date   date;
  v_last_je_ref    text;
  v_recaps_2026    int;
  v_recaps_2025    int;
  v_compliance_html text;
  v_tasks_html     text;
  v_alerts_html    text;
  v_briefing_id    uuid;
BEGIN
  v_now_tz := NOW() AT TIME ZONE p_tz;
  v_today  := v_now_tz::date;
  v_hour   := EXTRACT(HOUR FROM v_now_tz);

  v_greeting := CASE
    WHEN v_hour BETWEEN 5  AND 11 THEN 'Good morning'
    WHEN v_hour BETWEEN 12 AND 16 THEN 'Good afternoon'
    WHEN v_hour BETWEEN 17 AND 21 THEN 'Good evening'
    ELSE 'Hello'
  END;

  SELECT owner_name, name INTO v_owner, v_agency_name
    FROM agency WHERE id = p_agency_id;

  SELECT setting_value::date INTO v_cutover_date
    FROM settings WHERE agency_id = p_agency_id AND setting_key = 'gl_cutover_date';
  v_days_since_cut := COALESCE(v_today - v_cutover_date, 0);

  SELECT setting_value INTO v_recipient
    FROM settings WHERE agency_id = p_agency_id AND setting_key = 'briefing_email';
  v_recipient := COALESCE(v_recipient, 'kwametyler.businessclaude@gmail.com');

  SELECT MAX(recap_date) INTO v_latest_recap
    FROM comp_recap WHERE agency_id = p_agency_id;

  SELECT COALESCE(SUM(amount), 0) INTO v_latest_ytd
    FROM comp_recap
   WHERE agency_id = p_agency_id
     AND recap_date = v_latest_recap
     AND amount_type = 'ytd_snapshot';

  -- 2026 YTD breakdown by comp_type. NOTE: is_aipp_eligible is NOT a category
  -- flag; it marks PRODUCTION rows that feed next year's AIPP base. The AIPP
  -- payments themselves are tagged comp_type='AIPP'.
  SELECT COALESCE(SUM(amount) FILTER (WHERE comp_type IN ('MUTL','SFL','FIRE','STDAUTO','IPSI')), 0),
         COALESCE(SUM(amount) FILTER (WHERE comp_type = 'AIPP'), 0),
         COALESCE(SUM(amount) FILTER (WHERE comp_type IN ('BONUS','OTHER_INCOME')), 0),
         COALESCE(SUM(amount) FILTER (WHERE comp_type = 'BENEFITS'), 0),
         COALESCE(SUM(amount) FILTER (WHERE comp_type = 'GFA'), 0)
    INTO v_prod_ytd, v_aipp_ytd, v_bonus_ytd, v_benefits_ytd, v_gfa_ytd
    FROM comp_recap
   WHERE agency_id = p_agency_id
     AND period_year = 2026
     AND amount_type = 'half_month_activity';
  v_2026_ytd := v_prod_ytd + v_aipp_ytd + v_bonus_ytd + v_benefits_ytd + v_gfa_ytd;

  SELECT entry_date, reference_number INTO v_last_je_date, v_last_je_ref
    FROM journal_entries
   WHERE agency_id = p_agency_id AND source = 'gl_entry_writer'
   ORDER BY entry_date DESC, created_at DESC
   LIMIT 1;

  SELECT COUNT(DISTINCT recap_date) INTO v_recaps_2026
    FROM comp_recap WHERE agency_id = p_agency_id AND period_year = 2026;
  SELECT COUNT(DISTINCT recap_date) INTO v_recaps_2025
    FROM comp_recap WHERE agency_id = p_agency_id AND period_year = 2025;

  SELECT COALESCE(string_agg(
    '<li style="margin:6px 0"><strong>' || to_char(due_date, 'Mon DD') || '</strong> &mdash; '
    || coalesce(title, '(untitled)')
    || CASE WHEN due_date - v_today <= 7 THEN ' <span style="color:#b91c1c;font-weight:600">(this week)</span>' ELSE '' END
    || '</li>'
  , ''), '<li style="color:#6b7280">No compliance deadlines in the next 30 days.</li>')
  INTO v_compliance_html
  FROM (
    SELECT title, due_date FROM compliance_calendar
     WHERE agency_id = p_agency_id
       AND status NOT IN ('completed','closed','cancelled')
       AND due_date BETWEEN v_today AND v_today + 30
     ORDER BY due_date LIMIT 10
  ) c;

  SELECT COALESCE(string_agg(
    '<li style="margin:6px 0"><strong>' || coalesce(priority, 'medium') || '</strong>: '
    || coalesce(title, '(untitled)')
    || CASE WHEN due_date IS NOT NULL THEN ' &mdash; due ' || to_char(due_date, 'Mon DD') ELSE '' END
    || '</li>'
  , ''), '<li style="color:#6b7280">No open tasks. Add some in the BCC web app to see them here.</li>')
  INTO v_tasks_html
  FROM (
    SELECT title, priority, due_date FROM tasks
     WHERE agency_id = p_agency_id
       AND status NOT IN ('completed','cancelled')
     ORDER BY CASE priority WHEN 'critical' THEN 1 WHEN 'high' THEN 2 WHEN 'medium' THEN 3 ELSE 4 END,
              due_date NULLS LAST LIMIT 8
  ) t;

  SELECT COALESCE(string_agg(
    '<li style="margin:6px 0"><strong>' || upper(coalesce(severity, 'info')) || '</strong>: '
    || coalesce(title, '(untitled)')
    || '</li>'
  , ''), '')
  INTO v_alerts_html
  FROM (
    SELECT severity, title FROM alerts
     WHERE agency_id = p_agency_id
       AND NOT is_resolved
       AND COALESCE(alert_type, '') <> 'system'
     ORDER BY CASE severity WHEN 'critical' THEN 1 WHEN 'high' THEN 2 WHEN 'warning' THEN 3 ELSE 4 END,
              created_at DESC LIMIT 5
  ) a;

  v_subject := format('BCC Briefing — %s — 2026 YTD $%s',
    to_char(v_today, 'Mon DD'),
    to_char(v_2026_ytd, 'FM999,999,990.00')
  );

  v_body :=
'<!DOCTYPE html><html><body style="margin:0;padding:0;background:#f3f4f6;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif;color:#111827;">' ||
'<div style="max-width:640px;margin:0 auto;padding:24px;">' ||
  '<div style="background:#ffffff;border-radius:12px;padding:28px;box-shadow:0 1px 3px rgba(0,0,0,0.05);">' ||
    '<div style="border-bottom:2px solid #111827;padding-bottom:16px;margin-bottom:24px;">' ||
      '<div style="font-size:12px;letter-spacing:0.1em;color:#6b7280;text-transform:uppercase;font-weight:600;">' ||
        'Business Command Center &mdash; ' || to_char(v_today, 'Day Mon DD, YYYY') ||
      '</div>' ||
      '<h1 style="font-size:24px;margin:8px 0 0 0;color:#111827;">' ||
        v_greeting || ', ' || split_part(coalesce(v_owner, 'Kwame Tyler'), ' ', 1) || '.' ||
      '</h1>' ||
    '</div>' ||
    '<h2 style="font-size:16px;margin:24px 0 8px 0;color:#1f2937;">Where we are</h2>' ||
    '<table style="width:100%;border-collapse:collapse;font-size:14px;">' ||
      '<tr><td style="padding:6px 0;color:#6b7280;width:60%;">2026 federal YTD comp (latest snapshot)</td>' ||
        '<td style="padding:6px 0;text-align:right;font-weight:600;">$' || to_char(coalesce(v_latest_ytd, 0), 'FM999,999,990.00') || '</td></tr>' ||
      '<tr><td style="padding:6px 0;color:#6b7280;">&nbsp;&nbsp;Production (MUTL + SFL + FIRE + STDAUTO)</td>' ||
        '<td style="padding:6px 0;text-align:right;">$' || to_char(coalesce(v_prod_ytd, 0), 'FM999,999,990.00') || '</td></tr>' ||
      '<tr><td style="padding:6px 0;color:#6b7280;">&nbsp;&nbsp;AIPP (paid Jan 2026 from 2025 base)</td>' ||
        '<td style="padding:6px 0;text-align:right;">$' || to_char(coalesce(v_aipp_ytd, 0), 'FM999,999,990.00') || '</td></tr>' ||
      '<tr><td style="padding:6px 0;color:#6b7280;">&nbsp;&nbsp;Bonuses &amp; Other Income</td>' ||
        '<td style="padding:6px 0;text-align:right;">$' || to_char(coalesce(v_bonus_ytd, 0), 'FM999,999,990.00') || '</td></tr>' ||
      '<tr><td style="padding:6px 0;color:#6b7280;">&nbsp;&nbsp;Reportable Benefits</td>' ||
        '<td style="padding:6px 0;text-align:right;">$' || to_char(coalesce(v_benefits_ytd, 0), 'FM999,999,990.00') || '</td></tr>' ||
      '<tr><td style="padding:6px 0;color:#6b7280;">&nbsp;&nbsp;GFA banking referral income</td>' ||
        '<td style="padding:6px 0;text-align:right;">$' || to_char(coalesce(v_gfa_ytd, 0), 'FM999,999,990.00') || '</td></tr>' ||
      '<tr><td style="padding:10px 0 4px 0;border-top:1px solid #e5e7eb;color:#6b7280;">Most recent SF Comp Recap</td>' ||
        '<td style="padding:10px 0 4px 0;border-top:1px solid #e5e7eb;text-align:right;font-weight:600;">' || coalesce(to_char(v_latest_recap, 'Mon DD, YYYY'), '&mdash;') || '</td></tr>' ||
      '<tr><td style="padding:4px 0;color:#6b7280;">Days post-cutover (live GL)</td>' ||
        '<td style="padding:4px 0;text-align:right;">' || v_days_since_cut || '</td></tr>' ||
      '<tr><td style="padding:4px 0;color:#6b7280;">Last journal entry posted</td>' ||
        '<td style="padding:4px 0;text-align:right;">' || coalesce(v_last_je_ref || ' on ' || to_char(v_last_je_date, 'Mon DD'), '&mdash;') || '</td></tr>' ||
      '<tr><td style="padding:4px 0;color:#6b7280;">SF Comp Recaps loaded</td>' ||
        '<td style="padding:4px 0;text-align:right;">' || v_recaps_2026 || ' / 10 in 2026 &middot; ' || v_recaps_2025 || ' / 24 in 2025</td></tr>' ||
    '</table>' ||
    '<h2 style="font-size:16px;margin:28px 0 8px 0;color:#1f2937;">What I''m watching</h2>' ||
    '<ul style="margin:0;padding-left:20px;font-size:14px;line-height:1.6;color:#374151;">' ||
      '<li><strong>L&amp;H ScoreBoard multiplier prep.</strong> Q3 starts in '
        || (date '2026-07-01' - v_today) || ' days. Life &amp; Health production in Q3/Q4 lifts next year''s Auto/Fire ScoreBoard multiplier. Ask me for the SFL trajectory anytime.</li>' ||
      '<li><strong>Mid-June SF Comp Recap inbound.</strong> Composio auth refactor shipped 2026-06-12 &mdash; when the email arrives, the Document Processor recipe is ready to ingest it.</li>' ||
      CASE WHEN v_recaps_2026 < 10 THEN
        '<li><strong>2026 comp_recap loading incomplete</strong> &mdash; only ' || v_recaps_2026 || ' of 10 expected through May.</li>'
      ELSE '' END ||
    '</ul>' ||
    '<h2 style="font-size:16px;margin:28px 0 8px 0;color:#1f2937;">Today''s priorities</h2>' ||
    '<ul style="margin:0;padding-left:20px;font-size:14px;line-height:1.6;color:#374151;">' || v_tasks_html || '</ul>' ||
    CASE WHEN v_alerts_html <> '' THEN
      '<h2 style="font-size:16px;margin:28px 0 8px 0;color:#1f2937;">What to ask me about</h2>' ||
      '<ul style="margin:0;padding-left:20px;font-size:14px;line-height:1.6;color:#374151;">' || v_alerts_html || '</ul>'
    ELSE '' END ||
    '<h2 style="font-size:16px;margin:28px 0 8px 0;color:#1f2937;">Compliance upcoming (next 30 days)</h2>' ||
    '<ul style="margin:0;padding-left:20px;font-size:14px;line-height:1.6;color:#374151;">' || v_compliance_html || '</ul>' ||
    '<div style="margin-top:32px;padding-top:16px;border-top:1px solid #e5e7eb;font-size:12px;color:#9ca3af;line-height:1.5;">' ||
      'Generated ' || to_char(v_now_tz, 'HH12:MI AM TZ') || ' &middot; ' ||
      coalesce(v_agency_name, 'Tyler Insurance and Financial Services') || ' &middot; ' ||
      'BCC by Imaginary Farms LLC.' ||
      '<br/>Reply to this thread or open Claude to drill into any line item.' ||
    '</div>' ||
  '</div></div></body></html>';

  INSERT INTO briefings (agency_id, briefing_date, briefing_for_tz, recipient_email, subject, body_html, metadata)
  VALUES (
    p_agency_id, v_today, p_tz, v_recipient, v_subject, v_body,
    jsonb_build_object(
      'latest_recap', v_latest_recap,
      'ytd_total', v_2026_ytd,
      'production_ytd', v_prod_ytd,
      'aipp_ytd', v_aipp_ytd,
      'bonus_ytd', v_bonus_ytd,
      'benefits_ytd', v_benefits_ytd,
      'gfa_ytd', v_gfa_ytd,
      'days_post_cutover', v_days_since_cut,
      'recaps_2026', v_recaps_2026,
      'recaps_2025', v_recaps_2025
    )
  )
  ON CONFLICT (agency_id, briefing_date) DO UPDATE
    SET subject     = EXCLUDED.subject,
        body_html   = EXCLUDED.body_html,
        generated_at = NOW(),
        metadata    = EXCLUDED.metadata
  RETURNING id INTO v_briefing_id;

  RETURN jsonb_build_object(
    'user_id',         'me',
    'recipient_email', v_recipient,
    'subject',         v_subject,
    'body',            v_body,
    'is_html',         true
  );
END;
$func$;
