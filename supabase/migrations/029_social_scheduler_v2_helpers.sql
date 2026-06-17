-- =====================================================================
-- 029_social_scheduler_v2_helpers.sql
-- =====================================================================
-- Social Scheduler v2 — Phase v2.0 server-side helpers.
--
-- Lands the payload_rpc/result_rpc plumbing for Facebook + LinkedIn auto-
-- post and Instagram manual-reminder.  All 3 recipes stay is_active=false
-- in this migration; activation is Phase v2.3 after social_accounts
-- table is populated + Composio connections confirmed.
--
-- KEY POINTS:
--   * content_calendar gets failure_reason, retry_count, last_attempted_at
--   * prepare_*_post_batch RPCs return jsonb plans the Edge Function consumes
--   * has_aa05_prohibited_terms() — SQL belt for the canonical word block
--     (the Edge Function TS pre-flight is the suspenders).
--   * log_social_post_result handles success + retry/failure transitions
--   * Instagram recipe's broken `instagram_manual_reminder` handler is
--     replaced with the canonical `social_scheduler_instagram_orchestrator`
-- =====================================================================

BEGIN;

-- ---------------------------------------------------------------------
-- 1. content_calendar v2 columns
-- ---------------------------------------------------------------------

ALTER TABLE public.content_calendar
  ADD COLUMN IF NOT EXISTS failure_reason    text,
  ADD COLUMN IF NOT EXISTS retry_count       int  NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_attempted_at timestamptz;

CREATE INDEX IF NOT EXISTS content_calendar_v2_due_idx
  ON content_calendar (agency_id, platform, status, scheduled_date, scheduled_time);


