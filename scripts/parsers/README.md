# `scripts/parsers/` — manual backstop parsers

Per-document parsers, designed to be invoked manually from a Composio sandbox
session by the BCC Claude agent. They are the **stop-gap** between the now-shipped
SQL ingest contracts (e.g. `sf_comp_recap_ingest`) and the not-yet-built live
Document Processor recipe orchestrator.

## Contents

| File | Purpose | Calls | Status |
| --- | --- | --- | --- |
| `sf_comp_recap.py` | State Farm Agency Compensation Recap PDF → `comp_recap` rows | `sf_comp_recap_ingest` (migration 023) | Proven (2025 backfill, 24 PDFs, penny-perfect) |

## Why these exist (read first)

The BCC has three ingest layers:

1. **Layer 1 — SQL ingest contract.** A `*_ingest` Postgres function that
   validates a structured payload, writes domain rows, reconciles against
   PDF totals, and returns a structured result. This layer is the **persistent
   API**. Other layers can come and go but the SQL contract stays stable.
2. **Layer 2 — Parser.** Takes a PDF, OCRs it, classifies line items via LLM +
   deterministic rules, builds the payload shape that Layer 1 expects. This
   layer lives in *this directory*.
3. **Layer 3 — Live orchestrator.** A Composio recipe (Gmail polling →
   classification → routing) that calls Layers 1 + 2 automatically. **NOT YET
   BUILT.** Tracked as a task targeted for the sprint after May 2026 SF Comp
   Recap is ingested.

Until Layer 3 ships, Layer 2 must be invoked **manually** by Claude when a
qualifying document arrives in Gmail.

## Manual invocation (Claude runbook)

When a new SF Compensation Recap PDF arrives in
`kwametyler.businessclaude@gmail.com`:

### 1. Spin up a Composio remote sandbox session

You already have one if you're working through the BCC. The sandbox provides
the `smart_file_extract`, `invoke_llm`, and `run_composio_tool` helpers used
by the parser.

### 2. Download the PDF from Gmail and INSERT a `documents` row first

```python
# Step 2a: fetch the message + attachment from Gmail
result, err = run_composio_tool("GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID", {
    "message_id": "<the message id>",
    "format": "full",
})
# walk result["data"]["payload"]["parts"] to find the PDF attachment_id

result, err = run_composio_tool("GMAIL_GET_ATTACHMENT", {
    "message_id": "<msg_id>",
    "attachment_id": "<att_id>",
    "file_name": "kwame-tyler-comp-recap-2026-05-31.pdf",
})
pdf_path = result["data"]["file"]["s3url_or_local_path"]  # adjust per Composio
```

Insert a `documents` row via Supabase MCP so the parser can stamp it after
ingest. Capture `document_id`.

### 3. Run the parser in dry-run mode first

```python
from scripts.parsers.sf_comp_recap import parse_and_ingest

# Build a Supabase RPC shim. The parser only calls one RPC:
#   sf_comp_recap_ingest(p_agency_id, p_document_id, p_payload, p_force_replace)
# Wrap your Supabase MCP execute_sql to dispatch RPC-style.
def supabase_rpc(name: str, args: dict) -> dict:
    # Use Supabase MCP execute_sql to call public.<name>(...) with named args
    # Return the jsonb result. Implementation depends on which Supabase MCP
    # variant you have loaded.
    ...

dry = parse_and_ingest(
    pdf_path=pdf_path,
    agency_id="98aa8b9b-92e4-4ebc-8727-aa00ce696fab",
    document_id=document_id,
    sandbox_helpers={"smart_file_extract": smart_file_extract,
                     "invoke_llm": invoke_llm},
    supabase_rpc=supabase_rpc,
    dry_run=True,
)
```

Review `dry["payload"]` — confirm the period is right, the line count is
sensible (21-30 typical), and the totals match what the PDF says. Look at
`dry["llm_output_summary"]["totals"]` against what you can read on the PDF
GROSS COMPENSATION line.

### 4. Watch for DESC_RULES no-match warnings

If `apply_desc_rules` printed any `DESC_RULES no-match for N lines` warnings:

1. **Don't ignore them.** A new SF line description means a year-over-year
   evolution. Open `docs/SF_COMP_RECAP_PARSER.md`, find the "Year-over-year
   evolutions" section, and follow the pattern there:
   - Add the new pattern to `DESC_RULES` in `sf_comp_recap.py` (most-specific
     first, before the generic family pattern).
   - Update the `PARSER_PROMPT` RULES section if a new content rule is needed.
   - Append a bullet to `docs/SF_COMP_RECAP_PARSER.md` § "Year-over-year
     evolutions" with the recap_date that first surfaced the pattern.
2. Re-run the dry-run.

### 5. Commit ingest

```python
result = parse_and_ingest(
    pdf_path=pdf_path,
    agency_id="98aa8b9b-92e4-4ebc-8727-aa00ce696fab",
    document_id=document_id,
    sandbox_helpers={"smart_file_extract": smart_file_extract,
                     "invoke_llm": invoke_llm},
    supabase_rpc=supabase_rpc,
    dry_run=False,
)

assert result["status"] == "ok", result
recon = result["reconciliation"]
assert recon["half_month_ok"] is True, recon
assert recon["ytd_ok"] is True, recon
print(f"✓ Penny-perfect ingest. Half-month delta ${recon['half_month_delta']:.2f}, "
      f"YTD delta ${recon['ytd_delta']:.2f}.")
```

A `status == "ok"` with both `half_month_ok` and `ytd_ok` True means the PDF
ingested cleanly. The `sf_comp_recap_ingest` SQL function also stamps the
`documents` row with `processing_status='processed'` and full reconciliation
detail in `documents.notes`.

If `status == "reconciliation_failed"`, the deltas are out of tolerance
($0.10). Investigate per the playbook in `docs/SF_COMP_RECAP_PARSER.md`.

### 6. Log the action

After a successful ingest, record what you did in `persistent_memory` under
category `session_note` so the next Claude session sees the ingest in the
chronological log.

## Adding a new parser

Pattern for a new document type (e.g. SF Deduction Statement, Payroll Report):

1. Ship the SQL ingest function as a migration (Layer 1). Naming:
   `<NNN>_<doc_type>_ingest_function.sql`. Validate payload, idempotent on a
   natural key, reconcile against source-of-truth totals if applicable, stamp
   `documents`, return structured jsonb.
2. Document the parser design in `docs/<DOC_TYPE>_PARSER.md`. Include the
   PARSER_PROMPT (the LLM prompt) and any deterministic post-processing
   tables.
3. Add `scripts/parsers/<doc_type>.py` (Layer 2). Follow the structure of
   `sf_comp_recap.py`: PROMPT constant, RULES table, `apply_*_rules`,
   `transform_to_ingest_payload`, `parse_and_ingest`, `_self_test`.
4. Update this README's contents table.
5. Add a task for the eventual Layer 3 orchestrator build.

## Future: removing this directory

When the Document Processor live recipe (Layer 3) ships and is verified
end-to-end against at least one production document of each supported type,
the manual invocation path becomes redundant. At that point the parser
modules can either:

- Stay as-is and be imported by the runner (TypeScript would call into them
  via a Composio sandbox tool), or
- Be ported to TypeScript / Deno so the Edge Function runs them directly.

The decision depends on whether the Edge Function gains a robust Python-call
escape hatch. Either way, this directory is the **persistent record** of the
proven parsing logic. Don't delete it before Layer 3 is fully verified.
