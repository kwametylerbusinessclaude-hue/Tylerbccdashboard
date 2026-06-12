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
// 2026-06-12 REFACTOR — Resilient Composio auth resolution
// =========================================================================
// Composio v3 tools/execute accepts three auth-scoping patterns:
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
// Settings lookups (all OPTIONAL — only required: composio_user_id):
//   composio_<conn>_account_id      (legacy override, NOT recommended)
//   composio_<conn>_auth_config_id  (preferred when explicit scoping is wanted)
// =========================================================================
//
// CREDENTIALS:
//   Edge Function Secrets (preferred, encrypted, shared across agencies):
//     COMPOSIO_API_KEY               - Composio API key
//   Per-agency settings table rows (overrides + per-agency identifiers):
//     automation_runner_cron_secret  - random secret, also referenced by mig 011
//     composio_api_key               - OPTIONAL per-agency override of env var
//     composio_user_id               - Composio user ID for this agency (REQUIRED)
//     composio_<conn>_auth_config_id - OPTIONAL stable integration scope
//     composio_<conn>_account_id     - OPTIONAL legacy explicit override
//     telegram_bot_token             - OPTIONAL; failure alerts only
//     telegram_chat_id               - OPTIONAL; failure alerts only
//
// AUTH:
//   verify_jwt = false
//   POST body must contain shared_secret matching the agency's
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
  return s.trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "")
    .trim();
}

async function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function getSetting(agencyId: string, key: string): Promise<string | null> {
  const { data, error } = await sb
    .from("settings")
    .select("setting_value")
    .eq("agency_id", agencyId)
    .eq("setting_key", key)
    .maybeSingle();
  if (error) {
    throw new Error(`settings read failed for agency ${agencyId} key ${key}: ${error.message}`);
  }
  return data?.setting_value ?? null;
}

async function telegram(agencyId: string | null, text: string): Promise<void> {
  if (!agencyId) return;
  const botToken = await getSetting(agencyId, "telegram_bot_token");
  const chatId = await getSetting(agencyId, "telegram_chat_id");
  if (!botToken || !chatId) return;
  try {
    await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: "HTML",
        disable_web_page_preview: true,
      }),
    });
  } catch (_e) { /* Telegram failures are non-fatal */ }
}

function jsonResponse(body: any, status = 200): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

async function callComposio(opts: {
  apiKey: string;
  userId: string;
  connectedAccountId?: string | null;
  authConfigId?: string | null;
  toolSlug: string;
  toolArguments: Record<string, any>;
}): Promise<{ ok: boolean; data: any; error: string | null; httpStatus: number }> {
  // Build auth-scoping body. Precedence: ca_* (explicit) > ac_* (stable) > user-only.
  const body: Record<string, any> = {
    user_id: opts.userId,
    arguments: opts.toolArguments,
  };
  if (opts.connectedAccountId) {
    body.connected_account_id = opts.connectedAccountId;
  } else if (opts.authConfigId) {
    body.auth_config_id = opts.authConfigId;
  }

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
  const error = ok
    ? null
    : (parsed?.error?.message || parsed?.error || text.slice(0, 400));
  return { ok, data, error, httpStatus: res.status };
}

