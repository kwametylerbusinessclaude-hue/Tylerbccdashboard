-- ============================================================================
-- Email Archiver re-spec — fixes broken design from prior session.
-- ============================================================================
-- PRIOR DESIGN (broken):
--   composio_action = 'INTERNAL'
--   internal_handler = 'dispatch_email_archiver' (function never existed)
--   Result: every scheduled run failed since 2026-05-31 with
--           "no such function exists in the public schema"
--
-- NEW DESIGN (matches Daily Briefing convention):
--   composio_action      = 'GMAIL_MODIFY_LABELS'  (bulk-loop entry point)
--   internal_handler     = 'email_archiver_orchestrator'  (logical name)
--   input_config.payload_rpc = 'prepare_email_archive_batch'  (returns the plan)
--   input_config.result_rpc  = 'log_email_archive_result'     (accepts callback)
--
-- RUNNER CONTRACT (for the orchestrator that the next Claude wires up via GitHub):
--   1. Cron fires → runner reads recipe row
--   2. Runner calls payload_rpc(agency_id, ...) → gets back a jsonb plan with
--      gmail_query, dedup_message_ids[], settings{}, max_batch
--   3. Runner calls GMAIL_FETCH_EMAILS using gmail_query
--   4. Runner filters fetched messages against dedup_message_ids
--   5. For each surviving message (capped by max_batch):
--        a. If preserve_starred and message is starred → skip
--        b. Call GMAIL_MODIFY_LABELS to add archive_label and remove INBOX
--        c. If route_attachments_to_drive and message has attachments:
--             - For each attachment: GMAIL_GET_ATTACHMENT → GOOGLEDRIVE_UPLOAD
--               at templated path → collect drive_file_id + drive_url
--   6. Runner calls result_rpc(agency_id, recipe_id, result_jsonb)
--      where result_jsonb summarises archived_message_ids[] and
--      attachments_filed[] (each with message_id, file_name, drive_file_id, drive_url).
--   7. result_rpc inserts documents rows for newly-filed attachments,
--      returns aggregate summary that runner writes to automation_run_log.

