// =========================================================================
// automation-runner  (BCC Master Template)
// =========================================================================
// PURPOSE: Generic executor for any row in the automation_recipes table.
//   Triggered by:
//     (a) pg_cron tick via run_due_automation_recipes() in migration 011, or
//     (b) manual call from the Automations module in the BCC web app via
//         the run_automation_recipe(uuid) RPC.
//
// =========================================================================
// 2026-06-12 REFACTOR v3 — Resilient Composio auth resolution
// =========================================================================
// (history preserved from v3-v5 below)
//   1. user_id only                          → Composio auto-resolves the
//                                              ACTIVE connection for the
//                                              toolkit inferred from the tool
//                                              slug. Survives reconnects.
//   2. user_id + auth_config_id (ac_*)       → scoped to a stable integration
//                                              template; survives OAuth
//                                              refresh; auditable.
//   3. user_id + connected_account_id (ca_*) → fully explicit but BRITTLE —
//                                              ca_* rotates on every
//                                              reconnect, breaking recipes.
//
// Precedence (most-explicit wins):
//   connected_account_id  >  auth_config_id  >  user-only auto-resolution
//
// =========================================================================
// 2026-06-12 REFACTOR v4 — Pre-Composio payload_rpc pattern
// =========================================================================
// Any recipe can specify input_config.payload_rpc = 'fn_name' to delegate
// computation of the Composio arguments to a Postgres function.
//
// =========================================================================
// 2026-06-16 REFACTOR v5 — Multi-step orchestrators (internal_handler dispatch)
// =========================================================================
// Registered orchestrators:
//   email_archiver_orchestrator -> runEmailArchiverOrchestrator()
//
// =========================================================================
// 2026-06-17 REFACTOR v6 — Document Processor orchestrator (DETECT + FILE + ALERT)
// =========================================================================
// Added runDocumentProcessorOrchestrator(). Polls Gmail for SF + Paychex
// PDFs, classifies by filename/subject regex, files each to the appropriate
// Drive folder, inserts a documents row, and (for Comp Recap / Payroll /
// Deduction Stmt) fires an alert flagging the doc for downstream ingestion.
//
// =========================================================================
// 2026-06-17 REFACTOR v8 — Social Scheduler v2 orchestrators
// =========================================================================
// Adds three new orchestrators registered under internal_handler:
//   social_scheduler_facebook_orchestrator   -> runFacebookScheduler()
//   social_scheduler_linkedin_orchestrator   -> runLinkedInScheduler()
//   social_scheduler_instagram_orchestrator  -> runInstagramReminder()
//
// All three use the payload_rpc / result_rpc plumbing from migration 029:
//   payload_rpc returns a jsonb plan of due content_calendar items.
//   For Facebook/LinkedIn, the orchestrator posts each item via the
//   corresponding Composio action (FACEBOOK_POST_TO_PAGE / LINKEDIN_CREATE_POST)
//   and captures the post_url.  For Instagram, it sends a Gmail
//   reminder email (no auto-post API exists).  result_rpc updates
//   content_calendar status + retry_count + fires alerts on terminal
//   failure or AA05-prohibited content.
//
// AA05 word-rule pre-flight (TS) runs in addition to the SQL belt; both
// catch the same canonical prohibited terms.  TS list is slightly richer.
//
// Registered orchestrators after this commit:
//   email_archiver_orchestrator              -> runEmailArchiverOrchestrator()
//   document_processor_orchestrator          -> runDocumentProcessorOrchestrator()
//   social_scheduler_facebook_orchestrator   -> runFacebookScheduler()
//   social_scheduler_linkedin_orchestrator   -> runLinkedInScheduler()
//   social_scheduler_instagram_orchestrator  -> runInstagramReminder()
//
// All three social recipes stay is_active=false in Phase v2.0.  Phase
// v2.3 activates them once social_accounts table is populated +
// Composio Facebook/LinkedIn connections confirmed.
// =========================================================================

// =========================================================================
// 2026-06-17 REFACTOR v7 — Document Processor stage C (PARSE + INGEST)
// =========================================================================
// Adds the in-Edge-Function parse leg.  Gated by recipe input_config flag
// `groq_parse_enabled` — default false, so v1 (v6) behavior is preserved
// exactly when the flag is off.
//
// stageCParse() — per-document:
//   1. Re-fetches the PDF bytes from the s3url issued by GMAIL_GET_ATTACHMENT
//      (still hot within the same orchestrator call).
//   2. Calls a multimodal LLM (default model llama-4-scout via Composio
//      Groq) with PARSER_PROMPT + the PDF as a base64-encoded image part.
//   3. Validates the JSON shape, applies DESC_RULES (TS port of the
//      Python parser's substring-match categorisation table), and
//      transforms the LLM output into the sf_comp_recap_ingest payload.
//   4. Calls public.sf_comp_recap_ingest(p_agency_id, p_document_id, p_payload).
//   5. Marks the row via public.mark_document_parsed(...).
//
// Backfill HTTP endpoint:
//   POST {agency_id, shared_secret, backfill_doc_ids: [...]} runs stageCParse
//   against a list of already-filed documents (downloads from Drive instead
//   of Gmail).  Capped at 10 docs per call (matches the
//   run_document_processor_backfill RPC ceiling).
//
// Registered orchestrators after this commit:
//   email_archiver_orchestrator    -> runEmailArchiverOrchestrator()
//   document_processor_orchestrator -> runDocumentProcessorOrchestrator()
//                                    (with optional stage C parse leg)
// =========================================================================
//
// CREDENTIALS (unchanged):
//   Edge Function Secrets:
//     COMPOSIO_API_KEY               - Composio API key
//   Per-agency settings table rows:
//     automation_runner_cron_secret  - random secret, referenced by mig 011
//     composio_api_key               - OPTIONAL per-agency override of env var
//     composio_user_id               - Composio user ID (REQUIRED)
//     composio_<conn>_auth_config_id - OPTIONAL stable integration scope (ac_*)
//     composio_<conn>_account_id     - OPTIONAL legacy explicit override (ca_*)
//     telegram_bot_token             - OPTIONAL; failure alerts only
//     telegram_chat_id               - OPTIONAL; failure alerts only
//     agency_timezone                - OPTIONAL; passed to payload_rpc functions
//
// AUTH:
//   verify_jwt = false
//   POST body must contain shared_secret matching
//   automation_runner_cron_secret in settings.
// =========================================================================

// deno-lint-ignore-file no-explicit-any
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const sb = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const COMPOSIO_BASE = "https://backend.composio.dev/api/v3/tools/execute";
const COMPOSIO_LLM_TOOL = "COMPOSIO_SEARCH_GROQ_CHAT";
const LLM_MODEL_DEFAULT = "llama-3.3-70b-versatile";

// v7: default multimodal model for Doc Processor stage C.  Overridable per
// recipe via input_config.parse_llm_model.  Open question #1 from the v2
// spec confirms in Phase v2.1 testing whether this model produces parity
// with the existing manual Python parser; if not, swap to another Groq
// vision model without redeploying by patching input_config.
const LLM_MODEL_MULTIMODAL_DEFAULT = "meta-llama/llama-4-scout-17b-16e-instruct";

function stripFences(s: string): string {
  return s.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
}

async function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function getSetting(agencyId: string, key: string): Promise<string | null> {
  const { data, error } = await sb.from("settings").select("setting_value")
    .eq("agency_id", agencyId).eq("setting_key", key).maybeSingle();
  if (error) throw new Error(`settings read failed for agency ${agencyId} key ${key}: ${error.message}`);
  return data?.setting_value ?? null;
}

async function telegram(agencyId: string | null, text: string): Promise<void> {
  if (!agencyId) return;
  const botToken = await getSetting(agencyId, "telegram_bot_token");
  const chatId = await getSetting(agencyId, "telegram_chat_id");
  if (!botToken || !chatId) return;
  try {
    await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: "HTML", disable_web_page_preview: true }),
    });
  } catch (_e) { /* Telegram failures are non-fatal */ }
}

function jsonResponse(body: any, status = 200): Response {
  return new Response(JSON.stringify(body, null, 2), { status, headers: { "Content-Type": "application/json" } });
}