async function callComposioLLM(opts: {
  composioApiKey: string;
  composioUserId: string;
  systemPrompt: string;
  userContent: string;
  model?: string;
  maxTokens?: number;
}): Promise<{ ok: boolean; data: any; error: string | null }> {
  const body = {
    user_id: opts.composioUserId,
    arguments: {
      messages: [
        {
          role: "system",
          content: opts.systemPrompt +
            "\n\nReturn ONLY a raw JSON object. No markdown. No code fences. No prose before or after the JSON.",
        },
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
      headers: {
        "x-api-key": opts.composioApiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    if ((res.status === 429 || res.status >= 500) && attempt < 2) {
      await sleep(500 * Math.pow(2, attempt));
      continue;
    }
    const text = await res.text();
    let parsed: any = {};
    try { parsed = JSON.parse(text); } catch { parsed = { raw: text }; }
    if (!res.ok) {
      lastErr = parsed?.error?.message || parsed?.error || text.slice(0, 400);
      return { ok: false, data: null, error: lastErr };
    }
    if (!parsed?.successful) {
      lastErr = parsed?.error || "Composio LLM call unsuccessful";
      return { ok: false, data: null, error: lastErr };
    }
    const choice = parsed?.data?.choices?.[0];
    const content = choice?.message?.content;
    if (!content) {
      return { ok: false, data: null, error: "Composio LLM returned empty content" };
    }
    if (choice?.finish_reason === "length") {
      console.warn("[callComposioLLM] finish_reason=length — output may be truncated");
    }
    const cleaned = stripFences(content);
    let extracted: any;
    try { extracted = JSON.parse(cleaned); }
    catch (e) {
      return {
        ok: false,
        data: null,
        error: `LLM response was not valid JSON after fence-stripping: ${(e as Error).message}`,
      };
    }
    return { ok: true, data: extracted, error: null };
  }
  return { ok: false, data: null, error: `LLM call exhausted retries: ${lastErr}` };
}

// Returns the legacy connected_account_id override if explicitly set. null otherwise.
async function getComposioAccountId(agencyId: string, connection: string): Promise<string | null> {
  const key = `composio_${connection.toLowerCase()}_account_id`;
  return await getSetting(agencyId, key);
}

// Returns the stable auth_config_id (ac_*) for a toolkit. null if not set.
async function getComposioAuthConfigId(agencyId: string, connection: string): Promise<string | null> {
  const key = `composio_${connection.toLowerCase()}_auth_config_id`;
  return await getSetting(agencyId, key);
}

async function writeOutput(opts: {
  outputTable: string;
  outputConfig: any;
  records: any[];
  agencyId: string | null;
}): Promise<{ inserted: number; updated: number }> {
  if (!Array.isArray(opts.records) || opts.records.length === 0) {
    return { inserted: 0, updated: 0 };
  }

  const records = opts.agencyId
    ? opts.records.map((r) => ({ agency_id: opts.agencyId, ...r }))
    : opts.records;

  const uniqueOn: string[] | undefined = opts.outputConfig?.unique_on;
  const onConflict: string = opts.outputConfig?.on_conflict || "ignore";

  if (uniqueOn && uniqueOn.length > 0 && onConflict === "update") {
    const { data, error } = await sb
      .from(opts.outputTable)
      .upsert(records, { onConflict: uniqueOn.join(","), ignoreDuplicates: false })
      .select("id");
    if (error) throw new Error(`upsert to ${opts.outputTable} failed: ${error.message}`);
    return { inserted: data?.length ?? 0, updated: 0 };
  }

  if (uniqueOn && uniqueOn.length > 0) {
    const { data, error } = await sb
      .from(opts.outputTable)
      .upsert(records, { onConflict: uniqueOn.join(","), ignoreDuplicates: true })
      .select("id");
    if (error) throw new Error(`insert to ${opts.outputTable} failed: ${error.message}`);
    return { inserted: data?.length ?? 0, updated: 0 };
  }

  const { data, error } = await sb
    .from(opts.outputTable)
    .insert(records)
    .select("id");
  if (error) throw new Error(`insert to ${opts.outputTable} failed: ${error.message}`);
  return { inserted: data?.length ?? 0, updated: 0 };
}

async function executeRecipe(
  recipe: any,
  triggeredBy: string,
): Promise<any> {
  const started = Date.now();
  const recipeId = recipe.id as string;
  const agencyId = recipe.agency_id as string;

  await sb
    .from("automation_recipes")
    .update({ last_run_at: new Date().toISOString(), last_run_status: "running" })
    .eq("id", recipeId);

  let runStatus = "success";
  let errorMessage: string | null = null;
  let recordsProcessed = 0;
  let outputSummary = "";

  try {
    if (recipe.composio_action === "INTERNAL") {
      const { data: internalResult, error: internalErr } = await sb.rpc(
        "run_internal_recipe",
        { p_recipe_id: recipeId },
      );
      if (internalErr) {
        throw new Error(`run_internal_recipe failed: ${internalErr.message}`);
      }
      recordsProcessed = (internalResult?.records_processed as number) ?? 0;
      outputSummary = (internalResult?.output_summary as string) ??
        `INTERNAL recipe completed (no summary returned)`;

      const durationSec = Math.round((Date.now() - started) / 1000);
      await sb.from("automation_run_log").insert({
        agency_id: agencyId,
        recipe_id: recipeId,
        status: "success",
        records_processed: recordsProcessed,
        error_message: null,
        duration_seconds: durationSec,
        output_summary: outputSummary,
      });
      await sb
        .from("automation_recipes")
        .update({ last_run_status: "success" })
        .eq("id", recipeId);

      return {
        recipe_id: recipeId,
        recipe_name: recipe.recipe_name,
        status: "success",
        records_processed: recordsProcessed,
        duration_seconds: durationSec,
        triggered_by: triggeredBy,
        error: null,
      };
    }

    // --- Resolve credentials ---
    // Prefer COMPOSIO_API_KEY Edge Function env var (shared infrastructure secret).
    // Fall back to per-agency settings.composio_api_key for legacy/multi-tenant overrides.
    const composioApiKey = Deno.env.get("COMPOSIO_API_KEY")
      || await getSetting(agencyId, "composio_api_key");
    if (!composioApiKey) {
      throw new Error(
        `Missing Composio API key. Set COMPOSIO_API_KEY in Edge Function Secrets `
        + `(Supabase Dashboard -> Edge Functions -> Secrets) or insert a `
        + `settings.composio_api_key row for agency ${agencyId}.`
      );
    }
    const composioUserId = await getSetting(agencyId, "composio_user_id");
    if (!composioUserId) {
      throw new Error(`Missing settings credential: composio_user_id (agency ${agencyId})`);
    }

    // Resolve auth scoping (BOTH OPTIONAL). If neither is set, Composio
    // auto-resolves the active connection from the user_id + the toolkit
    // inferred from the tool slug. Recipe.composio_connection is now optional.
    const connection = recipe.composio_connection;
    let accountId: string | null = null;
    let authConfigId: string | null = null;
    if (connection) {
      accountId = await getComposioAccountId(agencyId, connection);
      authConfigId = await getComposioAuthConfigId(agencyId, connection);
    }

    const action = recipe.composio_action;
    if (!action) {
      throw new Error(`Recipe ${recipe.recipe_name} has no composio_action set.`);
    }

    const inputConfig = recipe.input_config || {};
    const composioResult = await callComposio({
      apiKey: composioApiKey,
      userId: composioUserId,
      connectedAccountId: accountId,
      authConfigId: authConfigId,
      toolSlug: action,
      toolArguments: inputConfig,
    });

    if (!composioResult.ok) {
      throw new Error(`Composio ${action} failed: ${composioResult.error}`);
    }

    let parsedRecords: any[] = [];

    if (recipe.groq_prompt && recipe.output_table) {
      const inputForLLM = JSON.stringify(composioResult.data).slice(0, 60000);
      const llmResult = await callComposioLLM({
        composioApiKey,
        composioUserId,
        systemPrompt: recipe.groq_prompt +
          '\n\nReturn a JSON object: {"records": [...]} where records is an array of objects ready to insert into the output_table. Return {"records": []} if nothing applicable.',
        userContent: inputForLLM,
      });
      if (!llmResult.ok) {
        throw new Error(`LLM parsing failed: ${llmResult.error}`);
      }
      parsedRecords = Array.isArray(llmResult.data?.records) ? llmResult.data.records : [];
    } else if (recipe.output_table && Array.isArray(composioResult.data)) {
      parsedRecords = composioResult.data;
    }

    if (recipe.output_table && parsedRecords.length > 0) {
      const writeResult = await writeOutput({
        outputTable: recipe.output_table,
        outputConfig: recipe.output_config || {},
        records: parsedRecords,
        agencyId: agencyId,
      });
      recordsProcessed = writeResult.inserted + writeResult.updated;
      outputSummary = `${recordsProcessed} records written to ${recipe.output_table}`;
    } else if (recipe.output_table) {
      outputSummary = `0 records — Composio returned data but LLM parsing yielded no records to write`;
    } else {
      outputSummary = `Action ${action} executed successfully (no output_table)`;
      recordsProcessed = 1;
    }
  } catch (err) {
    runStatus = "failed";
    errorMessage = err instanceof Error ? err.message : String(err);
    outputSummary = `Failed: ${errorMessage.slice(0, 200)}`;
    await telegram(
      agencyId,
      `🛑 <b>Automation FAILED</b>\n\nRecipe: <b>${recipe.recipe_name}</b>\nError: ${errorMessage.slice(0, 400)}`,
    );
  }

  const durationSec = Math.round((Date.now() - started) / 1000);

  await sb.from("automation_run_log").insert({
    agency_id: agencyId,
    recipe_id: recipeId,
    status: runStatus,
    records_processed: recordsProcessed,
    error_message: errorMessage,
    duration_seconds: durationSec,
    output_summary: outputSummary,
  });

  await sb
    .from("automation_recipes")
    .update({ last_run_status: runStatus })
    .eq("id", recipeId);

  return {
    recipe_id: recipeId,
    recipe_name: recipe.recipe_name,
    status: runStatus,
    records_processed: recordsProcessed,
    duration_seconds: durationSec,
    triggered_by: triggeredBy,
    error: errorMessage,
  };
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") {
    return jsonResponse({ error: "Method not allowed. Use POST." }, 405);
  }

  let body: any = {};
  try {
    const text = await req.text();
    body = text ? JSON.parse(text) : {};
  } catch {
    return jsonResponse({ error: "Invalid JSON body" }, 400);
  }

  const recipeId: string | undefined = body.recipe_id;
  const triggeredBy: string = body.triggered_by || "manual";

  if (!recipeId) {
    return jsonResponse({ error: "Missing recipe_id in body" }, 400);
  }
  if (typeof body.shared_secret !== "string" || body.shared_secret.length === 0) {
    return jsonResponse({ error: "Missing shared_secret in body" }, 401);
  }

  const { data: recipe, error: recipeErr } = await sb
    .from("automation_recipes")
    .select("*")
    .eq("id", recipeId)
    .maybeSingle();

  if (recipeErr || !recipe) {
    return jsonResponse(
      { error: `Recipe ${recipeId} not found: ${recipeErr?.message || "no row"}` },
      404,
    );
  }

  if (!recipe.agency_id) {
    return jsonResponse(
      {
        error:
          `Recipe ${recipeId} has no agency_id set.`,
      },
      500,
    );
  }

  let expectedSecret: string | null;
  try {
    expectedSecret = await getSetting(recipe.agency_id, "automation_runner_cron_secret");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return jsonResponse({ error: `Auth lookup failed: ${msg}` }, 500);
  }
  if (!expectedSecret) {
    return jsonResponse(
      {
        error:
          `Server missing settings.automation_runner_cron_secret for agency ${recipe.agency_id}`,
      },
      500,
    );
  }
  if (body.shared_secret !== expectedSecret) {
    return jsonResponse({ error: "Unauthorized: invalid shared_secret" }, 401);
  }

  try {
    const result = await executeRecipe(recipe, triggeredBy);
    const status = result.status === "success" ? 200 : 500;
    return jsonResponse({ ok: result.status === "success", ...result }, status);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await telegram(
      recipe.agency_id,
      `🛑 <b>automation-runner CRASHED</b>\n${msg.slice(0, 300)}`,
    );
    return jsonResponse({ ok: false, error: msg }, 500);
  }
});
