# Doc Processor v2.2 — Parse Leg Build Spec

**Status:** Design locked 2026-06-18 ~01:10 UTC by Claude. Implementation pending Edge Function code session.
**Supersedes:** docs/DOC_PROCESSOR_V2_1_REBUILD.md (which becomes context-only; this is the buildable spec).
**Owner task:** e55d92f8 (Build Document Processor live orchestrator).

---

## Where v2 stands today

| Layer | Status | Reference |
|---|---|---|
| v2.0 detect+file+alert orchestrator | LIVE | Edge Function v7, recipe 98d091d4 is_active=true |
| v2.1 SQL helper RPCs | LIVE | migration 028 (`mark_document_parsed`, `run_document_processor_backfill`, extended `log_document_processor_result`) |
| v2.1 reconciliation: BENEFITS-aware | LIVE | migration 031 (`sf_comp_recap_ingest` accepts optional `total_with_benefits_*_pdf` fields) |
| v2.2 parse leg in Edge Function | **PENDING** | this spec |
| v2.2 DESC_RULES TS manifest | **PENDING** | this spec |
| v2.3 activation: flip `groq_parse_enabled=true` | gated on v2.2 dry-run pass | recipe input_config |
| v2.4 backfill of pending_parse docs | currently 0 such docs — likely no-op | n/a |

## Architecture: Path A locked

Edge Function `automation-runner` adds a new function `stageCParseDocument(doc, recipe)` that:

1. **Downloads PDF** via `GOOGLEDRIVE_DOWNLOAD_FILE` using doc.drive_file_id.
2. **OCRs to text** by POSTing to `COMPOSIO_REMOTE_WORKBENCH` with embedded Python that runs `smart_file_extract` on the downloaded file. Sandbox cold-start adds ~10-20s; acceptable for 30-min cron.
3. **Parses to structured line items** by calling `COMPOSIO_SEARCH_GROQ_CHAT` with model `llama-3.3-70b-versatile` and the canonical `PARSER_PROMPT` from `docs/SF_COMP_RECAP_PARSER.md`. Content is a STRING (no multimodal — that path is dead per the 2026-06-17 finding).
4. **Applies fix_one_number_lines()** safety net to the LLM output (see below).
5. **Drops aggregate rows** via the AGGREGATE_PREFIXES filter.
6. **Applies DESC_RULES** to clean comp_type/comp_category/is_aipp/is_scoreboard per row.
7. **Captures BOTH PDF totals** for benefits-aware reconciliation:
   - `gross_compensation_ytd_pdf` (page 2 line)
   - `total_with_benefits_ytd_pdf` (page 2 + sum of page-3 BENEFITS lines)
8. **Calls `sf_comp_recap_ingest`** with the structured payload.
9. **Calls `mark_document_parsed`** with the result.

Gated behind `input_config.groq_parse_enabled` flag. Currently `false`; flip to `true` is v2.3.

## fix_one_number_lines() — TypeScript port

The OCR sometimes collapses current+ytd columns into a single number. This safety net re-parses the OCR text and corrects.

```ts
const NUM_PAT = /-?\d{1,3}(?:,\d{3})*(?:\.\d{1,2})?-?/g;

function parseAmount(s: string): number {
  // strip commas, handle trailing minus
  const trailing = s.endsWith('-');
  const cleaned = s.replace(/,/g, '').replace(/-$/, '');
  const n = parseFloat(cleaned);
  return trailing ? -n : n;
}

function fixOneNumberLines(items: LineItem[], ocrText: string): LineItem[] {
  const ocrLines = ocrText.split(/\r?\n/);
  return items.map(item => {
    const target = item.description.toUpperCase();
    const matchLine = ocrLines.find(l => l.toUpperCase().includes(target));
    if (!matchLine) return item;
    const matches = matchLine.match(NUM_PAT) || [];
    const nums = matches.map(parseAmount).filter(n => !Number.isNaN(n));
    if (nums.length === 1) return { ...item, current_amount: 0, ytd_amount: nums[0] };
    if (nums.length >= 2) return { ...item, current_amount: nums[0], ytd_amount: nums[1] };
    return item;
  });
}
```

## Aggregate-line filter

```ts
const AGGREGATE_PREFIXES = [
  "TOTAL ", "GROSS COMPENSATION", "ADJUSTED GROSS", "LESS DEDUCTIONS",
  "NET PAYABLE", "PER SCHEDULES OF PAYMENT", "PAYABLE PER AGREEMENT",
  "YOUR CHECK FOR", "REQUESTED 100%", "TOTAL FEDERAL", "TOTAL REPORTABLE",
];

items = items.filter(i => !AGGREGATE_PREFIXES.some(p =>
  i.description.toUpperCase().startsWith(p)
));
```

## DESC_RULES TS manifest