-- ============================================================================
-- prepare_email_archive_batch — returns the archive plan
-- ============================================================================
CREATE OR REPLACE FUNCTION public.prepare_email_archive_batch(
  p_agency_id uuid,
  p_older_than_days int DEFAULT 30,
  p_max_batch int DEFAULT 100
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
AS $function$
DECLARE
  v_cutoff_date    date := CURRENT_DATE - p_older_than_days;
  v_dedup_ids      jsonb;
  v_drive_template text := 'BCC/{{year}}/{{month}}/{{category}}';
  v_archive_label  text := 'BCC/Archived';
  v_gmail_query    text;
BEGIN
  -- Pull dedup list: gmail message_ids already represented in documents.
  -- The runner skips these to avoid re-archiving and double-filing.
  -- We look at the upload_source column (e.g. 'gmail' or 'gmail_historical_import')
  -- and parse out the gmail message_id stored in notes (pattern: "gmail_msg=<id>").
  SELECT COALESCE(jsonb_agg(DISTINCT msg_id), '[]'::jsonb) INTO v_dedup_ids
  FROM (
    SELECT substring(notes FROM 'gmail_msg=([a-f0-9]+)') AS msg_id
    FROM public.documents
    WHERE agency_id = p_agency_id
      AND notes ILIKE '%gmail_msg=%'
  ) ids
  WHERE msg_id IS NOT NULL;

  -- Build Gmail query: messages older than cutoff, not in archive, not starred (runner double-checks starred)
  v_gmail_query := format(
    'before:%s -is:starred -in:archive -in:trash -in:spam',
    to_char(v_cutoff_date, 'YYYY/MM/DD')
  );

  RETURN jsonb_build_object(
    'gmail_query',      v_gmail_query,
    'cutoff_date',      v_cutoff_date,
    'archive_label',    v_archive_label,
    'max_batch',        p_max_batch,
    'dedup_message_ids', v_dedup_ids,
    'dedup_count',      jsonb_array_length(v_dedup_ids),
    'settings', jsonb_build_object(
      'preserve_starred',          true,
      'route_attachments_to_drive', true,
      'drive_folder_template',      v_drive_template
    )
  );
END;
$function$;

COMMENT ON FUNCTION public.prepare_email_archive_batch IS
'Email Archiver payload_rpc. Returns the search criteria, dedup list, and settings the runner uses to drive a bulk GMAIL_MODIFY_LABELS pass. Idempotent and side-effect-free — safe to call any time.';

-- ============================================================================
-- log_email_archive_result — accepts the runner callback and persists
-- ============================================================================
CREATE OR REPLACE FUNCTION public.log_email_archive_result(
  p_agency_id uuid,
  p_recipe_id uuid,
  p_result jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
AS $function$
DECLARE
  v_archived_count    int := 0;
  v_attachments_count int := 0;
  v_documents_inserted int := 0;
  v_attachment         jsonb;
  v_existing_doc_id    uuid;
BEGIN
  -- Top-line counts from the runner's report
  v_archived_count    := COALESCE(jsonb_array_length(p_result->'archived_message_ids'), 0);
  v_attachments_count := COALESCE(jsonb_array_length(p_result->'attachments_filed'),    0);

  -- Insert documents rows for each attachment filed to Drive
  -- Skip silently if an identical (agency, file_name, gmail_msg) tuple already exists
  IF v_attachments_count > 0 THEN
    FOR v_attachment IN SELECT * FROM jsonb_array_elements(p_result->'attachments_filed')
    LOOP
      -- Dedup: check if a documents row with this drive_file_id already exists
      SELECT id INTO v_existing_doc_id
      FROM public.documents
      WHERE agency_id = p_agency_id
        AND drive_file_id = v_attachment->>'drive_file_id'
      LIMIT 1;

      IF v_existing_doc_id IS NULL THEN
        INSERT INTO public.documents (
          agency_id, file_name, file_type,
          upload_source, drive_file_id, drive_url,
          processing_status, uploaded_by, uploaded_at, notes
        ) VALUES (
          p_agency_id,
          v_attachment->>'file_name',
          COALESCE(v_attachment->>'file_type', 'application/octet-stream'),
          'email_archiver',
          v_attachment->>'drive_file_id',
          v_attachment->>'drive_url',
          'inventoried',  -- not yet classified; Document Processor will pick up later
          'email_archiver_runner',
          NOW(),
          format('Auto-filed by Email Archiver run. gmail_msg=%s | original_subject=%s',
                 v_attachment->>'message_id',
                 COALESCE(v_attachment->>'subject',''))
        );
        v_documents_inserted := v_documents_inserted + 1;
      END IF;
    END LOOP;
  END IF;

  RETURN jsonb_build_object(
    'status',              'ok',
    'archived_messages',    v_archived_count,
    'attachments_reported', v_attachments_count,
    'documents_inserted',   v_documents_inserted,
    'output_summary',       format(
      '%s emails archived; %s attachments filed (%s new documents rows; %s deduped)',
      v_archived_count,
      v_attachments_count,
      v_documents_inserted,
      v_attachments_count - v_documents_inserted
    )
  );
END;
$function$;

COMMENT ON FUNCTION public.log_email_archive_result IS
'Email Archiver result_rpc. Accepts the runner''s post-batch summary (archived_message_ids, attachments_filed) and persists per-attachment documents rows with dedup. Returns a structured summary the runner writes to automation_run_log.';

-- ============================================================================
-- Recipe metadata update — point to the new design
-- ============================================================================
UPDATE public.automation_recipes
SET composio_action     = 'GMAIL_MODIFY_LABELS',
    internal_handler    = 'email_archiver_orchestrator',
    input_config        = jsonb_build_object(
      'payload_rpc',                'prepare_email_archive_batch',
      'result_rpc',                 'log_email_archive_result',
      'older_than_days',            30,
      'max_batch',                  100,
      'preserve_starred',           true,
      'route_attachments_to_drive', true,
      'drive_folder_template',      'BCC/{{year}}/{{month}}/{{category}}',
      'archive_label',              'BCC/Archived'
    ),
    output_config       = jsonb_build_object(
      'conflict_keys',   jsonb_build_array('agency_id','drive_file_id'),
      'log_to_run_log',  true
    ),
    recipe_description  = 'Bulk-archive Gmail messages older than older_than_days using GMAIL_MODIFY_LABELS, optionally routing attachments to Drive. Architecture: runner calls payload_rpc=prepare_email_archive_batch to get the gmail_query + dedup_message_ids + settings; runs GMAIL_FETCH_EMAILS with that query; loops the result set applying GMAIL_MODIFY_LABELS per message and downloading/uploading attachments; calls result_rpc=log_email_archive_result with archived_message_ids[] and attachments_filed[] to persist documents rows. Idempotent — dedup_message_ids prevents re-archiving anything already represented in documents. Last design fix: migration 024 (2026-06-16, claude). is_active=false until runner-side support in GitHub repo is verified end-to-end against a low-volume test inbox.',
    last_run_status     = 'awaiting_runner_integration',
    updated_at          = NOW()
WHERE agency_id = '98aa8b9b-92e4-4ebc-8727-aa00ce696fab'
  AND recipe_name = 'Email Archiver';
