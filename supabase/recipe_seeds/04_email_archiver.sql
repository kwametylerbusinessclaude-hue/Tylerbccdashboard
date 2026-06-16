-- =============================================================================
-- BCC Recipe Seed 04: Email Archiver
-- =============================================================================
-- Bulk-archive Gmail messages older than `older_than_days` using
-- GMAIL_MODIFY_LABELS, optionally routing attachments to Drive. Idempotent via
-- dedup_message_ids pulled from documents.notes (regex `gmail_msg=([a-f0-9]+)`).
--
-- ARCHITECTURE (v5 multi-step orchestrator, 2026-06-16):
--   1. Cron 0 13 * * * fires. automation-runner Edge Function reads the recipe.
--   2. internal_handler dispatch routes to runEmailArchiverOrchestrator(recipe).
--   3. Orchestrator calls payload_rpc = prepare_email_archive_batch -> plan jsonb
--      {gmail_query, archive_label, dedup_message_ids, max_batch, settings}.
--   4. Ensures the archive Gmail label exists; ensures the Drive folder exists.
--   5. GMAIL_FETCH_EMAILS with gmail_query (ids_only). Filters by dedup set.
--   6. Per message: fetch full -> if starred and preserve_starred=true SKIP ->
--      walk attachments -> GMAIL_GET_ATTACHMENT -> GOOGLEDRIVE_UPLOAD_FROM_URL
--      -> GMAIL_ADD_LABEL_TO_EMAIL (add archive label, remove INBOX).
--   7. Calls result_rpc = log_email_archive_result with
--      {archived_message_ids[], attachments_filed[]}. The result_rpc inserts
--      documents rows (dedup'd on agency_id + drive_file_id) and returns
--      {status, archived_messages, attachments_reported, documents_inserted,
--       output_summary} which the runner writes to automation_run_log.
--
-- PLACEHOLDERS TO REPLACE:
--   {{agency_id}}    The client's agency UUID
--
-- PREREQUISITES (must exist BEFORE this seed runs):
--   - Migration 024 (sf_comp_recap_ingest + email archiver helpers) applied:
--       public.prepare_email_archive_batch(uuid, int, int) RETURNS jsonb
--       public.log_email_archive_result(uuid, uuid, jsonb)  RETURNS jsonb
--   - automation-runner Edge Function deployed at v5 or later (the version
--     that contains runEmailArchiverOrchestrator + email_archiver_orchestrator
--     dispatch in executeRecipe). v4 and earlier will fall through to the
--     generic Composio path and crash because GMAIL_MODIFY_LABELS expects
--     per-message arguments that don't fit input_config verbatim.
--   - settings rows for the agency: composio_api_key (or env var),
--     composio_user_id, optional composio_gmail_auth_config_id,
--     composio_googledrive_auth_config_id, agency_timezone.
--
-- TYPE:        Hybrid (composio_action=GMAIL_MODIFY_LABELS for documentation;
--                     actual dispatch via internal_handler=email_archiver_orchestrator)
-- HANDLER:     email_archiver_orchestrator   (runs in the Edge Function, not in SQL)
-- SCHEDULE:    0 13 * * *   (13:00 UTC daily, after Document Processor settles)
-- ACTIVE:      true
-- =============================================================================

INSERT INTO automation_recipes (
    agency_id,
    recipe_name,
    recipe_description,
    trigger_type,
    cron_expression,
    composio_action,
    internal_handler,
    input_config,
    output_table,
    output_config,
    is_active
) VALUES (
    '{{agency_id}}'::uuid,
    'Email Archiver',
    'Bulk-archive Gmail messages older than older_than_days using GMAIL_MODIFY_LABELS, optionally routing attachments to Drive. Architecture: runner calls payload_rpc=prepare_email_archive_batch to get the gmail_query + dedup_message_ids + settings; runs GMAIL_FETCH_EMAILS with that query; loops the result set applying GMAIL_MODIFY_LABELS per message and downloading/uploading attachments; calls result_rpc=log_email_archive_result with archived_message_ids[] and attachments_filed[] to persist documents rows. Idempotent — dedup_message_ids prevents re-archiving anything already represented in documents.',
    'cron',
    '0 13 * * *',
    'GMAIL_MODIFY_LABELS',
    'email_archiver_orchestrator',
    '{
        "max_batch": 100,
        "result_rpc": "log_email_archive_result",
        "payload_rpc": "prepare_email_archive_batch",
        "archive_label": "BCC/Archived",
        "older_than_days": 30,
        "preserve_starred": true,
        "drive_folder_template": "BCC/{{year}}/{{month}}/{{category}}",
        "route_attachments_to_drive": true
    }'::jsonb,
    'documents',
    '{
        "conflict_keys": ["agency_id", "drive_file_id"],
        "log_to_run_log": true
    }'::jsonb,
    true
);