-- ---------------------------------------------------------------------
-- 2. has_aa05_prohibited_terms — SQL word-rule belt (narrow list).
-- ---------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.has_aa05_prohibited_terms(p_text text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE
    WHEN p_text IS NULL OR length(p_text) = 0 THEN FALSE
    ELSE EXISTS (
      SELECT 1
      FROM unnest(ARRAY[
        'client', 'clients',
        'solutions',
        'expert ', 'experts ', ' expert', ' experts',
        'specialist',
        'advisor', 'consultant',
        'transfers welcome',
        'financial freedom',
        'wealth accumulation',
        'world-class', 'world class',
        'first-class', 'first class',
        'cheap', 'affordable', 'low cost',
        'guarantee', 'guaranteed',
        '#1', 'greatest'
      ]) AS prohibited
      WHERE lower(p_text) LIKE '%' || prohibited || '%'
    )
  END
$$;

GRANT EXECUTE ON FUNCTION public.has_aa05_prohibited_terms(text)
  TO service_role, authenticated, anon;


-- ---------------------------------------------------------------------
-- 3. prepare_*_post_batch RPCs — Facebook / LinkedIn / Instagram planners.
-- ---------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.prepare_facebook_post_batch(
  p_agency_id uuid,
  p_tz        text DEFAULT 'America/New_York'
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_items   jsonb := '[]'::jsonb;
  v_skipped jsonb := '[]'::jsonb;
  v_row     content_calendar%ROWTYPE;
  v_now     timestamptz := NOW();
  v_today   date := (v_now AT TIME ZONE p_tz)::date;
  v_now_t   time := (v_now AT TIME ZONE p_tz)::time;
BEGIN
  FOR v_row IN
    SELECT *
    FROM   content_calendar
    WHERE  agency_id = p_agency_id
      AND  platform  = 'facebook'
      AND  status    = 'scheduled'
      AND  scheduled_date <= v_today
      AND  (scheduled_time IS NULL OR scheduled_time <= v_now_t OR scheduled_date < v_today)
      AND  (last_attempted_at IS NULL OR last_attempted_at < v_now - interval '30 minutes')
    ORDER BY scheduled_date, scheduled_time NULLS FIRST, created_at
    LIMIT 25
  LOOP
    IF v_row.retry_count >= 3 THEN
      v_skipped := v_skipped || jsonb_build_object('id', v_row.id, 'reason', 'max_retries_exceeded');
      CONTINUE;
    END IF;
    IF has_aa05_prohibited_terms(v_row.caption) THEN
      v_skipped := v_skipped || jsonb_build_object('id', v_row.id, 'reason', 'aa05_prohibited_terms');
      CONTINUE;
    END IF;
    v_items := v_items || jsonb_build_object(
      'id', v_row.id,
      'caption',         v_row.caption,
      'hashtags',        COALESCE(v_row.hashtags, ARRAY[]::text[]),
      'media_url',       v_row.media_url,
      'scheduled_date',  v_row.scheduled_date,
      'scheduled_time',  v_row.scheduled_time,
      'retry_count',     v_row.retry_count
    );
  END LOOP;
  RETURN jsonb_build_object(
    'agency_id', p_agency_id, 'platform', 'facebook', 'tz', p_tz,
    'as_of', to_char(v_now AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
    'items', v_items, 'skipped', v_skipped
  );
END
$$;

CREATE OR REPLACE FUNCTION public.prepare_linkedin_post_batch(
  p_agency_id uuid,
  p_tz        text DEFAULT 'America/New_York'
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_items   jsonb := '[]'::jsonb;
  v_skipped jsonb := '[]'::jsonb;
  v_row     content_calendar%ROWTYPE;
  v_now     timestamptz := NOW();
  v_today   date := (v_now AT TIME ZONE p_tz)::date;
  v_now_t   time := (v_now AT TIME ZONE p_tz)::time;
BEGIN
  FOR v_row IN
    SELECT *
    FROM   content_calendar
    WHERE  agency_id = p_agency_id
      AND  platform  = 'linkedin'
      AND  status    = 'scheduled'
      AND  scheduled_date <= v_today
      AND  (scheduled_time IS NULL OR scheduled_time <= v_now_t OR scheduled_date < v_today)
      AND  (last_attempted_at IS NULL OR last_attempted_at < v_now - interval '30 minutes')
    ORDER BY scheduled_date, scheduled_time NULLS FIRST, created_at
    LIMIT 25
  LOOP
    IF v_row.retry_count >= 3 THEN
      v_skipped := v_skipped || jsonb_build_object('id', v_row.id, 'reason', 'max_retries_exceeded');
      CONTINUE;
    END IF;
    IF has_aa05_prohibited_terms(v_row.caption) THEN
      v_skipped := v_skipped || jsonb_build_object('id', v_row.id, 'reason', 'aa05_prohibited_terms');
      CONTINUE;
    END IF;
    v_items := v_items || jsonb_build_object(
      'id', v_row.id,
      'caption',         v_row.caption,
      'hashtags',        COALESCE(v_row.hashtags, ARRAY[]::text[]),
      'media_url',       v_row.media_url,
      'scheduled_date',  v_row.scheduled_date,
      'scheduled_time',  v_row.scheduled_time,
      'retry_count',     v_row.retry_count
    );
  END LOOP;
  RETURN jsonb_build_object(
    'agency_id', p_agency_id, 'platform', 'linkedin', 'tz', p_tz,
    'as_of', to_char(v_now AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
    'items', v_items, 'skipped', v_skipped
  );
END
$$;

CREATE OR REPLACE FUNCTION public.prepare_instagram_reminder_batch(
  p_agency_id uuid,
  p_tz        text DEFAULT 'America/New_York'
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_items   jsonb := '[]'::jsonb;
  v_skipped jsonb := '[]'::jsonb;
  v_row     content_calendar%ROWTYPE;
  v_now     timestamptz := NOW();
  v_today   date := (v_now AT TIME ZONE p_tz)::date;
BEGIN
  FOR v_row IN
    SELECT *
    FROM   content_calendar
    WHERE  agency_id = p_agency_id
      AND  platform  = 'instagram'
      AND  status    = 'scheduled'
      AND  scheduled_date <= v_today
      AND  (last_attempted_at IS NULL OR last_attempted_at < v_now - interval '6 hours')
    ORDER BY scheduled_date, scheduled_time NULLS FIRST, created_at
    LIMIT 10
  LOOP
    IF has_aa05_prohibited_terms(v_row.caption) THEN
      v_skipped := v_skipped || jsonb_build_object('id', v_row.id, 'reason', 'aa05_prohibited_terms');
      CONTINUE;
    END IF;
    v_items := v_items || jsonb_build_object(
      'id', v_row.id,
      'caption',         v_row.caption,
      'hashtags',        COALESCE(v_row.hashtags, ARRAY[]::text[]),
      'media_url',       v_row.media_url,
      'scheduled_date',  v_row.scheduled_date,
      'scheduled_time',  v_row.scheduled_time,
      'retry_count',     v_row.retry_count
    );
  END LOOP;
  RETURN jsonb_build_object(
    'agency_id', p_agency_id, 'platform', 'instagram', 'tz', p_tz,
    'as_of', to_char(v_now AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
    'items', v_items, 'skipped', v_skipped
  );
END
$$;

GRANT EXECUTE ON FUNCTION public.prepare_facebook_post_batch(uuid, text)      TO service_role, authenticated;
GRANT EXECUTE ON FUNCTION public.prepare_linkedin_post_batch(uuid, text)      TO service_role, authenticated;
GRANT EXECUTE ON FUNCTION public.prepare_instagram_reminder_batch(uuid, text) TO service_role, authenticated;


-- ---------------------------------------------------------------------
-- 4. log_social_post_result — success + retry/failure handling.
-- ---------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.log_social_post_result(
  p_agency_id uuid,
  p_recipe_id uuid,
  p_result    jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_results        jsonb := COALESCE(p_result->'results', '[]'::jsonb);
  v_skipped        jsonb := COALESCE(p_result->'skipped', '[]'::jsonb);
  v_item           jsonb;
  v_posted         int := 0;
  v_failed         int := 0;
  v_reminded       int := 0;
  v_alerts_created int := 0;
  v_row            content_calendar%ROWTYPE;
  v_new_retry      int;
  v_summary        text;
BEGIN
  FOR v_item IN SELECT * FROM jsonb_array_elements(v_results)
  LOOP
    SELECT * INTO v_row
    FROM   content_calendar
    WHERE  agency_id = p_agency_id AND id = (v_item->>'id')::uuid
    FOR    UPDATE;
    IF NOT FOUND THEN CONTINUE; END IF;

    IF v_item->>'status' = 'posted' THEN
      UPDATE content_calendar
      SET    status            = 'posted',
             post_url          = v_item->>'post_url',
             posted_at         = NOW(),
             failure_reason    = NULL,
             last_attempted_at = NOW()
      WHERE  id = v_row.id;
      v_posted := v_posted + 1;

    ELSIF v_item->>'status' = 'reminded' THEN
      UPDATE content_calendar
      SET    last_attempted_at = NOW(),
             requires_manual   = true
      WHERE  id = v_row.id;
      v_reminded := v_reminded + 1;

    ELSIF v_item->>'status' = 'failed' THEN
      v_new_retry := COALESCE(v_row.retry_count, 0) + 1;
      IF v_new_retry >= 3 THEN
        UPDATE content_calendar
        SET    status            = 'failed',
               failure_reason    = v_item->>'error',
               retry_count       = v_new_retry,
               last_attempted_at = NOW()
        WHERE  id = v_row.id;
        INSERT INTO alerts (
          agency_id, alert_type, severity, title, message,
          module_reference, related_id, is_resolved, created_at
        ) VALUES (
          p_agency_id,
          'social_post_failed',
          'warning',
          format('Social post failed permanently: %s', COALESCE(v_row.platform, '?')),
          format('content_calendar id=%s exhausted %s retries. Last error: %s. Caption preview: %s',
                 v_row.id, v_new_retry, v_item->>'error', left(COALESCE(v_row.caption, ''), 120)),
          format('social_media:%s', v_row.platform),
          v_row.id,
          false,
          NOW()
        );
        v_alerts_created := v_alerts_created + 1;
      ELSE
        UPDATE content_calendar
        SET    failure_reason    = v_item->>'error',
               retry_count       = v_new_retry,
               last_attempted_at = NOW()
        WHERE  id = v_row.id;
      END IF;
      v_failed := v_failed + 1;
    END IF;
  END LOOP;

  FOR v_item IN SELECT * FROM jsonb_array_elements(v_skipped)
  LOOP
    INSERT INTO alerts (
      agency_id, alert_type, severity, title, message,
      module_reference, related_id, is_resolved, created_at
    ) VALUES (
      p_agency_id,
      'social_post_skipped',
      'info',
      format('Social post skipped: %s', v_item->>'reason'),
      format('content_calendar id=%s skipped: %s', v_item->>'id', v_item->>'reason'),
      'social_media:skipped',
      (v_item->>'id')::uuid,
      false,
      NOW()
    );
    v_alerts_created := v_alerts_created + 1;
  END LOOP;

  v_summary := format(
    '%s posted, %s reminded, %s failed, %s skipped, %s alerts',
    v_posted, v_reminded, v_failed, jsonb_array_length(v_skipped), v_alerts_created
  );
  RETURN jsonb_build_object(
    'status',          'ok',
    'posted',          v_posted,
    'reminded',        v_reminded,
    'failed',          v_failed,
    'skipped_count',   jsonb_array_length(v_skipped),
    'alerts_created',  v_alerts_created,
    'output_summary',  v_summary
  );
END
$$;

GRANT EXECUTE ON FUNCTION public.log_social_post_result(uuid, uuid, jsonb)
  TO service_role, authenticated;


-- ---------------------------------------------------------------------
-- 5. Patch the 3 social scheduler recipes.
-- ---------------------------------------------------------------------
-- Adds input_config.payload_rpc + input_config.result_rpc; fixes
-- internal_handler.  Recipes stay is_active=false until Phase v2.3.

UPDATE automation_recipes
SET    internal_handler = 'social_scheduler_facebook_orchestrator',
       input_config     = input_config
                        || jsonb_build_object(
                             'payload_rpc',  'prepare_facebook_post_batch',
                             'result_rpc',   'log_social_post_result',
                             'platform',     'facebook'
                           )
WHERE  id = '7566310a-a8a5-4596-ad41-88ecf363b688';

UPDATE automation_recipes
SET    internal_handler = 'social_scheduler_linkedin_orchestrator',
       input_config     = input_config
                        || jsonb_build_object(
                             'payload_rpc',  'prepare_linkedin_post_batch',
                             'result_rpc',   'log_social_post_result',
                             'platform',     'linkedin'
                           )
WHERE  id = '9a6529f4-4dfa-4b11-a540-b087d72ce751';

UPDATE automation_recipes
SET    internal_handler = 'social_scheduler_instagram_orchestrator',
       input_config     = input_config
                        || jsonb_build_object(
                             'payload_rpc',  'prepare_instagram_reminder_batch',
                             'result_rpc',   'log_social_post_result',
                             'platform',     'instagram',
                             'reminder_email', 'kwametyler.businessclaude@gmail.com'
                           )
WHERE  id = 'c7501e79-68b8-4fb4-a84e-be96a9d9651e';


-- ---------------------------------------------------------------------
-- 6. Smoke tests (already run at apply-time — kept here for repro)
-- ---------------------------------------------------------------------

DO $$
DECLARE
  v_plan       jsonb;
BEGIN
  IF has_aa05_prohibited_terms('Welcome to our agency! We help customers with their auto and home options.') THEN
    RAISE EXCEPTION 'TEST_FAIL: AA05 helper flagged a clean string';
  END IF;
  IF NOT has_aa05_prohibited_terms('Our experts deliver world-class solutions for clients.') THEN
    RAISE EXCEPTION 'TEST_FAIL: AA05 helper missed an obvious prohibited string';
  END IF;
  v_plan := prepare_facebook_post_batch('98aa8b9b-92e4-4ebc-8727-aa00ce696fab'::uuid, 'America/New_York');
  IF v_plan->>'platform' <> 'facebook' THEN
    RAISE EXCEPTION 'TEST_FAIL: prepare_facebook_post_batch returned wrong platform';
  END IF;
  v_plan := prepare_linkedin_post_batch('98aa8b9b-92e4-4ebc-8727-aa00ce696fab'::uuid, 'America/New_York');
  IF v_plan->>'platform' <> 'linkedin' THEN
    RAISE EXCEPTION 'TEST_FAIL: prepare_linkedin_post_batch returned wrong platform';
  END IF;
  v_plan := prepare_instagram_reminder_batch('98aa8b9b-92e4-4ebc-8727-aa00ce696fab'::uuid, 'America/New_York');
  IF v_plan->>'platform' <> 'instagram' THEN
    RAISE EXCEPTION 'TEST_FAIL: prepare_instagram_reminder_batch returned wrong platform';
  END IF;
  RAISE NOTICE '029_social_scheduler_v2_helpers: smoke tests passed';
END
$$;

COMMIT;