Generate `supabase/functions/_shared/desc_rules.json` from `scripts/parsers/sf_comp_recap.py` via a one-shot export script `scripts/export_desc_rules.py`. The JSON is ordered most-specific-first; each rule has:

```json
{
  "pattern": "FIRE NEW - AMD66",
  "match_type": "exact" | "contains",
  "comp_type": "FIRE",
  "comp_category": "new_amd66",
  "is_aipp_eligible": true,
  "is_scoreboard_eligible": false
}
```

Edge Function loads this once at module init. `applyDescRules(items)` walks the rules in order and assigns the first match to each item.

## Payload schema (new fields highlighted)

```ts
type IngestPayload = {
  period_year: number;
  period_month: number;
  period_half: "first" | "second";
  recap_date: string;          // YYYY-MM-DD
  reconciliation: {
    half_month_total_pdf: number;            // page-2 GROSS COMPENSATION half
    ytd_total_pdf: number;                   // page-2 GROSS COMPENSATION ytd
    total_with_benefits_half_pdf?: number;   // ★ NEW — page-2 half + page-3 benefits half
    total_with_benefits_ytd_pdf?: number;    // ★ NEW — page-2 ytd + page-3 benefits ytd
  };
  lines: Array<{
    line_sequence: number;
    comp_type: string | null;
    comp_category: string | null;
    description: string;
    current_amount: number;
    ytd_amount: number;
    is_aipp_eligible: boolean;
    is_scoreboard_eligible: boolean;
  }>;
};
```

When both `total_with_benefits_*` fields are present, `sf_comp_recap_ingest` reconciles against the inclusive total (migration 031). When absent, falls back to legacy gross-only reconciliation for backward compatibility with historical re-parses.

## Activation sequence (v2.3)

1. Pick one well-known test PDF (suggest: May 15 2026 recap, drive_file_id `1qGmqDVot_ClbhoTDmoHqr7BS2w_Z2YQy`).
2. With `groq_parse_enabled=false`, manually invoke `stageCParseDocument` via SQL once (passing a known doc_id). Confirm the function call succeeds, comp_recap gets the same row count as before (60 for May 15), reconciliation status = OK.
3. Run on May 31 2026 recap separately as a second smoke test.
4. Flip `input_config.groq_parse_enabled = true` for the live recipe.
5. Watch automation_run_log for 14 days — clean post-flip = v2.3 closed.

## Backfill (v2.4)

`run_document_processor_backfill(p_agency, p_doc_ids)` exists and is ready. Currently 0 documents in `processing_status='pending_parse'` so this is effectively a no-op for Tyler Insurance install. Pattern remains canonical for fresh BCC installs that import a backlog before activation.

## What this spec does NOT do

- Does not deploy the Edge Function code (requires Composio `SUPABASE_DEPLOY_FUNCTION` from a session with Edge-Function-deploy scope).
- Does not flip `groq_parse_enabled=true` (that is v2.3).
- Does not parse historical PDFs in `documents` — those are already-loaded via manual backstop.

## Open items at time of writing

- May 15 2026 dry-run fixture: drive_file_id `1qGmqDVot_ClbhoTDmoHqr7BS2w_Z2YQy`. Expected output: 31 line_items → after AGGREGATE filter ~29-30 → 60 comp_recap rows. Recon against `total_with_benefits_ytd_pdf` should be $0.00.
- Empirical BENEFITS magnitude on Tyler\'s book: ~$5,240 YTD by May; ~$435/period running rate.
- automation-runner Edge Function is at v7 as of 2026-06-17 23:00 UTC. v2.2 implementation increments to v8.

---

## Build checklist for the v2.2 implementation session

1. Pull current `supabase/functions/automation-runner/index.ts` (currently v7).
2. Add `fixOneNumberLines`, `dropAggregateLines`, `applyDescRules`, `transformToIngestPayload` helper functions (port from the proven Python parser).
3. Generate `supabase/functions/_shared/desc_rules.json` via new `scripts/export_desc_rules.py`.
4. Add `stageCParseDocument(doc, recipe)` to the orchestrator, gated on `recipe.input_config.groq_parse_enabled`.
5. Wire it into the per-document loop in `runDocumentProcessorOrchestrator()`.
6. Add the `sf_comp_recap_ingest` call.
7. Add the `mark_document_parsed` call.
8. Test against May 15 2026 fixture (one manual invocation).
9. Deploy via Composio `SUPABASE_DEPLOY_FUNCTION`. IMMEDIATELY follow with `SUPABASE_UPDATE_A_FUNCTION` to restore `verify_jwt=false` (per operational_rules: deploy resets this to default true).
10. Commit the index.ts + desc_rules.json + export script in a single commit.
11. Update task e55d92f8 with v2.2 SHIPPED block.

This spec is the canonical buildable blueprint. Next Claude reading the agency brain: start at the build checklist.