async function callComposio(opts: {
  apiKey: string; userId: string; connectedAccountId?: string | null; authConfigId?: string | null;
  toolSlug: string; toolArguments: Record<string, any>;
}): Promise<{ ok: boolean; data: any; error: string | null; httpStatus: number }> {
  const body: Record<string, any> = { user_id: opts.userId, arguments: opts.toolArguments };
  if (opts.connectedAccountId) body.connected_account_id = opts.connectedAccountId;
  else if (opts.authConfigId)   body.auth_config_id      = opts.authConfigId;

  const res = await fetch(`${COMPOSIO_BASE}/${opts.toolSlug}`, {
    method: "POST",
    headers: { "x-api-key": opts.apiKey, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let parsed: any = {};
  try { parsed = JSON.parse(text); } catch { parsed = { raw: text }; }
  const ok = res.ok && !!parsed?.successful;
  const data = parsed?.data?.response_data ?? parsed?.data ?? null;
  const error = ok ? null : (parsed?.error?.message || parsed?.error || text.slice(0, 400));
  return { ok, data, error, httpStatus: res.status };
}

async function callComposioLLM(opts: {
  composioApiKey: string; composioUserId: string; systemPrompt: string; userContent: string;
  model?: string; maxTokens?: number;
}): Promise<{ ok: boolean; data: any; error: string | null }> {
  const body = {
    user_id: opts.composioUserId,
    arguments: {
      messages: [
        { role: "system", content: opts.systemPrompt + "\n\nReturn ONLY a raw JSON object. No markdown. No code fences. No prose before or after the JSON." },
        { role: "user", content: opts.userContent },
      ],
      model: opts.model ?? LLM_MODEL_DEFAULT,
      temperature: 0.1,
      max_tokens: opts.maxTokens ?? 4096,
    },
  };
  let lastErr = "unknown";
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch(`${COMPOSIO_BASE}/${COMPOSIO_LLM_TOOL}`, {
      method: "POST",
      headers: { "x-api-key": opts.composioApiKey, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if ((res.status === 429 || res.status >= 500) && attempt < 2) { await sleep(500 * Math.pow(2, attempt)); continue; }
    const text = await res.text();
    let parsed: any = {};
    try { parsed = JSON.parse(text); } catch { parsed = { raw: text }; }
    if (!res.ok) { lastErr = parsed?.error?.message || parsed?.error || text.slice(0, 400); return { ok: false, data: null, error: lastErr }; }
    if (!parsed?.successful) { lastErr = parsed?.error || "Composio LLM call unsuccessful"; return { ok: false, data: null, error: lastErr }; }
    const choice = parsed?.data?.choices?.[0];
    const content = choice?.message?.content;
    if (!content) return { ok: false, data: null, error: "Composio LLM returned empty content" };
    if (choice?.finish_reason === "length") console.warn("[callComposioLLM] finish_reason=length — output may be truncated");
    const cleaned = stripFences(content);
    let extracted: any;
    try { extracted = JSON.parse(cleaned); }
    catch (e) { return { ok: false, data: null, error: `LLM response was not valid JSON after fence-stripping: ${(e as Error).message}` }; }
    return { ok: true, data: extracted, error: null };
  }
  return { ok: false, data: null, error: `LLM call exhausted retries: ${lastErr}` };
}

async function getComposioAccountId(agencyId: string, connection: string): Promise<string | null> {
  return await getSetting(agencyId, `composio_${connection.toLowerCase()}_account_id`);
}

async function getComposioAuthConfigId(agencyId: string, connection: string): Promise<string | null> {
  return await getSetting(agencyId, `composio_${connection.toLowerCase()}_auth_config_id`);
}

async function resolveToolArguments(
  agencyId: string,
  inputConfig: Record<string, any>,
): Promise<Record<string, any>> {
  const payloadRpc: string | undefined = inputConfig?.payload_rpc;
  if (!payloadRpc) {
    const { payload_rpc: _a, tz: _b, ...rest } = inputConfig || {};
    return rest;
  }
  const tz = inputConfig.tz
    || await getSetting(agencyId, "agency_timezone")
    || "America/New_York";
  const { data, error } = await sb.rpc(payloadRpc, { p_agency_id: agencyId, p_tz: tz });
  if (error) throw new Error(`payload_rpc '${payloadRpc}' failed: ${error.message}`);
  if (!data || typeof data !== "object") throw new Error(`payload_rpc '${payloadRpc}' returned non-object value`);
  return data as Record<string, any>;
}

async function writeOutput(opts: {
  outputTable: string; outputConfig: any; records: any[]; agencyId: string | null;
}): Promise<{ inserted: number; updated: number }> {
  if (!Array.isArray(opts.records) || opts.records.length === 0) return { inserted: 0, updated: 0 };
  const records = opts.agencyId ? opts.records.map((r) => ({ agency_id: opts.agencyId, ...r })) : opts.records;
  const uniqueOn: string[] | undefined = opts.outputConfig?.unique_on;
  const onConflict: string = opts.outputConfig?.on_conflict || "ignore";
  if (uniqueOn && uniqueOn.length > 0 && onConflict === "update") {
    const { data, error } = await sb.from(opts.outputTable)
      .upsert(records, { onConflict: uniqueOn.join(","), ignoreDuplicates: false }).select("id");
    if (error) throw new Error(`upsert to ${opts.outputTable} failed: ${error.message}`);
    return { inserted: data?.length ?? 0, updated: 0 };
  }
  if (uniqueOn && uniqueOn.length > 0) {
    const { data, error } = await sb.from(opts.outputTable)
      .upsert(records, { onConflict: uniqueOn.join(","), ignoreDuplicates: true }).select("id");
    if (error) throw new Error(`insert to ${opts.outputTable} failed: ${error.message}`);
    return { inserted: data?.length ?? 0, updated: 0 };
  }
  const { data, error } = await sb.from(opts.outputTable).insert(records).select("id");
  if (error) throw new Error(`insert to ${opts.outputTable} failed: ${error.message}`);
  return { inserted: data?.length ?? 0, updated: 0 };
}

async function executeRecipe(recipe: any, triggeredBy: string): Promise<any> {
  const started = Date.now();
  const recipeId = recipe.id as string;
  const agencyId = recipe.agency_id as string;

  await sb.from("automation_recipes").update({ last_run_at: new Date().toISOString(), last_run_status: "running" }).eq("id", recipeId);

  let runStatus = "success";
  let errorMessage: string | null = null;
  let recordsProcessed = 0;
  let outputSummary = "";

  try {
    if (recipe.composio_action === "INTERNAL" && recipe.internal_handler !== "email_archiver_orchestrator" && recipe.internal_handler !== "document_processor_orchestrator" && recipe.internal_handler !== "social_scheduler_facebook_orchestrator" && recipe.internal_handler !== "social_scheduler_linkedin_orchestrator" && recipe.internal_handler !== "social_scheduler_instagram_orchestrator") {
      const { data: internalResult, error: internalErr } = await sb.rpc("run_internal_recipe", { p_recipe_id: recipeId });
      if (internalErr) throw new Error(`run_internal_recipe failed: ${internalErr.message}`);
      recordsProcessed = (internalResult?.records_processed as number) ?? 0;
      outputSummary = (internalResult?.output_summary as string) ?? `INTERNAL recipe completed (no summary returned)`;
      const durationSec = Math.round((Date.now() - started) / 1000);
      await sb.from("automation_run_log").insert({
        agency_id: agencyId, recipe_id: recipeId, status: "success",
        records_processed: recordsProcessed, error_message: null,
        duration_seconds: durationSec, output_summary: outputSummary,
      });
      await sb.from("automation_recipes").update({ last_run_status: "success" }).eq("id", recipeId);
      return {
        recipe_id: recipeId, recipe_name: recipe.recipe_name, status: "success",
        records_processed: recordsProcessed, duration_seconds: durationSec,
        triggered_by: triggeredBy, error: null,
      };
    }

    // v5 dispatch: registered multi-step orchestrators
    if (recipe.internal_handler === "email_archiver_orchestrator") {
      const orchResult = await runEmailArchiverOrchestrator(recipe);
      recordsProcessed = orchResult.recordsProcessed;
      outputSummary = orchResult.outputSummary;
      const durationSec = Math.round((Date.now() - started) / 1000);
      await sb.from("automation_run_log").insert({
        agency_id: agencyId, recipe_id: recipeId, status: "success",
        records_processed: recordsProcessed, error_message: null,
        duration_seconds: durationSec, output_summary: outputSummary,
      });
      await sb.from("automation_recipes").update({ last_run_status: "success" }).eq("id", recipeId);
      return {
        recipe_id: recipeId, recipe_name: recipe.recipe_name, status: "success",
        records_processed: recordsProcessed, duration_seconds: durationSec,
        triggered_by: triggeredBy, error: null,
      };
    }

    // v6: Document Processor orchestrator
    if (recipe.internal_handler === "document_processor_orchestrator") {
      const orchResult = await runDocumentProcessorOrchestrator(recipe);
      recordsProcessed = orchResult.recordsProcessed;
      outputSummary = orchResult.outputSummary;
      const durationSec = Math.round((Date.now() - started) / 1000);
      await sb.from("automation_run_log").insert({
        agency_id: agencyId, recipe_id: recipeId, status: "success",
        records_processed: recordsProcessed, error_message: null,
        duration_seconds: durationSec, output_summary: outputSummary,
      });
      await sb.from("automation_recipes").update({ last_run_status: "success" }).eq("id", recipeId);
      return {
        recipe_id: recipeId, recipe_name: recipe.recipe_name, status: "success",
        records_processed: recordsProcessed, duration_seconds: durationSec,
        triggered_by: triggeredBy, error: null,
      };
    }

    // v8: Social Scheduler orchestrators (Facebook / LinkedIn / Instagram).
    // All three share the social_scheduler_* internal_handler family and
    // resolve to a single dispatch function with the platform in input_config.
    if (recipe.internal_handler === "social_scheduler_facebook_orchestrator" ||
        recipe.internal_handler === "social_scheduler_linkedin_orchestrator" ||
        recipe.internal_handler === "social_scheduler_instagram_orchestrator") {
      const orchResult = await runSocialScheduler(recipe);
      recordsProcessed = orchResult.recordsProcessed;
      outputSummary = orchResult.outputSummary;
      const durationSec = Math.round((Date.now() - started) / 1000);
      await sb.from("automation_run_log").insert({
        agency_id: agencyId, recipe_id: recipeId, status: "success",
        records_processed: recordsProcessed, error_message: null,
        duration_seconds: durationSec, output_summary: outputSummary,
      });
      await sb.from("automation_recipes").update({ last_run_status: "success" }).eq("id", recipeId);
      return {
        recipe_id: recipeId, recipe_name: recipe.recipe_name, status: "success",
        records_processed: recordsProcessed, duration_seconds: durationSec,
        triggered_by: triggeredBy, error: null,
      };
    }

    const composioApiKey = Deno.env.get("COMPOSIO_API_KEY") || await getSetting(agencyId, "composio_api_key");
    if (!composioApiKey) {
      throw new Error(
        `Missing Composio API key. Set COMPOSIO_API_KEY in Edge Function Secrets `
        + `(Supabase Dashboard -> Edge Functions -> Secrets) or insert a `
        + `settings.composio_api_key row for agency ${agencyId}.`
      );
    }
    const composioUserId = await getSetting(agencyId, "composio_user_id");
    if (!composioUserId) throw new Error(`Missing settings credential: composio_user_id (agency ${agencyId})`);

    const connection = recipe.composio_connection;
    let accountId: string | null = null;
    let authConfigId: string | null = null;
    if (connection) {
      accountId    = await getComposioAccountId(agencyId, connection);
      authConfigId = await getComposioAuthConfigId(agencyId, connection);
    }

    const action = recipe.composio_action;
    if (!action) throw new Error(`Recipe ${recipe.recipe_name} has no composio_action set.`);

    const inputConfig = recipe.input_config || {};
    const toolArguments = await resolveToolArguments(agencyId, inputConfig);

    const composioResult = await callComposio({
      apiKey: composioApiKey, userId: composioUserId,
      connectedAccountId: accountId, authConfigId: authConfigId,
      toolSlug: action, toolArguments: toolArguments,
    });

    if (!composioResult.ok) throw new Error(`Composio ${action} failed: ${composioResult.error}`);

    let parsedRecords: any[] = [];
    if (recipe.groq_prompt && recipe.output_table) {
      const inputForLLM = JSON.stringify(composioResult.data).slice(0, 60000);
      const llmResult = await callComposioLLM({
        composioApiKey, composioUserId,
        systemPrompt: recipe.groq_prompt + '\n\nReturn a JSON object: {"records": [...]} where records is an array of objects ready to insert into the output_table. Return {"records": []} if nothing applicable.',
        userContent: inputForLLM,
      });
      if (!llmResult.ok) throw new Error(`LLM parsing failed: ${llmResult.error}`);
      parsedRecords = Array.isArray(llmResult.data?.records) ? llmResult.data.records : [];
    } else if (recipe.output_table && Array.isArray(composioResult.data)) {
      parsedRecords = composioResult.data;
    }

    if (recipe.output_table && parsedRecords.length > 0) {
      const writeResult = await writeOutput({
        outputTable: recipe.output_table, outputConfig: recipe.output_config || {},
        records: parsedRecords, agencyId: agencyId,
      });
      recordsProcessed = writeResult.inserted + writeResult.updated;
      outputSummary = `${recordsProcessed} records written to ${recipe.output_table}`;
    } else if (recipe.output_table) {
      outputSummary = `Action ${action} executed successfully (output_table set but no records to write — likely payload_rpc handled persistence)`;
      recordsProcessed = 1;
    } else {
      outputSummary = `Action ${action} executed successfully (no output_table)`;
      recordsProcessed = 1;
    }
  } catch (err) {
    runStatus = "failed";
    errorMessage = err instanceof Error ? err.message : String(err);
    outputSummary = `Failed: ${errorMessage.slice(0, 200)}`;
    await telegram(agencyId, `🛑 <b>Automation FAILED</b>\n\nRecipe: <b>${recipe.recipe_name}</b>\nError: ${errorMessage.slice(0, 400)}`);
  }

  const durationSec = Math.round((Date.now() - started) / 1000);
  await sb.from("automation_run_log").insert({
    agency_id: agencyId, recipe_id: recipeId, status: runStatus,
    records_processed: recordsProcessed, error_message: errorMessage,
    duration_seconds: durationSec, output_summary: outputSummary,
  });
  await sb.from("automation_recipes").update({ last_run_status: runStatus }).eq("id", recipeId);

  return {
    recipe_id: recipeId, recipe_name: recipe.recipe_name, status: runStatus,
    records_processed: recordsProcessed, duration_seconds: durationSec,
    triggered_by: triggeredBy, error: errorMessage,
  };
}

// =========================================================================
// Multi-step orchestrators (v5+)
// =========================================================================

async function ensureGmailLabelId(opts: {
  apiKey: string; userId: string; accountId: string | null; authConfigId: string | null; labelName: string;
}): Promise<string> {
  const listRes = await callComposio({
    apiKey: opts.apiKey, userId: opts.userId,
    connectedAccountId: opts.accountId, authConfigId: opts.authConfigId,
    toolSlug: "GMAIL_LIST_LABELS", toolArguments: {},
  });
  if (listRes.ok) {
    const labels = listRes.data?.labels || listRes.data || [];
    const arr = Array.isArray(labels) ? labels : (labels.labels || []);
    const found = Array.isArray(arr) ? arr.find((l: any) => l && (l.name === opts.labelName)) : null;
    if (found?.id) return found.id;
  }
  const createRes = await callComposio({
    apiKey: opts.apiKey, userId: opts.userId,
    connectedAccountId: opts.accountId, authConfigId: opts.authConfigId,
    toolSlug: "GMAIL_CREATE_LABEL",
    toolArguments: { label_name: opts.labelName, name: opts.labelName },
  });
  if (!createRes.ok) throw new Error(`GMAIL_CREATE_LABEL '${opts.labelName}' failed: ${createRes.error}`);
  const id = createRes.data?.id || createRes.data?.label?.id;
  if (!id) throw new Error(`GMAIL_CREATE_LABEL '${opts.labelName}' returned no id`);
  return id;
}

async function findOrCreateDriveFolder(opts: {
  apiKey: string; userId: string; accountId: string | null; authConfigId: string | null;
  pathSegments: string[];
}): Promise<{ folderId: string; folderPath: string }> {
  let parentId: string | null = null;
  for (const seg of opts.pathSegments) {
    const findArgs: Record<string, any> = { name_exact: seg };
    if (parentId) findArgs.parent_folder_id = parentId;
    const findRes = await callComposio({
      apiKey: opts.apiKey, userId: opts.userId,
      connectedAccountId: opts.accountId, authConfigId: opts.authConfigId,
      toolSlug: "GOOGLEDRIVE_FIND_FOLDER", toolArguments: findArgs,
    });
    let foundId: string | null = null;
    if (findRes.ok) {
      const d = findRes.data || {};
      const candidates = d.files || d.items || d.folders || d.results || [];
      if (Array.isArray(candidates) && candidates.length > 0) {
        foundId = candidates[0].id || candidates[0].file_id || candidates[0].folder_id;
      }
    }
    if (!foundId) {
      const createArgs: Record<string, any> = { folder_name: seg, name: seg };
      if (parentId) { createArgs.parent_id = parentId; createArgs.parent_folder_id = parentId; }
      const createRes = await callComposio({
        apiKey: opts.apiKey, userId: opts.userId,
        connectedAccountId: opts.accountId, authConfigId: opts.authConfigId,
        toolSlug: "GOOGLEDRIVE_CREATE_FOLDER", toolArguments: createArgs,
      });
      if (!createRes.ok) throw new Error(`GOOGLEDRIVE_CREATE_FOLDER for '${seg}' failed: ${createRes.error}`);
      const d = createRes.data || {};
      foundId = d.id || d.file_id || d.folder_id;
      if (!foundId) throw new Error(`GOOGLEDRIVE_CREATE_FOLDER returned no id for '${seg}'`);
    }
    parentId = foundId;
  }
  return { folderId: parentId!, folderPath: opts.pathSegments.join("/") };
}

function resolveDriveFolderTemplate(template: string, tz: string, category: string): string[] {
  const now = new Date();
  const fmt = new Intl.DateTimeFormat("en-US", { timeZone: tz, year: "numeric", month: "2-digit" });
  const parts: Record<string, string> = {};
  for (const p of fmt.formatToParts(now)) parts[p.type] = p.value;
  const year = parts.year || String(now.getUTCFullYear());
  const month = parts.month || String(now.getUTCMonth() + 1).padStart(2, "0");
  const resolved = template
    .replace(/\{\{year\}\}/g, year)
    .replace(/\{\{month\}\}/g, month)
    .replace(/\{\{category\}\}/g, category);
  return resolved.split("/").filter((s) => s.length > 0);
}

async function runEmailArchiverOrchestrator(recipe: any): Promise<{
  recordsProcessed: number; outputSummary: string;
}> {
  const agencyId = recipe.agency_id as string;
  const input = recipe.input_config || {};
  const olderThanDays = Number(input.older_than_days ?? 30);
  const maxBatch = Math.min(Number(input.max_batch ?? 100), 100);
  const routeAttachments = input.route_attachments_to_drive !== false;
  const preserveStarred = input.preserve_starred !== false;
  const folderTemplate = input.drive_folder_template || "BCC/{{year}}/{{month}}/{{category}}";
  const archiveLabelName = input.archive_label || "BCC/Archived";

  const composioApiKey = Deno.env.get("COMPOSIO_API_KEY") || await getSetting(agencyId, "composio_api_key");
  if (!composioApiKey) throw new Error("Missing Composio API key for email_archiver_orchestrator");
  const composioUserId = await getSetting(agencyId, "composio_user_id");
  if (!composioUserId) throw new Error("Missing settings.composio_user_id for email_archiver_orchestrator");
  const gmailAccountId    = await getComposioAccountId(agencyId, "gmail");
  const gmailAuthConfigId = await getComposioAuthConfigId(agencyId, "gmail");
  const driveAccountId    = await getComposioAccountId(agencyId, "googledrive");
  const driveAuthConfigId = await getComposioAuthConfigId(agencyId, "googledrive");

  const { data: plan, error: planErr } = await sb.rpc("prepare_email_archive_batch", {
    p_agency_id: agencyId,
    p_older_than_days: olderThanDays,
    p_max_batch: maxBatch,
  });
  if (planErr) throw new Error(`prepare_email_archive_batch failed: ${planErr.message}`);
  if (!plan || typeof plan !== "object") throw new Error("prepare_email_archive_batch returned no plan");
  const gmailQuery: string = plan.gmail_query;
  const dedupSet: Set<string> = new Set(Array.isArray(plan.dedup_message_ids) ? plan.dedup_message_ids : []);

  const archiveLabelId = await ensureGmailLabelId({
    apiKey: composioApiKey, userId: composioUserId,
    accountId: gmailAccountId, authConfigId: gmailAuthConfigId,
    labelName: archiveLabelName,
  });

  const tz = (await getSetting(agencyId, "agency_timezone")) || "America/New_York";
  let driveFolderId: string | null = null;
  let driveFolderPath = "";
  if (routeAttachments) {
    const segments = resolveDriveFolderTemplate(folderTemplate, tz, "email-archive");
    const folder = await findOrCreateDriveFolder({
      apiKey: composioApiKey, userId: composioUserId,
      accountId: driveAccountId, authConfigId: driveAuthConfigId,
      pathSegments: segments,
    });
    driveFolderId = folder.folderId;
    driveFolderPath = folder.folderPath;
  }

  const fetchRes = await callComposio({
    apiKey: composioApiKey, userId: composioUserId,
    connectedAccountId: gmailAccountId, authConfigId: gmailAuthConfigId,
    toolSlug: "GMAIL_FETCH_EMAILS",
    toolArguments: {
      query: gmailQuery,
      max_results: maxBatch,
      ids_only: true,
      verbose: false,
    },
  });
  if (!fetchRes.ok) throw new Error(`GMAIL_FETCH_EMAILS failed: ${fetchRes.error}`);
  const messages: any[] = (fetchRes.data?.messages) || (Array.isArray(fetchRes.data) ? fetchRes.data : []);
  const candidateIds: string[] = messages
    .map((m: any) => m?.messageId || m?.id)
    .filter((id: any) => typeof id === "string" && id.length > 0 && !dedupSet.has(id))
    .slice(0, maxBatch);

  if (candidateIds.length === 0) {
    return {
      recordsProcessed: 0,
      outputSummary: `No new messages to archive (query='${gmailQuery}'; ${dedupSet.size} dedup'd; ${messages.length} returned)`,
    };
  }

  const archivedIds: string[] = [];
  const attachmentsFiled: any[] = [];
  const skipped: { id: string; reason: string }[] = [];

  for (const msgId of candidateIds) {
    try {
      const msgRes = await callComposio({
        apiKey: composioApiKey, userId: composioUserId,
        connectedAccountId: gmailAccountId, authConfigId: gmailAuthConfigId,
        toolSlug: "GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID",
        toolArguments: { message_id: msgId, format: routeAttachments ? "full" : "metadata" },
      });
      if (!msgRes.ok) { skipped.push({ id: msgId, reason: `fetch_full: ${msgRes.error}` }); continue; }
      const msg: any = msgRes.data || {};

      const labelIds: string[] = msg.labelIds || msg.label_ids || msg.payload?.labelIds || [];
      const isStarred = labelIds.includes("STARRED");
      if (preserveStarred && isStarred) { skipped.push({ id: msgId, reason: "preserve_starred" }); continue; }

      let subject: string = msg.subject || "";
      if (!subject && Array.isArray(msg.payload?.headers)) {
        const h = msg.payload.headers.find((hh: any) => (hh.name || "").toLowerCase() === "subject");
        subject = h?.value || "";
      }

      const attachments: { attachmentId: string; filename: string; mimeType: string }[] = [];
      if (routeAttachments) {
        const walk = (parts: any[]): void => {
          for (const p of parts || []) {
            if (p?.filename && p?.body?.attachmentId) {
              attachments.push({
                attachmentId: p.body.attachmentId,
                filename: p.filename,
                mimeType: p.mimeType || "application/octet-stream",
              });
            }
            if (Array.isArray(p?.parts)) walk(p.parts);
          }
        };
        walk(msg.payload?.parts || []);
        if (attachments.length === 0 && Array.isArray(msg.attachmentList)) {
          for (const a of msg.attachmentList) {
            if (a?.attachmentId && a?.filename) {
              attachments.push({
                attachmentId: a.attachmentId,
                filename: a.filename,
                mimeType: a.mimeType || "application/octet-stream",
              });
            }
          }
        }
      }

      for (const att of attachments) {
        try {
          const getRes = await callComposio({
            apiKey: composioApiKey, userId: composioUserId,
            connectedAccountId: gmailAccountId, authConfigId: gmailAuthConfigId,
            toolSlug: "GMAIL_GET_ATTACHMENT",
            toolArguments: { message_id: msgId, attachment_id: att.attachmentId, file_name: att.filename },
          });
          if (!getRes.ok) { console.warn(`[email_archiver] GMAIL_GET_ATTACHMENT failed (${msgId}/${att.filename}): ${getRes.error}`); continue; }
          const file = getRes.data?.file || getRes.data || {};
          const s3url = file.s3url || file.url;
          if (!s3url) { console.warn(`[email_archiver] no s3url for ${msgId}/${att.filename}`); continue; }
          const uploadArgs: Record<string, any> = {
            source_url: s3url,
            name: att.filename,
            mime_type: file.mimetype || att.mimeType,
          };
          if (driveFolderId) uploadArgs.parent_folder_id = driveFolderId;
          const uploadRes = await callComposio({
            apiKey: composioApiKey, userId: composioUserId,
            connectedAccountId: driveAccountId, authConfigId: driveAuthConfigId,
            toolSlug: "GOOGLEDRIVE_UPLOAD_FROM_URL",
            toolArguments: uploadArgs,
          });
          if (!uploadRes.ok) { console.warn(`[email_archiver] GOOGLEDRIVE_UPLOAD_FROM_URL failed for ${att.filename}: ${uploadRes.error}`); continue; }
          const driveFile = uploadRes.data || {};
          const driveFileId: string | null = driveFile.id || driveFile.file_id || driveFile.fileId || null;
          if (!driveFileId) { console.warn(`[email_archiver] upload returned no id for ${att.filename}`); continue; }
          const driveUrl: string = driveFile.webViewLink || driveFile.url
            || `https://drive.google.com/file/d/${driveFileId}/view`;
          attachmentsFiled.push({
            message_id: msgId,
            subject,
            file_name: att.filename,
            file_type: file.mimetype || att.mimeType,
            drive_file_id: driveFileId,
            drive_url: driveUrl,
          });
        } catch (attErr) {
          console.warn(`[email_archiver] attachment crash (${msgId}/${att.filename}): ${attErr instanceof Error ? attErr.message : attErr}`);
        }
      }

      const labelRes = await callComposio({
        apiKey: composioApiKey, userId: composioUserId,
        connectedAccountId: gmailAccountId, authConfigId: gmailAuthConfigId,
        toolSlug: "GMAIL_ADD_LABEL_TO_EMAIL",
        toolArguments: {
          message_id: msgId,
          add_label_ids: [archiveLabelId],
          remove_label_ids: ["INBOX"],
        },
      });
      if (!labelRes.ok) { skipped.push({ id: msgId, reason: `label_modify: ${labelRes.error}` }); continue; }
      archivedIds.push(msgId);
    } catch (loopErr) {
      skipped.push({ id: msgId, reason: `loop_crash: ${loopErr instanceof Error ? loopErr.message : loopErr}` });
    }
  }

  const { data: logResult, error: logErr } = await sb.rpc("log_email_archive_result", {
    p_agency_id: agencyId,
    p_recipe_id: recipe.id,
    p_result: { archived_message_ids: archivedIds, attachments_filed: attachmentsFiled },
  });
  if (logErr) throw new Error(`log_email_archive_result failed: ${logErr.message}`);

  if (skipped.length > 0) {
    console.warn(`[email_archiver] skipped detail (first 10): ${JSON.stringify(skipped.slice(0, 10))}`);
  }

  const driveDesc = routeAttachments ? `Drive: ${driveFolderPath}` : "Drive routing disabled";
  const fallback = `${archivedIds.length} archived; ${attachmentsFiled.length} attachments filed (${driveDesc}); ${skipped.length} skipped; ${dedupSet.size} dedup'd`;
  const outputSummary = (logResult?.output_summary as string) || fallback;
  return { recordsProcessed: archivedIds.length, outputSummary };
}

// =========================================================================
// v6: Document Processor Orchestrator
// =========================================================================
// Polls Gmail for SF Compensation Recap / Paychex Payroll / SF Deduction
// Statement PDFs. For each found PDF:
//   1. Classify by sender + filename + subject (regex)
//   2. File to Drive in the type-appropriate folder
//   3. Insert a documents row (via log_document_processor_result)
//   4. Apply 'BCC-Processed' label to Gmail message (so it dedups next run)
//   5. For Comp Recap / Payroll / Deduction Stmt: fire a "needs ingest" alert
//
// v1 SCOPE: detection + filing + alert. The LLM-driven parse for SF Comp Recap
// is NOT in this version — that stays as the manual backstop
// (scripts/parsers/sf_comp_recap.py) until Layer 3 v2 ports the parser to TS
// and confirms a multimodal LLM tool slug in Composio.
//
// Drive folder structure used (matches 2026-06-16 EVENING filing pass):
//   BCC Financial Records/
//     Live Documents (May 2026 forward)/
//       SF Compensation Recaps/<year>/
//       Paychex Payroll/<year>/
//       SF Deduction Statements/<year>/
//       Other/<year>/
// =========================================================================

interface ClassifiedAttachment {
  attachmentId: string;
  filename: string;
  mimeType: string;
  docType: "sf_comp_recap" | "paychex_payroll" | "sf_deduction_stmt" | "other";
  needsIngest: boolean;
  periodHint: string | null;     // e.g. "2026-05-second" for Comp Recaps
  driveSubfolder: string;        // category folder name
}

// Classification regexes. Most-specific patterns first.
function classifyAttachment(opts: {
  from: string;
  subject: string;
  filename: string;
  mimeType: string;
}): { docType: ClassifiedAttachment["docType"]; needsIngest: boolean; periodHint: string | null; driveSubfolder: string } {
  const from = (opts.from || "").toLowerCase();
  const subj = (opts.subject || "").toLowerCase();
  const fname = (opts.filename || "").toLowerCase();
  const isPdf = opts.mimeType === "application/pdf" || fname.endsWith(".pdf");

  // SF Comp Recap: from statefarm + (subject OR filename) hints
  if (
    from.includes("statefarm")
    && (
      /comp(ensation)?[\s_\-]*recap/.test(subj)
      || /comp(ensation)?[\s_\-]*recap/.test(fname)
      || /recapitulation/.test(subj)
    )
    && isPdf
  ) {
    return {
      docType: "sf_comp_recap",
      needsIngest: true,
      periodHint: extractCompRecapPeriodHint(fname, subj),
      driveSubfolder: "SF Compensation Recaps",
    };
  }

  // SF Deduction Statement
  if (
    from.includes("statefarm")
    && /deduction[\s_\-]*statement/.test(subj + " " + fname)
    && isPdf
  ) {
    return {
      docType: "sf_deduction_stmt",
      needsIngest: true,
      periodHint: null,
      driveSubfolder: "SF Deduction Statements",
    };
  }

  // Paychex payroll: from paychex + payroll hints
  if (
    from.includes("paychex")
    && (/payroll/.test(subj) || /payroll/.test(fname))
    && (isPdf || /\.(csv|xlsx?)$/.test(fname))
  ) {
    return {
      docType: "paychex_payroll",
      needsIngest: true,
      periodHint: null,
      driveSubfolder: "Paychex Payroll",
    };
  }

  // Generic SF or Paychex doc — file but don't fire ingest alert
  if (from.includes("statefarm") || from.includes("paychex")) {
    return {
      docType: "other",
      needsIngest: false,
      periodHint: null,
      driveSubfolder: "Other",
    };
  }

  // Shouldn't reach here given the Gmail query, but be defensive
  return { docType: "other", needsIngest: false, periodHint: null, driveSubfolder: "Other" };
}

// Period hint extractor: tries to find YYYY[-_]MM[-_]DD or YYYY_MM in filename/subject.
// Output format: "YYYY-MM-first" or "YYYY-MM-second" (matching comp_recap.period_half).
function extractCompRecapPeriodHint(filename: string, subject: string): string | null {
  const haystack = `${filename} ${subject}`;
  // Try YYYY[_-]MM[_-]DD first
  const ymd = haystack.match(/(20\d{2})[_\-\s\.]?(0?[1-9]|1[0-2])[_\-\s\.]?(0?[1-9]|[12]\d|3[01])/);
  if (ymd) {
    const year = ymd[1];
    const month = ymd[2].padStart(2, "0");
    const day = parseInt(ymd[3], 10);
    const half = day <= 15 ? "first" : "second";
    return `${year}-${month}-${half}`;
  }
  // Fall back to YYYY[_-]MM
  const ym = haystack.match(/(20\d{2})[_\-\s\.](0?[1-9]|1[0-2])\b/);
  if (ym) {
    const year = ym[1];
    const month = ym[2].padStart(2, "0");
    return `${year}-${month}-unknown_half`;
  }
  return null;
}

// Build the Drive path segments for a given document type.
function driveFolderForDocType(docType: ClassifiedAttachment["docType"], year: string): string[] {
  const subfolder = {
    sf_comp_recap:    "SF Compensation Recaps",
    paychex_payroll:  "Paychex Payroll",
    sf_deduction_stmt: "SF Deduction Statements",
    other:            "Other",
  }[docType];
  return [
    "BCC Financial Records",
    "Live Documents (May 2026 forward)",
    subfolder,
    year,
  ];
}


// =========================================================================
// v7 — Document Processor STAGE C: PARSE + INGEST
// =========================================================================
// PARSER_PROMPT and DESC_RULES are deliberately verbatim ports of
// scripts/parsers/sf_comp_recap.py.  The canonical JSON copy of
// DESC_RULES lives at supabase/functions/_shared/desc_rules.json; if the
// rules drift, run scripts/parsers/export_desc_rules.py to regenerate
// both the JSON and this TS constant.
// =========================================================================

const PARSER_PROMPT = `You are parsing one State Farm Agency Compensation Recap PDF. OCR'd from scan — ignore
artifacts ("FOKKER K", "RPRPPRPRP", "HERE", "FREE", "FRRERERE", "ACK", "He AA", "Ck ok",
"RRR EERE"), leading "1"s or "I"s on lines. Numbers and structure are reliable.

3 pages:
- PAGE 1 = PRODUCTION. Each line: DESCRIPTION  CURRENT  YEAR-TO-DATE
- PAGE 2 = PAYMENT. PAYABLE PER AGREEMENT (Per Schedules + AIPP).
  Optional: AWARDS & BONUSES, OTHER INCOME. Two columns.
- PAGE 3 = INFORMATION. Optional: Reportable Benefits. YTD federal/state totals.

RULES:
(1) Lines have 1 or 2 numbers. 2 nums = current then ytd. 1 num = ytd only (current=0).
(2) Trailing minus = negative. "528.47-" is -528.47.
(3) Strip OCR spaces inside numbers: "19 , 360.26" = 19360.26.
(4) Capture EVERY line item including zero or negative.
(5) SKIP aggregate lines: anything starting with "TOTAL ", GROSS COMPENSATION,
    ADJUSTED GROSS, LESS DEDUCTIONS, NET PAYABLE, PER SCHEDULES OF PAYMENT,
    YOUR CHECK FOR, REQUESTED 100%, state-by-state YTD totals at bottom of page 3.
(6) Capture: AUTO/STD AUTO/FIRE/HEALTH NEW BUSINESS, NEW-AMD66, RENEWAL SERVICE,
    RENEWAL-AMD66; FIRE ALLIANCE RENEWAL; FIRST YEAR WRITING, RENEWAL WRITING,
    SERVICING (SFL); IPSI PET INSURANCE / IPSI PET INSURANCE - RENEW; US BANK
    CREDIT CARD / GFA US BANK CREDIT CARD; AIPP payments (AUTO/STD AUTO/FIRE/
    LIFE/HEALTH AIPP PAYMENT); SCORECARD BONUS - {product}; CASH AWARD -
    {product}; AMBASSADOR TRAVEL ALLOWANCE - {product} (bonus); S & T COMPANY
    CONTRIBUTION - {product}; MARKETING ALLOWANCE; MEDICAL/DENTAL/GROUP DENTAL/
    LIFE INSURANCE CONTRIBUTION (benefits); INCOME UPDATE-PREV AWARDED-{product}
    (benefit); AMBASSADOR TRAVEL - {product} (benefit on page 3, NOT page 2).
(7) comp_type best guess (post-processing fixes): MUTL, SFL, STDAUTO, FIRE, IPSI, GFA,
    AIPP, BONUS, OTHER_INCOME, BENEFITS.
(8) comp_category lowercase short name. Best guess.
(9) is_aipp_eligible and is_scoreboard_eligible: best guess, will be overridden.
(10) Period from "RECAPITULATION OF AGENCY COMPENSATION ... FOR <PERIOD>":
   - 1-15 → period_half="first", recap_date = month's 15th
   - 16-end → period_half="second", recap_date = last day (28/29 Feb, 30/31 others)
(11) OCR-misread guard for BENEFITS lines (MEDICAL INSURANCE CONTRIBUTION,
    GROUP DENTAL INSURANCE CONTRIBUTION, DENTAL INSURANCE CONTRIBUTION, LIFE
    INSURANCE CONTRIBUTION, AMBASSADOR TRAVEL benefits, INCOME UPDATE benefits):
    a current_amount of 2.00 is almost always a 0.00 OCR misread.  When in
    doubt output 2.00; the deterministic post-processor will correct.
(12) AMBASSADOR TRAVEL disambiguation:
    - "AMBASSADOR TRAVEL ALLOWANCE - <PRODUCT>" → BONUS (page 2, Awards & Bonuses)
    - "AMBASSADOR TRAVEL - <PRODUCT>" (no "ALLOWANCE") → BENEFITS (page 3, Reportable Benefits)
    Both can appear in the same recap as separate line items.

ALSO capture the half-month and YTD GROSS COMPENSATION totals reported on the
PDF — source-of-truth for reconciliation.

Return ONLY raw JSON (no markdown fences, no commentary), with this shape:
{
  "agent_name": "...",
  "agent_code": "...",
  "territory": "...",
  "period_label": "...",
  "period_year": 2026,
  "period_month": 5,
  "period_half": "first" | "second",
  "recap_date": "2026-05-15",
  "totals": {
    "half_month_total_pdf": 266777.60,
    "ytd_total_pdf": 1097824.69
  },
  "line_items": [
    {
      "line_sequence": 1,
      "section": "page1_production" | "page2_payment" | "page3_information",
      "comp_type": "MUTL",
      "comp_category": "new_business",
      "description": "AUTO NEW BUSINESS",
      "current_amount": 2488.23,
      "ytd_amount": 14818.23,
      "is_aipp_eligible": true,
      "is_scoreboard_eligible": true
    }
  ]
}`;


// DESC_RULES — TS port of scripts/parsers/sf_comp_recap.py DESC_RULES.
// ORDER IS SIGNIFICANT.  Most-specific patterns FIRST.
// Canonical JSON at supabase/functions/_shared/desc_rules.json.
type DescRule = { pattern: string; comp_type: string; comp_category: string; is_aipp_eligible: boolean; is_scoreboard_eligible: boolean };
const DESC_RULES: DescRule[] = [
  // AIPP payments (most specific first)
  { pattern: "STD AUTO AIPP PAYMENT",                comp_type: "AIPP",         comp_category: "std_auto_aipp",           is_aipp_eligible: false, is_scoreboard_eligible: false },
  { pattern: "AUTO AIPP PAYMENT",                    comp_type: "AIPP",         comp_category: "auto_aipp",               is_aipp_eligible: false, is_scoreboard_eligible: false },
  { pattern: "HEALTH AIPP PAYMENT",                  comp_type: "AIPP",         comp_category: "health_aipp",             is_aipp_eligible: false, is_scoreboard_eligible: false },
  { pattern: "FIRE AIPP PAYMENT",                    comp_type: "AIPP",         comp_category: "fire_aipp",               is_aipp_eligible: false, is_scoreboard_eligible: false },
  { pattern: "LIFE AIPP PAYMENT",                    comp_type: "AIPP",         comp_category: "life_aipp",               is_aipp_eligible: false, is_scoreboard_eligible: false },
  // Scorecard bonuses
  { pattern: "SCORECARD BONUS - AUTO",               comp_type: "BONUS",        comp_category: "scorecard_auto",          is_aipp_eligible: false, is_scoreboard_eligible: false },
  { pattern: "SCORECARD BONUS - FIRE",               comp_type: "BONUS",        comp_category: "scorecard_fire",          is_aipp_eligible: false, is_scoreboard_eligible: false },
  { pattern: "SCORECARD BONUS - HEALTH",             comp_type: "BONUS",        comp_category: "scorecard_health",        is_aipp_eligible: false, is_scoreboard_eligible: false },
  { pattern: "SCORECARD BONUS - LIFE",               comp_type: "BONUS",        comp_category: "scorecard_life",          is_aipp_eligible: false, is_scoreboard_eligible: false },
  // Cash Awards
  { pattern: "CASH AWARD - LIFE",                    comp_type: "BONUS",        comp_category: "cash_award_life",         is_aipp_eligible: false, is_scoreboard_eligible: false },
  { pattern: "CASH AWARD - AUTO",                    comp_type: "BONUS",        comp_category: "cash_award_auto",         is_aipp_eligible: false, is_scoreboard_eligible: false },
  // Ambassador Travel ALLOWANCE → BONUS (BEFORE bare AMBASSADOR TRAVEL -)
  { pattern: "AMBASSADOR TRAVEL ALLOWANCE - HEALTH", comp_type: "BONUS",        comp_category: "ambassador_travel_health",is_aipp_eligible: false, is_scoreboard_eligible: false },
  { pattern: "AMBASSADOR TRAVEL ALLOWANCE - LIFE",   comp_type: "BONUS",        comp_category: "ambassador_travel_life",  is_aipp_eligible: false, is_scoreboard_eligible: false },
  { pattern: "AMBASSADOR TRAVEL ALLOWANCE - AUTO",   comp_type: "BONUS",        comp_category: "ambassador_travel_auto",  is_aipp_eligible: false, is_scoreboard_eligible: false },
  { pattern: "AMBASSADOR TRAVEL ALLOWANCE - FIRE",   comp_type: "BONUS",        comp_category: "ambassador_travel_fire",  is_aipp_eligible: false, is_scoreboard_eligible: false },
  // S & T + marketing
  { pattern: "S & T COMPANY CONTRIBUTION - AUTO",    comp_type: "OTHER_INCOME", comp_category: "s_t_contribution_auto",   is_aipp_eligible: false, is_scoreboard_eligible: false },
  { pattern: "S & T COMPANY CONTRIBUTION - FIRE",    comp_type: "OTHER_INCOME", comp_category: "s_t_contribution_fire",   is_aipp_eligible: false, is_scoreboard_eligible: false },
  { pattern: "S & T COMPANY CONTRIBUTION - LIFE",    comp_type: "OTHER_INCOME", comp_category: "s_t_contribution_life",   is_aipp_eligible: false, is_scoreboard_eligible: false },
  { pattern: "S & T COMPANY CONTRIBUTION - HEALTH",  comp_type: "OTHER_INCOME", comp_category: "s_t_contribution_health", is_aipp_eligible: false, is_scoreboard_eligible: false },
  { pattern: "MARKETING ALLOWANCE",                  comp_type: "OTHER_INCOME", comp_category: "marketing_allowance",     is_aipp_eligible: false, is_scoreboard_eligible: false },
  // Reportable Benefits
  { pattern: "MEDICAL INSURANCE CONTRIBUTION",       comp_type: "BENEFITS",     comp_category: "medical_insurance",       is_aipp_eligible: false, is_scoreboard_eligible: false },
  { pattern: "GROUP DENTAL INSURANCE CONTRIBUTION",  comp_type: "BENEFITS",     comp_category: "dental_insurance",        is_aipp_eligible: false, is_scoreboard_eligible: false },
  { pattern: "DENTAL INSURANCE CONTRIBUTION",        comp_type: "BENEFITS",     comp_category: "dental_insurance",        is_aipp_eligible: false, is_scoreboard_eligible: false },
  { pattern: "LIFE INSURANCE CONTRIBUTION",          comp_type: "BENEFITS",     comp_category: "life_insurance_benefit",  is_aipp_eligible: false, is_scoreboard_eligible: false },
  { pattern: "INCOME UPDATE-PREV AWARDED-AUTO",      comp_type: "BENEFITS",     comp_category: "income_update_auto",      is_aipp_eligible: false, is_scoreboard_eligible: false },
  { pattern: "INCOME UPDATE-PREV AWARDED-LIFE",      comp_type: "BENEFITS",     comp_category: "income_update_life",      is_aipp_eligible: false, is_scoreboard_eligible: false },
  { pattern: "INCOME UPDATE-PREV AWARDED-FIRE",      comp_type: "BENEFITS",     comp_category: "income_update_fire",      is_aipp_eligible: false, is_scoreboard_eligible: false },
  { pattern: "INCOME UPDATE-PREV AWARDED-HEALTH",    comp_type: "BENEFITS",     comp_category: "income_update_health",    is_aipp_eligible: false, is_scoreboard_eligible: false },
  // STD AUTO production (STD AUTO before AUTO)
  { pattern: "STD AUTO NEW BUSINESS",                comp_type: "STDAUTO",      comp_category: "new_business",            is_aipp_eligible: true,  is_scoreboard_eligible: true  },
  { pattern: "STD AUTO NEW - AMD66",                 comp_type: "STDAUTO",      comp_category: "new_amd66",               is_aipp_eligible: true,  is_scoreboard_eligible: true  },
  { pattern: "STD AUTO RENEWAL SERVICE",             comp_type: "STDAUTO",      comp_category: "renewal_service",         is_aipp_eligible: true,  is_scoreboard_eligible: false },
  { pattern: "STD AUTO RENEWAL - AMD66",             comp_type: "STDAUTO",      comp_category: "renewal_amd66",           is_aipp_eligible: true,  is_scoreboard_eligible: false },
  // FIRE production
  { pattern: "FIRE NEW BUSINESS",                    comp_type: "FIRE",         comp_category: "new_business",            is_aipp_eligible: true,  is_scoreboard_eligible: true  },
  { pattern: "FIRE NEW - AMD66",                     comp_type: "FIRE",         comp_category: "new_amd66",               is_aipp_eligible: true,  is_scoreboard_eligible: true  },
  { pattern: "FIRE RENEWAL SERVICE",                 comp_type: "FIRE",         comp_category: "renewal_service",         is_aipp_eligible: true,  is_scoreboard_eligible: false },
  { pattern: "FIRE RENEWAL - AMD66",                 comp_type: "FIRE",         comp_category: "renewal_amd66",           is_aipp_eligible: true,  is_scoreboard_eligible: false },
  { pattern: "FIRE ALLIANCE RENEWAL",                comp_type: "FIRE",         comp_category: "alliance_renewal",        is_aipp_eligible: true,  is_scoreboard_eligible: false },
  // IPSI (RENEW suffix before bare)
  { pattern: "IPSI PET INSURANCE - RENEW",           comp_type: "IPSI",         comp_category: "pet_insurance_renewal",   is_aipp_eligible: false, is_scoreboard_eligible: false },
  { pattern: "IPSI PET INSURANCE",                   comp_type: "IPSI",         comp_category: "pet_insurance_renewal",   is_aipp_eligible: false, is_scoreboard_eligible: false },
  // GFA US Bank
  { pattern: "GFA US BANK CREDIT CARD",              comp_type: "GFA",          comp_category: "us_bank_credit_card",     is_aipp_eligible: false, is_scoreboard_eligible: false },
  { pattern: "US BANK CREDIT CARD",                  comp_type: "GFA",          comp_category: "us_bank_credit_card",     is_aipp_eligible: false, is_scoreboard_eligible: false },
  // SFL
  { pattern: "FIRST YEAR WRITING",                   comp_type: "SFL",          comp_category: "first_year_writing",      is_aipp_eligible: true,  is_scoreboard_eligible: true  },
  { pattern: "RENEWAL WRITING",                      comp_type: "SFL",          comp_category: "renewal_writing",         is_aipp_eligible: true,  is_scoreboard_eligible: false },
  { pattern: "SERVICING",                            comp_type: "SFL",          comp_category: "servicing",               is_aipp_eligible: true,  is_scoreboard_eligible: false },
  // Ambassador Travel BENEFITS (bare "AMBASSADOR TRAVEL -" — page 3)
  { pattern: "AMBASSADOR TRAVEL - HEALTH",           comp_type: "BENEFITS",     comp_category: "ambassador_travel_health",is_aipp_eligible: false, is_scoreboard_eligible: false },
  { pattern: "AMBASSADOR TRAVEL - LIFE",             comp_type: "BENEFITS",     comp_category: "ambassador_travel_life",  is_aipp_eligible: false, is_scoreboard_eligible: false },
  { pattern: "AMBASSADOR TRAVEL - AUTO",             comp_type: "BENEFITS",     comp_category: "ambassador_travel_auto",  is_aipp_eligible: false, is_scoreboard_eligible: false },
  { pattern: "AMBASSADOR TRAVEL - FIRE",             comp_type: "BENEFITS",     comp_category: "ambassador_travel_fire",  is_aipp_eligible: false, is_scoreboard_eligible: false },
  // MUTL (most generic AUTO patterns last)
  { pattern: "HEALTH NEW BUSINESS",                  comp_type: "MUTL",         comp_category: "new_business",            is_aipp_eligible: true,  is_scoreboard_eligible: true  },
  { pattern: "HEALTH RENEWAL SERVICE",               comp_type: "MUTL",         comp_category: "renewal_service",         is_aipp_eligible: true,  is_scoreboard_eligible: false },
  { pattern: "AUTO NEW BUSINESS",                    comp_type: "MUTL",         comp_category: "new_business",            is_aipp_eligible: true,  is_scoreboard_eligible: true  },
  { pattern: "AUTO NEW - AMD66",                     comp_type: "MUTL",         comp_category: "new_amd66",               is_aipp_eligible: true,  is_scoreboard_eligible: true  },
  { pattern: "AUTO RENEWAL SERVICE",                 comp_type: "MUTL",         comp_category: "renewal_service",         is_aipp_eligible: true,  is_scoreboard_eligible: false },
  { pattern: "AUTO RENEWAL - AMD66",                 comp_type: "MUTL",         comp_category: "renewal_amd66",           is_aipp_eligible: true,  is_scoreboard_eligible: false },
];


// applyDescRules — substring match against description (uppercased).
// Most-specific match wins (table is already ordered).
function applyDescRules(lineItems: any[]): any[] {
  return (lineItems || []).map((li) => {
    const descUpper = String(li?.description || "").toUpperCase().trim();
    for (const r of DESC_RULES) {
      if (descUpper.includes(r.pattern)) {
        return {
          ...li,
          comp_type: r.comp_type,
          comp_category: r.comp_category,
          is_aipp_eligible: r.is_aipp_eligible,
          is_scoreboard_eligible: r.is_scoreboard_eligible,
        };
      }
    }
    return li;
  });
}


// transformToIngestPayload — port of Python transform_to_ingest_payload.
// Drops agent_name/agent_code/territory/period_label and line_items[].section;
// renames totals.* → reconciliation.* ; line_items → lines.
function transformToIngestPayload(llmOut: any): any {
  const totals = llmOut?.totals || {};
  const items = Array.isArray(llmOut?.line_items) ? llmOut.line_items : [];
  const lines = items.map((li: any) => ({
    line_sequence: li?.line_sequence,
    comp_type: li?.comp_type,
    comp_category: li?.comp_category,
    description: li?.description,
    current_amount: Number(li?.current_amount ?? 0),
    ytd_amount: Number(li?.ytd_amount ?? 0),
    is_aipp_eligible: Boolean(li?.is_aipp_eligible),
    is_scoreboard_eligible: Boolean(li?.is_scoreboard_eligible),
  }));
  return {
    period_year: llmOut?.period_year,
    period_month: llmOut?.period_month,
    period_half: llmOut?.period_half,
    recap_date: llmOut?.recap_date,
    reconciliation: {
      half_month_total_pdf: totals?.half_month_total_pdf,
      ytd_total_pdf: totals?.ytd_total_pdf,
    },
    lines,
  };
}


// validateLLMOutput — minimal schema gate.  Returns error string OR null if OK.
function validateLLMOutput(out: any): string | null {
  if (!out || typeof out !== "object") return "not an object";
  if (typeof out.period_year !== "number") return "missing period_year (number)";
  if (typeof out.period_month !== "number") return "missing period_month (number)";
  if (out.period_half !== "first" && out.period_half !== "second") return "period_half must be 'first' or 'second'";
  if (!Array.isArray(out.line_items) || out.line_items.length === 0) return "missing/empty line_items";
  return null;
}


// fetchPdfBase64 — fetch a URL (typically the Composio s3url from
// GMAIL_GET_ATTACHMENT or a Drive download URL), return base64 string.
async function fetchPdfBase64(url: string, timeoutMs: number): Promise<string> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status} fetching PDF`);
    const buf = new Uint8Array(await res.arrayBuffer());
    // Convert to base64 chunked (avoid stack overflow on large buffers)
    const CHUNK = 0x8000;
    let bin = "";
    for (let i = 0; i < buf.length; i += CHUNK) {
      bin += String.fromCharCode(...buf.subarray(i, i + CHUNK));
    }
    return btoa(bin);
  } finally {
    clearTimeout(timer);
  }
}


// callComposioMultimodalLLM — variant of callComposioLLM that sends a
// content array with an image_url part holding the PDF as a data URI.
// IMPORTANT (Phase v2.1 open question): not every Groq model accepts PDF
// directly via image_url.  llama-4-scout DOES accept image content but
// expects image MIME (jpeg/png).  If model rejects, Phase v2.1 will swap
// to an OCR-then-text pathway.  This implementation is the structural
// landing target; the model swap is a 1-line input_config change.
async function callComposioMultimodalLLM(opts: {
  apiKey: string;
  userId: string;
  pdfBase64: string;
  prompt: string;
  model?: string;
  maxRetries?: number;
  timeoutMs?: number;
}): Promise<{ ok: boolean; data: any; error: string | null }> {
  const model = opts.model || LLM_MODEL_MULTIMODAL_DEFAULT;
  const retries = Math.max(1, Number(opts.maxRetries ?? 2));
  const timeoutMs = Number(opts.timeoutMs ?? 60_000);
  const body = {
    user_id: opts.userId,
    arguments: {
      model,
      messages: [{
        role: "user",
        content: [
          { type: "text", text: opts.prompt },
          { type: "image_url", image_url: { url: `data:application/pdf;base64,${opts.pdfBase64}` } },
        ],
      }],
      max_tokens: 8000,
      temperature: 0.1,
      response_format: { type: "json_object" },
    },
  };
  let lastErr = "unknown";
  for (let attempt = 0; attempt < retries; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(`${COMPOSIO_BASE}/${COMPOSIO_LLM_TOOL}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-api-key": opts.apiKey },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
      clearTimeout(timer);
      const text = await res.text();
      let parsed: any = {};
      try { parsed = JSON.parse(text); } catch { /* leave parsed empty */ }
      const choice = parsed?.data?.choices?.[0];
      const content = choice?.message?.content;
      if (!res.ok || !parsed?.successful || !content) {
        lastErr = parsed?.error?.message || parsed?.error || `HTTP ${res.status}`;
        await sleep(1500 * (attempt + 1));
        continue;
      }
      const cleaned = stripFences(content);
      let extracted: any;
      try { extracted = JSON.parse(cleaned); }
      catch (e) {
        lastErr = `JSON parse failed: ${e instanceof Error ? e.message : e}`;
        await sleep(1500 * (attempt + 1));
        continue;
      }
      return { ok: true, data: extracted, error: null };
    } catch (e) {
      clearTimeout(timer);
      lastErr = e instanceof Error ? e.message : String(e);
      await sleep(1500 * (attempt + 1));
    }
  }
  return { ok: false, data: null, error: lastErr };
}


// stageCParse — the Doc Processor v2 parse leg.  Idempotent: a re-run
// against a previously parsed doc calls mark_document_parsed again with
// the new outcome (sf_comp_recap_ingest is responsible for its own
// idempotency by source_document_id).
//
// Returns one of:
//   { status: 'success', records: N, error: null }
//   { status: 'parse_failed', records: 0, error: '...' }
//   { status: 'ingest_failed', records: 0, error: '...' }
//   { status: 'skipped', records: 0, error: null }
async function stageCParse(opts: {
  agencyId: string;
  documentId: string;
  pdfUrl: string;
  docType: string;
  composioApiKey: string;
  composioUserId: string;
  parseLLMModel?: string;
  parseTimeoutMs?: number;
  parseMaxRetries?: number;
}): Promise<{ status: string; records: number; error: string | null }> {
  // v2.0 ships sf_comp_recap.  Paychex / SF deduction land in v2.4.
  if (opts.docType !== "sf_comp_recap") {
    await sb.rpc("mark_document_parsed", {
      p_doc_id: opts.documentId, p_status: "skipped",
      p_records: 0, p_error: null, p_tables: null, p_response: null,
    });
    return { status: "skipped", records: 0, error: null };
  }

  // 1. Fetch PDF bytes
  let pdfBase64: string;
  try {
    pdfBase64 = await fetchPdfBase64(opts.pdfUrl, opts.parseTimeoutMs ?? 30_000);
  } catch (e) {
    const msg = `pdf_fetch: ${e instanceof Error ? e.message : e}`;
    await sb.rpc("mark_document_parsed", {
      p_doc_id: opts.documentId, p_status: "parse_failed",
      p_records: 0, p_error: msg, p_tables: null, p_response: null,
    });
    return { status: "parse_failed", records: 0, error: msg };
  }

  // 2. Call multimodal LLM
  const llmRes = await callComposioMultimodalLLM({
    apiKey: opts.composioApiKey,
    userId: opts.composioUserId,
    pdfBase64,
    prompt: PARSER_PROMPT,
    model: opts.parseLLMModel,
    maxRetries: opts.parseMaxRetries,
    timeoutMs: opts.parseTimeoutMs ?? 60_000,
  });
  if (!llmRes.ok || !llmRes.data) {
    const msg = `llm: ${llmRes.error}`;
    await sb.rpc("mark_document_parsed", {
      p_doc_id: opts.documentId, p_status: "parse_failed",
      p_records: 0, p_error: msg, p_tables: null, p_response: null,
    });
    return { status: "parse_failed", records: 0, error: msg };
  }

  // 3. Schema validation
  const schemaErr = validateLLMOutput(llmRes.data);
  if (schemaErr) {
    await sb.rpc("mark_document_parsed", {
      p_doc_id: opts.documentId, p_status: "parse_failed",
      p_records: 0, p_error: `schema: ${schemaErr}`, p_tables: null,
      p_response: llmRes.data,
    });
    return { status: "parse_failed", records: 0, error: `schema: ${schemaErr}` };
  }

  // 4. Apply DESC_RULES (deterministic post-process)
  const enriched = { ...llmRes.data, line_items: applyDescRules(llmRes.data.line_items) };

  // 5. Transform to ingest payload
  const payload = transformToIngestPayload(enriched);

  // 6. Call sf_comp_recap_ingest
  const { data: ingestResult, error: ingestErr } = await sb.rpc("sf_comp_recap_ingest", {
    p_agency_id: opts.agencyId,
    p_document_id: opts.documentId,
    p_payload: payload,
    p_force_replace: false,
  });
  if (ingestErr) {
    const msg = `ingest: ${ingestErr.message}`;
    await sb.rpc("mark_document_parsed", {
      p_doc_id: opts.documentId, p_status: "ingest_failed",
      p_records: 0, p_error: msg, p_tables: null,
      p_response: ingestResult ?? null,
    });
    return { status: "ingest_failed", records: 0, error: msg };
  }

  const records = Number(ingestResult?.records_created ?? payload.lines.length);
  await sb.rpc("mark_document_parsed", {
    p_doc_id: opts.documentId, p_status: "success",
    p_records: records, p_error: null, p_tables: ["comp_recap"],
    p_response: ingestResult ?? null,
  });
  return { status: "success", records, error: null };
}


// runDocumentProcessorBackfill — invoked via the backfill HTTP endpoint.
// Accepts a list of doc_ids; for each, downloads from Drive and runs
// stageCParse.  Capped at 10 (run_document_processor_backfill RPC enforces).
async function runDocumentProcessorBackfill(opts: {
  agencyId: string;
  docIds: string[];
  parseLLMModel?: string;
}): Promise<{ status: string; results: any[]; outputSummary: string }> {
  const composioApiKey = Deno.env.get("COMPOSIO_API_KEY") || await getSetting(opts.agencyId, "composio_api_key");
  if (!composioApiKey) throw new Error("Missing COMPOSIO_API_KEY");
  const composioUserId = await getSetting(opts.agencyId, "composio_user_id");
  if (!composioUserId) throw new Error("Missing composio_user_id");
  const driveAccountId    = await getComposioAccountId(opts.agencyId, "googledrive");
  const driveAuthConfigId = await getComposioAuthConfigId(opts.agencyId, "googledrive");

  // Get the plan
  const { data: plan, error: planErr } = await sb.rpc("run_document_processor_backfill", {
    p_agency: opts.agencyId, p_doc_ids: opts.docIds,
  });
  if (planErr) throw new Error(`backfill plan failed: ${planErr.message}`);
  const docs: any[] = Array.isArray(plan?.documents) ? plan.documents : [];

  const results: any[] = [];
  for (const d of docs) {
    if (!d.parser_eligible) {
      await sb.rpc("mark_document_parsed", {
        p_doc_id: d.document_id, p_status: "skipped",
        p_records: 0, p_error: `doc_type=${d.doc_type} not parser-eligible`,
        p_tables: null, p_response: null,
      });
      results.push({ document_id: d.document_id, ...{ status: "skipped", records: 0, error: null } });
      continue;
    }
    // Get a Drive download URL for the file
    let pdfUrl: string = d.drive_url;
    try {
      const dlRes = await callComposio({
        apiKey: composioApiKey, userId: composioUserId,
        connectedAccountId: driveAccountId, authConfigId: driveAuthConfigId,
        toolSlug: "GOOGLEDRIVE_DOWNLOAD_FILE",
        toolArguments: { file_id: d.drive_file_id },
      });
      if (dlRes.ok) {
        const fileBlock = dlRes.data?.file || dlRes.data || {};
        pdfUrl = fileBlock.s3url || fileBlock.url || pdfUrl;
      }
    } catch (_e) { /* fall back to drive_url */ }

    const r = await stageCParse({
      agencyId: opts.agencyId,
      documentId: d.document_id,
      pdfUrl,
      docType: d.doc_type,
      composioApiKey,
      composioUserId,
      parseLLMModel: opts.parseLLMModel,
    });
    results.push({ document_id: d.document_id, file_name: d.file_name, ...r });
  }
  const success = results.filter((r) => r.status === "success").length;
  const failed  = results.filter((r) => r.status === "parse_failed" || r.status === "ingest_failed").length;
  const skipped = results.filter((r) => r.status === "skipped").length;
  return {
    status: failed === 0 ? "success" : "partial",
    results,
    outputSummary: `${success} parsed, ${failed} failed, ${skipped} skipped (of ${results.length})`,
  };
}

async function runDocumentProcessorOrchestrator(recipe: any): Promise<{
  recordsProcessed: number; outputSummary: string;
}> {
  const agencyId = recipe.agency_id as string;
  const input = recipe.input_config || {};
  const lookbackMinutes = Number(input.lookback_minutes ?? 60);
  const maxBatch = Math.min(Number(input.max_batch ?? 10), 25);
  const processedLabelName = input.processed_label || "BCC-Processed";

  const composioApiKey = Deno.env.get("COMPOSIO_API_KEY") || await getSetting(agencyId, "composio_api_key");
  if (!composioApiKey) throw new Error("Missing Composio API key for document_processor_orchestrator");
  const composioUserId = await getSetting(agencyId, "composio_user_id");
  if (!composioUserId) throw new Error("Missing settings.composio_user_id for document_processor_orchestrator");
  const gmailAccountId    = await getComposioAccountId(agencyId, "gmail");
  const gmailAuthConfigId = await getComposioAuthConfigId(agencyId, "gmail");
  const driveAccountId    = await getComposioAccountId(agencyId, "googledrive");
  const driveAuthConfigId = await getComposioAuthConfigId(agencyId, "googledrive");

  // 1. Plan
  const { data: plan, error: planErr } = await sb.rpc("prepare_document_processor_batch", {
    p_agency_id: agencyId,
    p_lookback_minutes: lookbackMinutes,
    p_max_batch: maxBatch,
  });
  if (planErr) throw new Error(`prepare_document_processor_batch failed: ${planErr.message}`);
  if (!plan || typeof plan !== "object") throw new Error("prepare_document_processor_batch returned no plan");
  const gmailQuery: string = plan.gmail_query;
  const dedupSet: Set<string> = new Set(Array.isArray(plan.dedup_message_ids) ? plan.dedup_message_ids : []);

  // 2. Ensure the processed-marker label exists
  const processedLabelId = await ensureGmailLabelId({
    apiKey: composioApiKey, userId: composioUserId,
    accountId: gmailAccountId, authConfigId: gmailAuthConfigId,
    labelName: processedLabelName,
  });

  // 3. Fetch candidate messages
  const fetchRes = await callComposio({
    apiKey: composioApiKey, userId: composioUserId,
    connectedAccountId: gmailAccountId, authConfigId: gmailAuthConfigId,
    toolSlug: "GMAIL_FETCH_EMAILS",
    toolArguments: {
      query: gmailQuery,
      max_results: maxBatch,
      ids_only: true,
      verbose: false,
    },
  });
  if (!fetchRes.ok) throw new Error(`GMAIL_FETCH_EMAILS failed: ${fetchRes.error}`);
  const messages: any[] = (fetchRes.data?.messages) || (Array.isArray(fetchRes.data) ? fetchRes.data : []);
  const candidateIds: string[] = messages
    .map((m: any) => m?.messageId || m?.id)
    .filter((id: any) => typeof id === "string" && id.length > 0 && !dedupSet.has(id))
    .slice(0, maxBatch);

  if (candidateIds.length === 0) {
    return {
      recordsProcessed: 0,
      outputSummary: `No new docs to process (query='${gmailQuery}'; ${dedupSet.size} dedup'd; ${messages.length} returned)`,
    };
  }

  // 4. Per-message loop
  const processed: any[] = [];
  const skipped: { message_id: string; reason: string }[] = [];
  const errors: { message_id: string; error: string }[] = [];

  // Cache for resolved Drive folders by (docType, year)
  const driveFolderCache: Map<string, string> = new Map();
  const yearNow = new Date().getUTCFullYear().toString();

  async function getDriveFolder(docType: ClassifiedAttachment["docType"], yearOverride?: string): Promise<string> {
    const year = yearOverride || yearNow;
    const cacheKey = `${docType}|${year}`;
    if (driveFolderCache.has(cacheKey)) return driveFolderCache.get(cacheKey)!;
    const segments = driveFolderForDocType(docType, year);
    const folder = await findOrCreateDriveFolder({
      apiKey: composioApiKey, userId: composioUserId,
      accountId: driveAccountId, authConfigId: driveAuthConfigId,
      pathSegments: segments,
    });
    driveFolderCache.set(cacheKey, folder.folderId);
    return folder.folderId;
  }

  for (const msgId of candidateIds) {
    try {
      const msgRes = await callComposio({
        apiKey: composioApiKey, userId: composioUserId,
        connectedAccountId: gmailAccountId, authConfigId: gmailAuthConfigId,
        toolSlug: "GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID",
        toolArguments: { message_id: msgId, format: "full" },
      });
      if (!msgRes.ok) { errors.push({ message_id: msgId, error: `fetch_full: ${msgRes.error}` }); continue; }
      const msg: any = msgRes.data || {};

      // Extract subject + from headers
      let subject = msg.subject || "";
      let fromHdr = msg.from || "";
      if (Array.isArray(msg.payload?.headers)) {
        for (const h of msg.payload.headers) {
          const n = (h.name || "").toLowerCase();
          if (n === "subject" && !subject) subject = h.value || "";
          if (n === "from" && !fromHdr) fromHdr = h.value || "";
        }
      }

      // Walk attachments
      const attachments: { attachmentId: string; filename: string; mimeType: string }[] = [];
      const walk = (parts: any[]): void => {
        for (const p of parts || []) {
          if (p?.filename && p?.body?.attachmentId) {
            attachments.push({
              attachmentId: p.body.attachmentId,
              filename: p.filename,
              mimeType: p.mimeType || "application/octet-stream",
            });
          }
          if (Array.isArray(p?.parts)) walk(p.parts);
        }
      };
      walk(msg.payload?.parts || []);
      if (attachments.length === 0 && Array.isArray(msg.attachmentList)) {
        for (const a of msg.attachmentList) {
          if (a?.attachmentId && a?.filename) {
            attachments.push({
              attachmentId: a.attachmentId,
              filename: a.filename,
              mimeType: a.mimeType || "application/octet-stream",
            });
          }
        }
      }

      if (attachments.length === 0) {
        skipped.push({ message_id: msgId, reason: "no_attachments" });
        continue;
      }

      let filedAny = false;
      for (const att of attachments) {
        try {
          // Skip non-PDF/non-CSV/non-XLSX attachments (signatures, banner images, etc.)
          const fn = (att.filename || "").toLowerCase();
          const isFileable = att.mimeType === "application/pdf"
            || fn.endsWith(".pdf") || fn.endsWith(".csv") || fn.endsWith(".xlsx") || fn.endsWith(".xls");
          if (!isFileable) continue;

          const classified = classifyAttachment({
            from: fromHdr, subject, filename: att.filename, mimeType: att.mimeType,
          });

          // Resolve Drive folder for this docType + (year from periodHint if available, else current)
          let folderYear = yearNow;
          if (classified.periodHint) {
            const m = classified.periodHint.match(/^(20\d{2})/);
            if (m) folderYear = m[1];
          }
          const driveFolderId = await getDriveFolder(classified.docType, folderYear);

          // Download attachment from Gmail to Composio S3
          const getRes = await callComposio({
            apiKey: composioApiKey, userId: composioUserId,
            connectedAccountId: gmailAccountId, authConfigId: gmailAuthConfigId,
            toolSlug: "GMAIL_GET_ATTACHMENT",
            toolArguments: { message_id: msgId, attachment_id: att.attachmentId, file_name: att.filename },
          });
          if (!getRes.ok) {
            console.warn(`[doc_processor] GMAIL_GET_ATTACHMENT failed (${msgId}/${att.filename}): ${getRes.error}`);
            continue;
          }
          const file = getRes.data?.file || getRes.data || {};
          const s3url = file.s3url || file.url;
          if (!s3url) {
            console.warn(`[doc_processor] no s3url for ${msgId}/${att.filename}`);
            continue;
          }

          // Upload to Drive
          const uploadArgs: Record<string, any> = {
            source_url: s3url,
            name: att.filename,
            mime_type: file.mimetype || att.mimeType,
            parent_folder_id: driveFolderId,
          };
          const uploadRes = await callComposio({
            apiKey: composioApiKey, userId: composioUserId,
            connectedAccountId: driveAccountId, authConfigId: driveAuthConfigId,
            toolSlug: "GOOGLEDRIVE_UPLOAD_FROM_URL",
            toolArguments: uploadArgs,
          });
          if (!uploadRes.ok) {
            console.warn(`[doc_processor] GOOGLEDRIVE_UPLOAD_FROM_URL failed for ${att.filename}: ${uploadRes.error}`);
            continue;
          }
          const driveFile = uploadRes.data || {};
          const driveFileId: string | null = driveFile.id || driveFile.file_id || driveFile.fileId || null;
          if (!driveFileId) {
            console.warn(`[doc_processor] upload returned no id for ${att.filename}`);
            continue;
          }
          const driveUrl: string = driveFile.webViewLink || driveFile.url
            || `https://drive.google.com/file/d/${driveFileId}/view`;

          processed.push({
            message_id: msgId,
            subject,
            from: fromHdr,
            file_name: att.filename,
            file_type: file.mimetype || att.mimeType,
            drive_file_id: driveFileId,
            drive_url: driveUrl,
            doc_type: classified.docType,
            needs_ingest: classified.needsIngest,
            period_hint: classified.periodHint,
            // v7: capture the hot s3url so stageCParse can re-fetch the PDF
            // bytes after log_document_processor_result has inserted the
            // documents row (and we therefore have a doc_id to pass to
            // sf_comp_recap_ingest).  s3url stays valid for ~10 minutes.
            _v7_s3url: s3url,
          });
          filedAny = true;
        } catch (attErr) {
          console.warn(`[doc_processor] attachment crash (${msgId}/${att.filename}): ${attErr instanceof Error ? attErr.message : attErr}`);
        }
      }

      if (!filedAny) {
        skipped.push({ message_id: msgId, reason: "no_fileable_attachments" });
        continue;
      }

      // Apply the processed-marker label (dedup signal for next run, also lets
      // Email Archiver skip these via "-label:BCC-Processed" — wait, that
      // exclusion is in prepare_document_processor_batch's query, not the
      // Email Archiver's. The label is purely a hint for human + dedup).
      const labelRes = await callComposio({
        apiKey: composioApiKey, userId: composioUserId,
        connectedAccountId: gmailAccountId, authConfigId: gmailAuthConfigId,
        toolSlug: "GMAIL_ADD_LABEL_TO_EMAIL",
        toolArguments: {
          message_id: msgId,
          add_label_ids: [processedLabelId],
        },
      });
      if (!labelRes.ok) {
        // Label failure is non-fatal — file already in Drive + documents row will be inserted
        console.warn(`[doc_processor] label add failed for ${msgId}: ${labelRes.error}`);
      }
    } catch (loopErr) {
      errors.push({ message_id: msgId, error: `loop_crash: ${loopErr instanceof Error ? loopErr.message : loopErr}` });
    }
  }

  // 5. Callback to result_rpc — v1 stage A+B done point.
  const { data: logResult, error: logErr } = await sb.rpc("log_document_processor_result", {
    p_agency_id: agencyId,
    p_recipe_id: recipe.id,
    p_result: { processed, skipped, errors },
  });
  if (logErr) throw new Error(`log_document_processor_result failed: ${logErr.message}`);

  if (skipped.length > 0) {
    console.warn(`[doc_processor] skipped detail (first 10): ${JSON.stringify(skipped.slice(0, 10))}`);
  }
  if (errors.length > 0) {
    console.warn(`[doc_processor] error detail (first 10): ${JSON.stringify(errors.slice(0, 10))}`);
  }

  // 6. v7: STAGE C — PARSE + INGEST (gated by input.groq_parse_enabled).
  // The v1 logic above runs every cron tick.  Stage C only fires when the
  // recipe's input_config has groq_parse_enabled === true.  Phase v2.0
  // ships with the flag OFF — zero behavior change.
  let parseSummary = "";
  if (input.groq_parse_enabled === true && processed.length > 0) {
    // Eligible items: those with doc_type === 'sf_comp_recap' (v2.0 scope).
    const eligible = processed.filter((p: any) => p.doc_type === "sf_comp_recap" && p._v7_s3url);
    if (eligible.length > 0) {
      // Look up the just-inserted doc_ids by drive_file_id.
      const driveFileIds = eligible.map((p: any) => p.drive_file_id).filter(Boolean);
      const { data: docRows, error: docLookupErr } = await sb
        .from("documents")
        .select("id, drive_file_id")
        .eq("agency_id", agencyId)
        .in("drive_file_id", driveFileIds);
      if (docLookupErr) {
        console.warn(`[doc_processor v7] doc_id lookup failed: ${docLookupErr.message}`);
      } else {
        const idByDriveFile: Record<string, string> = {};
        for (const r of (docRows || [])) {
          if (r.drive_file_id) idByDriveFile[r.drive_file_id] = r.id;
        }
        const parseResults: any[] = [];
        const parseLLMModel = input.parse_llm_model || LLM_MODEL_MULTIMODAL_DEFAULT;
        const parseTimeoutMs = Number(input.parse_timeout_ms ?? 60_000);
        const parseMaxRetries = Number(input.parse_max_retries ?? 2);
        for (const p of eligible) {
          const docId = idByDriveFile[p.drive_file_id];
          if (!docId) {
            parseResults.push({ file_name: p.file_name, status: "skipped", error: "doc_id not found" });
            continue;
          }
          try {
            const r = await stageCParse({
              agencyId,
              documentId: docId,
              pdfUrl: p._v7_s3url,
              docType: p.doc_type,
              composioApiKey: composioApiKey!,
              composioUserId: composioUserId!,
              parseLLMModel,
              parseTimeoutMs,
              parseMaxRetries,
            });
            parseResults.push({ file_name: p.file_name, document_id: docId, ...r });
          } catch (parseErr) {
            const msg = parseErr instanceof Error ? parseErr.message : String(parseErr);
            console.warn(`[doc_processor v7] stageCParse crash for ${p.file_name}: ${msg}`);
            parseResults.push({ file_name: p.file_name, status: "parse_failed", error: `crash: ${msg}` });
          }
        }
        const ok = parseResults.filter((r) => r.status === "success").length;
        const failed = parseResults.filter((r) => r.status === "parse_failed" || r.status === "ingest_failed").length;
        parseSummary = `; parse: ${ok} ok, ${failed} failed (of ${parseResults.length})`;
        console.log(`[doc_processor v7] stage C: ${JSON.stringify(parseResults).slice(0, 800)}`);
      }
    }
  }

  const fallback = `${processed.length} attachments filed; ${skipped.length} messages skipped; ${errors.length} errors; ${dedupSet.size} dedup'd${parseSummary}`;
  const outputSummary = ((logResult?.output_summary as string) || fallback) + parseSummary;
  return { recordsProcessed: processed.length, outputSummary };
}


// =========================================================================
// v8 — Social Scheduler v2 orchestrators
// =========================================================================
// Shared dispatch that routes by recipe.input_config.platform:
//   facebook  -> FACEBOOK_POST_TO_PAGE  (auto-post)
//   linkedin  -> LINKEDIN_CREATE_POST   (auto-post)
//   instagram -> GMAIL_SEND_EMAIL       (reminder email, manual post)
//
// Each path uses payload_rpc to fetch the plan (migration 029's
// prepare_*_post_batch), iterates the items, posts/reminds, and calls
// result_rpc (log_social_post_result) with per-item outcomes.
//
// AA05 belt-and-suspenders: the SQL prepare_* RPCs filter via
// has_aa05_prohibited_terms(); this TS pre-flight catches anything that
// slipped through (extended pattern list).

// AA05 prohibited token list — keep tight to avoid false positives.
// Source: agent system prompt § "Word Rules".
const AA05_PROHIBITED_TERMS: string[] = [
  "client", "clients",
  "solutions",
  "expert ", " expert", "experts ", " experts",
  "specialist",
  "advisor", "consultant",
  "transfers welcome",
  "financial freedom",
  "wealth accumulation",
  "world-class", "world class",
  "first-class", "first class",
  "cheap", "affordable", "low cost",
  "guarantee", "guaranteed",
  "#1", "greatest",
];

function checkAA05Compliance(text: string): { ok: boolean; reason: string | null } {
  if (!text || text.length === 0) return { ok: true, reason: null };
  const lower = text.toLowerCase();
  for (const term of AA05_PROHIBITED_TERMS) {
    if (lower.includes(term)) return { ok: false, reason: `aa05_prohibited_term: '${term.trim()}'` };
  }
  return { ok: true, reason: null };
}


async function runSocialScheduler(recipe: any): Promise<{ recordsProcessed: number; outputSummary: string }> {
  const agencyId = recipe.agency_id as string;
  const input = recipe.input_config || {};
  const platform: string = String(input.platform || "").toLowerCase();
  const payloadRpc: string = input.payload_rpc;
  const resultRpc:  string = input.result_rpc || "log_social_post_result";

  if (!["facebook", "linkedin", "instagram"].includes(platform)) {
    throw new Error(`runSocialScheduler: unknown platform '${platform}'`);
  }
  if (!payloadRpc) {
    throw new Error(`runSocialScheduler: recipe ${recipe.id} missing input_config.payload_rpc`);
  }

  const composioApiKey = Deno.env.get("COMPOSIO_API_KEY") || await getSetting(agencyId, "composio_api_key");
  if (!composioApiKey) throw new Error("Missing Composio API key for social scheduler");
  const composioUserId = await getSetting(agencyId, "composio_user_id");
  if (!composioUserId) throw new Error("Missing settings.composio_user_id for social scheduler");

  // 1. Get the plan
  const tz = (await getSetting(agencyId, "agency_timezone")) || "America/New_York";
  const { data: plan, error: planErr } = await sb.rpc(payloadRpc, {
    p_agency_id: agencyId, p_tz: tz,
  });
  if (planErr) throw new Error(`${payloadRpc} failed: ${planErr.message}`);
  if (!plan || typeof plan !== "object") throw new Error(`${payloadRpc} returned no plan`);
  const items: any[] = Array.isArray(plan.items) ? plan.items : [];
  const skipped: any[] = Array.isArray(plan.skipped) ? plan.skipped : [];

  if (items.length === 0 && skipped.length === 0) {
    return { recordsProcessed: 0, outputSummary: `No due ${platform} items` };
  }

  // 2. Resolve Composio connection details for the platform
  let postAccountId: string | null = null;
  let postAuthConfigId: string | null = null;
  let pageId: string | null = null;
  if (platform === "facebook") {
    postAccountId    = await getComposioAccountId(agencyId, "facebook");
    postAuthConfigId = await getComposioAuthConfigId(agencyId, "facebook");
    pageId           = await getSetting(agencyId, "facebook_page_id");
  } else if (platform === "linkedin") {
    postAccountId    = await getComposioAccountId(agencyId, "linkedin");
    postAuthConfigId = await getComposioAuthConfigId(agencyId, "linkedin");
  }

  // 3. Process each item
  const results: any[] = [];
  for (const item of items) {
    try {
      // TS pre-flight AA05 (defensive — SQL belt should have caught these)
      const compliance = checkAA05Compliance(String(item.caption || ""));
      if (!compliance.ok) {
        // Record as a skip rather than a failure
        skipped.push({ id: item.id, reason: compliance.reason });
        continue;
      }

      if (platform === "facebook") {
        const postRes = await postToFacebook({
          apiKey: composioApiKey, userId: composioUserId,
          accountId: postAccountId, authConfigId: postAuthConfigId,
          pageId, caption: item.caption, hashtags: item.hashtags || [],
          mediaUrl: item.media_url,
        });
        if (postRes.ok) {
          results.push({ id: item.id, status: "posted", post_url: postRes.postUrl, platform });
        } else {
          results.push({ id: item.id, status: "failed", error: postRes.error, platform });
        }

      } else if (platform === "linkedin") {
        const postRes = await postToLinkedIn({
          apiKey: composioApiKey, userId: composioUserId,
          accountId: postAccountId, authConfigId: postAuthConfigId,
          caption: item.caption, hashtags: item.hashtags || [],
          mediaUrl: item.media_url,
        });
        if (postRes.ok) {
          results.push({ id: item.id, status: "posted", post_url: postRes.postUrl, platform });
        } else {
          results.push({ id: item.id, status: "failed", error: postRes.error, platform });
        }

      } else if (platform === "instagram") {
        // Manual-posting flow: send an email reminder.  Instagram has no
        // server-side API for posting from third-party agents.
        const reminderEmail: string = input.reminder_email
          || (await getSetting(agencyId, "owner_email"))
          || "kwametyler.businessclaude@gmail.com";
        const sendRes = await sendInstagramReminderEmail({
          apiKey: composioApiKey, userId: composioUserId, agencyId,
          to: reminderEmail, item,
        });
        if (sendRes.ok) {
          results.push({ id: item.id, status: "reminded", reminder_sent: true, platform });
        } else {
          results.push({ id: item.id, status: "failed", error: sendRes.error, platform });
        }
      }
    } catch (itemErr) {
      const msg = itemErr instanceof Error ? itemErr.message : String(itemErr);
      results.push({ id: item.id, status: "failed", error: `crash: ${msg}`, platform });
    }
  }

  // 4. Callback to result_rpc
  const { data: logResult, error: logErr } = await sb.rpc(resultRpc, {
    p_agency_id: agencyId,
    p_recipe_id: recipe.id,
    p_result: { results, skipped },
  });
  if (logErr) throw new Error(`${resultRpc} failed: ${logErr.message}`);

  const fallback = `${platform}: ${results.length} processed, ${skipped.length} skipped`;
  const outputSummary = (logResult?.output_summary as string) || fallback;
  return { recordsProcessed: results.length, outputSummary };
}


async function postToFacebook(opts: {
  apiKey: string; userId: string; accountId: string | null; authConfigId: string | null;
  pageId: string | null; caption: string; hashtags: string[]; mediaUrl: string | null;
}): Promise<{ ok: boolean; postUrl: string | null; error: string | null }> {
  // Caption strategy: caption + " " + hashtags joined.
  // FB best practice is 3-5 hashtags max (per agent system prompt).
  const hashtagsText = (opts.hashtags || []).slice(0, 5).map((h) => h.startsWith("#") ? h : `#${h}`).join(" ");
  const finalCaption = hashtagsText
    ? `${opts.caption}\n\n${hashtagsText}`
    : opts.caption;
  const toolArgs: Record<string, any> = {
    message: finalCaption,
  };
  if (opts.pageId) toolArgs.page_id = opts.pageId;
  if (opts.mediaUrl) {
    toolArgs.link = opts.mediaUrl;
    toolArgs.image_url = opts.mediaUrl;
  }
  const res = await callComposio({
    apiKey: opts.apiKey, userId: opts.userId,
    connectedAccountId: opts.accountId, authConfigId: opts.authConfigId,
    toolSlug: "FACEBOOK_POST_TO_PAGE",
    toolArguments: toolArgs,
  });
  if (!res.ok) return { ok: false, postUrl: null, error: res.error };
  const d = res.data || {};
  const postId: string | null = d.id || d.post_id || d.postId || null;
  const postUrl: string | null = d.permalink_url || d.post_url
    || (postId ? `https://facebook.com/${postId}` : null);
  return { ok: true, postUrl, error: null };
}


async function postToLinkedIn(opts: {
  apiKey: string; userId: string; accountId: string | null; authConfigId: string | null;
  caption: string; hashtags: string[]; mediaUrl: string | null;
}): Promise<{ ok: boolean; postUrl: string | null; error: string | null }> {
  // LinkedIn best practice (per agent system prompt): 3-5 professional
  // hashtags, embedded in text.  Text-only posts get maximum reach;
  // links go in the first comment, not the post body — but for the
  // automated path we put media inline.
  const hashtagsText = (opts.hashtags || []).slice(0, 5).map((h) => h.startsWith("#") ? h : `#${h}`).join(" ");
  const text = hashtagsText
    ? `${opts.caption}\n\n${hashtagsText}`
    : opts.caption;
  const toolArgs: Record<string, any> = { text };
  if (opts.mediaUrl) toolArgs.media_url = opts.mediaUrl;
  const res = await callComposio({
    apiKey: opts.apiKey, userId: opts.userId,
    connectedAccountId: opts.accountId, authConfigId: opts.authConfigId,
    toolSlug: "LINKEDIN_CREATE_POST",
    toolArguments: toolArgs,
  });
  if (!res.ok) return { ok: false, postUrl: null, error: res.error };
  const d = res.data || {};
  const postUrn: string | null = d.id || d.urn || d.post_id || null;
  const postUrl: string | null = d.url || d.share_url
    || (postUrn ? `https://www.linkedin.com/feed/update/${postUrn}` : null);
  return { ok: true, postUrl, error: null };
}


async function sendInstagramReminderEmail(opts: {
  apiKey: string; userId: string; agencyId: string; to: string; item: any;
}): Promise<{ ok: boolean; error: string | null }> {
  const gmailAccountId    = await getComposioAccountId(opts.agencyId, "gmail").catch(() => null);
  const gmailAuthConfigId = await getComposioAuthConfigId(opts.agencyId, "gmail").catch(() => null);
  const item = opts.item || {};
  const hashtagsArr: string[] = Array.isArray(item.hashtags) ? item.hashtags : [];
  const hashtagsText = hashtagsArr.length > 0
    ? hashtagsArr.slice(0, 25).map((h: string) => h.startsWith("#") ? h : `#${h}`).join(" ")
    : "(no hashtags set)";
  const subject = `[BCC] Instagram post reminder — ${item.scheduled_date || "today"}`;
  const body = [
    "Your Instagram post is ready to post manually.",
    "",
    "(Instagram doesn't allow API auto-posting — only reminders.)",
    "",
    "---",
    "",
    "CAPTION:",
    String(item.caption || "(no caption)"),
    "",
    "HASHTAGS (paste into the first comment, not the caption):",
    hashtagsText,
    "",
    `MEDIA URL: ${item.media_url || "(none — upload manually)"}`,
    `SCHEDULED:  ${item.scheduled_date || "?"} ${item.scheduled_time || ""}`,
    "",
    `content_calendar id: ${item.id}`,
    "",
    "After posting, mark the item 'posted' in BCC Social Media module.",
  ].join("\n");

  const res = await callComposio({
    apiKey: opts.apiKey, userId: opts.userId,
    connectedAccountId: gmailAccountId, authConfigId: gmailAuthConfigId,
    toolSlug: "GMAIL_SEND_EMAIL",
    toolArguments: {
      recipient_email: opts.to,
      subject,
      body,
    },
  });
  if (!res.ok) return { ok: false, error: res.error };
  return { ok: true, error: null };
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return jsonResponse({ error: "Method not allowed. Use POST." }, 405);

  let body: any = {};
  try { const text = await req.text(); body = text ? JSON.parse(text) : {}; }
  catch { return jsonResponse({ error: "Invalid JSON body" }, 400); }

  // ----- v7 BACKFILL ENDPOINT -----
  // POST { agency_id, shared_secret, backfill_doc_ids: [...], parse_llm_model? }
  // Runs stageCParse against an explicit list of already-filed documents
  // (downloads from Drive instead of Gmail).  Capped at 10 by the
  // run_document_processor_backfill RPC.
  if (Array.isArray(body.backfill_doc_ids) && body.backfill_doc_ids.length > 0) {
    const agencyId: string | undefined = body.agency_id;
    if (!agencyId) return jsonResponse({ error: "Missing agency_id for backfill" }, 400);
    if (typeof body.shared_secret !== "string" || body.shared_secret.length === 0)
      return jsonResponse({ error: "Missing shared_secret for backfill" }, 401);
    let expectedSecret: string | null;
    try { expectedSecret = await getSetting(agencyId, "automation_runner_cron_secret"); }
    catch (err) { return jsonResponse({ error: `Auth lookup failed: ${err instanceof Error ? err.message : String(err)}` }, 500); }
    if (!expectedSecret) return jsonResponse({ error: `Server missing automation_runner_cron_secret for agency ${agencyId}` }, 500);
    if (body.shared_secret !== expectedSecret) return jsonResponse({ error: "Unauthorized: invalid shared_secret" }, 401);
    try {
      const result = await runDocumentProcessorBackfill({
        agencyId,
        docIds: body.backfill_doc_ids,
        parseLLMModel: body.parse_llm_model,
      });
      const status = result.status === "success" ? 200 : 207;
      return jsonResponse({ ok: result.status === "success", ...result }, status);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return jsonResponse({ ok: false, error: msg }, 500);
    }
  }

  // ----- v1 RECIPE EXECUTION PATH (unchanged) -----
  const recipeId: string | undefined = body.recipe_id;
  const triggeredBy: string = body.triggered_by || "manual";
  if (!recipeId) return jsonResponse({ error: "Missing recipe_id in body" }, 400);
  if (typeof body.shared_secret !== "string" || body.shared_secret.length === 0)
    return jsonResponse({ error: "Missing shared_secret in body" }, 401);

  const { data: recipe, error: recipeErr } = await sb.from("automation_recipes").select("*").eq("id", recipeId).maybeSingle();
  if (recipeErr || !recipe) return jsonResponse({ error: `Recipe ${recipeId} not found: ${recipeErr?.message || "no row"}` }, 404);
  if (!recipe.agency_id) return jsonResponse({ error: `Recipe ${recipeId} has no agency_id set.` }, 500);

  let expectedSecret: string | null;
  try { expectedSecret = await getSetting(recipe.agency_id, "automation_runner_cron_secret"); }
  catch (err) { return jsonResponse({ error: `Auth lookup failed: ${err instanceof Error ? err.message : String(err)}` }, 500); }
  if (!expectedSecret) return jsonResponse({ error: `Server missing settings.automation_runner_cron_secret for agency ${recipe.agency_id}` }, 500);
  if (body.shared_secret !== expectedSecret) return jsonResponse({ error: "Unauthorized: invalid shared_secret" }, 401);

  try {
    const result = await executeRecipe(recipe, triggeredBy);
    const status = result.status === "success" ? 200 : 500;
    return jsonResponse({ ok: result.status === "success", ...result }, status);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await telegram(recipe.agency_id, `🛑 <b>automation-runner CRASHED</b>\n${msg.slice(0, 300)}`);
    return jsonResponse({ ok: false, error: msg }, 500);
  }
});
