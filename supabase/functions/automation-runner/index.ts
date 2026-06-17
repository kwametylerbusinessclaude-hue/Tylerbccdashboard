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
// 2026-06-17 REFACTOR v6 — Document Processor orchestrator
// =========================================================================
// Added runDocumentProcessorOrchestrator(). Polls Gmail for SF + Paychex
// PDFs, classifies by filename/subject regex, files each to the appropriate
// Drive folder, inserts a documents row, and (for Comp Recap / Payroll /
// Deduction Stmt) fires an alert flagging the doc for downstream ingestion.
//
// v6 SCOPE — DETECT + FILE + ALERT:
// The orchestrator does NOT yet run the LLM-driven parse for SF Comp Recap.
// That stays as the manual backstop (scripts/parsers/sf_comp_recap.py) until
// a multimodal LLM tool slug is confirmed in Composio (task e55d92f8 step 1).
// v7 will add the in-Edge-Function parse leg and wire sf_comp_recap_ingest.
//
// Registered orchestrators after this commit:
//   email_archiver_orchestrator    -> runEmailArchiverOrchestrator()
//   document_processor_orchestrator -> runDocumentProcessorOrchestrator()
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
    if (recipe.composio_action === "INTERNAL" && recipe.internal_handler !== "email_archiver_orchestrator" && recipe.internal_handler !== "document_processor_orchestrator") {
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

  // 5. Callback to result_rpc
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

  const fallback = `${processed.length} attachments filed; ${skipped.length} messages skipped; ${errors.length} errors; ${dedupSet.size} dedup'd`;
  const outputSummary = (logResult?.output_summary as string) || fallback;
  return { recordsProcessed: processed.length, outputSummary };
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return jsonResponse({ error: "Method not allowed. Use POST." }, 405);

  let body: any = {};
  try { const text = await req.text(); body = text ? JSON.parse(text) : {}; }
  catch { return jsonResponse({ error: "Invalid JSON body" }, 400); }

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
