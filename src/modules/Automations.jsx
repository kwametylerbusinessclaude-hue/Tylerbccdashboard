import { useState, useMemo, useEffect, useRef } from "react";
import { supabase, AGENCY_ID } from "../lib/supabase.js";
import { useSupabaseTable } from "../lib/hooks.js";
import EmptyState from "../components/EmptyState.jsx";

// ============================================================
// BCC AUTOMATIONS MODULE v1.0
// Business Command Center — State Farm Agent Edition
// Built by Imaginary Farms LLC · imaginary-farms.com
//
// SECTIONS:
//   1. Overview      — Status summary, health indicators
//   2. Run Log       — Every automation execution with status
//   3. Recipes       — All configured automations, enable/disable
//   4. Connections   — Composio connected account health
//   5. Daily Briefing — Briefing history and content preview
//   6. Doc Importer  — Document processing history and status
//
// ARCHITECTURE:
//   Recipes defined in: automation_recipes table (Supabase)
//   Cron triggers:      Supabase scheduled functions
//   Execution:          Composio (connected accounts)
//   Processing:         Composio-hosted LLM (free, no separate API key needed)
//   Run results:        automation_run_log table (Supabase)
//   This UI reads both tables to display status and history
//
// DATA: Replace MOCK_DATA with Supabase queries in production
// ============================================================


// ─── Design Tokens ────────────────────────────────────────────
const T = {
  navy:    "#1B2B4B",
  blue:    "#2D7DD2",
  blueLt:  "#EFF6FF",
  green:   "#10B981",
  greenLt: "#D1FAE5",
  amber:   "#F59E0B",
  amberLt: "#FEF3C7",
  red:     "#EF4444",
  redLt:   "#FEE2E2",
  purple:  "#7C3AED",
  purpleLt:"#EDE9FE",
  teal:    "#0D9488",
  tealLt:  "#CCFBF1",
  slate50: "#F8FAFC",
  slate100:"#F1F5F9",
  slate200:"#E2E8F0",
  slate300:"#CBD5E1",
  slate400:"#94A3B8",
  slate500:"#64748B",
  slate600:"#475569",
  slate700:"#334155",
  slate800:"#1E293B",
  slate900:"#0F172A",
  white:   "#FFFFFF",
};

// ─── Connector Reference Data ────────────────────────────────
// Platform metadata for the Connections tab. Each entry pairs a Composio
// connector key (matches automation_recipes.composio_connection and the
// settings.composio_<key>_auth_config_id row) with the display label and icon.
// Live connection status is derived in the main component from settings rows
// + recent automation_run_log signals.
const CONNECTOR_DEFS = [
  { key:"gmail",          platform:"Gmail",            icon:"📧" },
  { key:"googledrive",    platform:"Google Drive",     icon:"📁" },
  { key:"googlecalendar", platform:"Google Calendar",  icon:"📅" },
  { key:"googledocs",     platform:"Google Docs",      icon:"📄" },
  { key:"googlesheets",   platform:"Google Sheets",    icon:"📊" },
  { key:"github",         platform:"GitHub",           icon:"🐙" },
  { key:"supabase",       platform:"Supabase",         icon:"🗄️" },
  { key:"facebook",       platform:"Facebook",         icon:"👥" },
  { key:"linkedin",       platform:"LinkedIn",         icon:"💼" },
  { key:"instagram",      platform:"Instagram",        icon:"📸", manual:true },
];

// ─── Live-data helpers ────────────────────────────────────────
// Format an absolute timestamp (ISO or Date) as a human-relative label
// ("Today 7:14 AM" / "Yesterday 6:01 AM" / "Mon Jun 16 2:30 PM").
const fmtRelative = (ts) => {
  if (!ts) return "—";
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return "—";
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  const yest = new Date(now); yest.setDate(now.getDate()-1);
  const isYest = d.toDateString() === yest.toDateString();
  const time = d.toLocaleTimeString([], { hour:"numeric", minute:"2-digit" });
  if (sameDay) return `Today ${time}`;
  if (isYest)  return `Yesterday ${time}`;
  return `${d.toLocaleDateString([], { weekday:"short", month:"short", day:"numeric" })} ${time}`;
};

// Format a briefing_date (YYYY-MM-DD) as "Jun 18, 2026".
const fmtBriefingDate = (s) => {
  if (!s) return "—";
  const d = new Date(s + "T00:00:00");
  if (Number.isNaN(d.getTime())) return s;
  return d.toLocaleDateString([], { month:"short", day:"numeric", year:"numeric" });
};

// Map documents.processing_type → DocImporter bucket (used by typeLabel/typeColor).
// Unmapped types fall through to the generic "tax_document" bucket so they still render.
const mapDocType = (pt) => {
  if (!pt) return "tax_document";
  if (pt.startsWith("sf_comp_recap"))                return "comp_recap";
  if (pt.startsWith("payroll"))                      return "payroll_export";
  if (pt.startsWith("bank_statement"))               return "bank_statement";
  if (pt.startsWith("resume"))                       return "resume";
  if (pt.startsWith("annual_1099"))                  return "tax_document";
  if (pt.startsWith("cpa_"))                         return "tax_document";
  if (pt.startsWith("permanent_record"))             return "tax_document";
  return "tax_document";
};

// Map documents.processing_status → DocImporter StatusPill status.
const mapDocStatus = (s) => {
  if (!s) return "warning";
  if (s === "processed" || s === "complete") return "success";
  if (s === "partial" || s === "awaiting_je_post" || s === "inventoried") return "partial";
  if (s === "failed" || s === "error") return "error";
  return "warning";
};

// Strip HTML to give DocImporter a readable source label when nothing else fits.
const stripHtml = (s) => String(s || "").replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();

// ─── Shared Components ────────────────────────────────────────
const Card = ({ children, style={} }) => (
  <div style={{ background:T.white, border:`1px solid ${T.slate200}`, borderRadius:12, padding:"16px 18px", ...style }}>
    {children}
  </div>
);

const StatusPill = ({ status }) => {
  const map = {
    success: { bg:T.greenLt,  color:"#065F46", label:"Success" },
    failed:  { bg:T.redLt,    color:"#991B1B", label:"Failed"  },
    partial: { bg:T.amberLt,  color:"#92400E", label:"Partial" },
    healthy: { bg:T.greenLt,  color:"#065F46", label:"Healthy" },
    error:   { bg:T.redLt,    color:"#991B1B", label:"Error"   },
    manual:  { bg:T.purpleLt, color:"#5B21B6", label:"Manual"  },
    complete:{ bg:T.greenLt,  color:"#065F46", label:"Complete"},
    pending: { bg:T.blueLt,   color:"#1E40AF", label:"Pending" },
  };
  const s = map[status] || { bg:T.slate100, color:T.slate500, label:status };
  return <span style={{ fontSize:10, fontWeight:600, padding:"3px 8px", borderRadius:20, background:s.bg, color:s.color, whiteSpace:"nowrap" }}>{s.label}</span>;
};

const CategoryBadge = ({ category }) => {
  const map = {
    communication:{ color:T.blue,   bg:T.blueLt,   label:"Communication" },
    email:        { color:T.teal,   bg:T.tealLt,   label:"Email"         },
    documents:    { color:T.amber,  bg:T.amberLt,  label:"Documents"     },
    social:       { color:T.purple, bg:T.purpleLt, label:"Social Media"  },
    hr:           { color:T.green,  bg:T.greenLt,  label:"HR"            },
    compliance:   { color:T.red,    bg:T.redLt,    label:"Compliance"    },
  };
  const s = map[category] || { color:T.slate500, bg:T.slate100, label:category };
  return <span style={{ fontSize:10, fontWeight:600, padding:"2px 8px", borderRadius:20, background:s.bg, color:s.color }}>{s.label}</span>;
};

const AskBtn = ({ context, size = "normal", demoMode = false }) => {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const [opened, setOpened] = useState(false);
  const ref = useRef(null);
  const small = size === "small";
  useEffect(() => {
    if (!open) return;
    const h = (e) => { if (ref.current && !ref.current.contains(e.target)) { setOpen(false); setTimeout(() => { setCopied(false); setOpened(false); }, 200); } };
    const k = (e) => { if (e.key === "Escape") { setOpen(false); setTimeout(() => { setCopied(false); setOpened(false); }, 200); } };
    document.addEventListener("mousedown", h); document.addEventListener("keydown", k);
    return () => { document.removeEventListener("mousedown", h); document.removeEventListener("keydown", k); };
  }, [open]);
  const ask = async () => {
    setOpen(true); setOpened(false);
    try { await navigator.clipboard.writeText(context); setCopied(true); } catch { setCopied(true); }
  };
  const go = () => { setOpened(true); if (!demoMode) window.open("https://claude.ai/new", "_blank", "noopener,noreferrer"); };
  const preview = context && context.length > 220 ? context.slice(0, 220).trimEnd() + "\u2026" : context;
  return (
    <div ref={ref} style={{ position: "relative", display: "inline-block" }}>
      <button
        onClick={open ? () => { setOpen(false); setTimeout(() => { setCopied(false); setOpened(false); }, 200); } : ask}
        style={{ display: "flex", alignItems: "center", gap: 5, background: open ? T.slate100 : T.blue, color: open ? T.blue : T.white, border: open ? `1px solid ${T.blue}` : "1px solid transparent", borderRadius: 7, padding: small ? "5px 10px" : "7px 13px", fontSize: small ? 10 : 11, fontWeight: 600, cursor: "pointer", whiteSpace: "nowrap", flexShrink: 0 }}
      >⚡ Ask Claude</button>
      {open && (
        <div role="dialog" aria-label="Ask Claude" style={{ position: "absolute", top: "calc(100% + 8px)", right: 0, zIndex: 60, width: 300, background: T.white, border: `1px solid ${T.slate100}`, borderRadius: 12, boxShadow: "0 12px 32px rgba(15,23,42,0.16)", padding: 14, textAlign: "left" }}>
          <div style={{ fontSize: 12, fontWeight: 600, color: "#16A34A", marginBottom: 4 }}>
            {copied ? "\u2713 Context copied to your clipboard" : "Copying\u2026"}
          </div>
          <div style={{ fontSize: 11, color: T.slate500, marginBottom: 8, lineHeight: 1.5 }}>
            This is what Claude will see — your data from this screen.
          </div>
          <div style={{ fontSize: 11, lineHeight: 1.55, color: T.slate500, background: T.slate100, borderRadius: 8, padding: 9, maxHeight: 92, overflow: "hidden", whiteSpace: "pre-wrap" }}>{preview}</div>
          <div style={{ marginTop: 10 }}>
            {!opened ? (
              <button onClick={go} style={{ width: "100%", background: T.blue, color: T.white, border: "none", borderRadius: 8, padding: "8px 12px", fontSize: 12, fontWeight: 600, cursor: "pointer" }}>
                Open Claude.ai &amp; paste
              </button>
            ) : demoMode ? (
              <div style={{ background: "#FFFBEB", border: "1px solid #D9770633", borderRadius: 8, padding: "8px 11px", fontSize: 11, lineHeight: 1.55, color: "#D97706" }}>
                <strong>Demo mode.</strong> On a real BCC this opens the agent's own Claude.ai, ready to paste.
              </div>
            ) : (
              <div style={{ background: "#ECFDF3", border: "1px solid #16A34A33", borderRadius: 8, padding: "8px 11px", fontSize: 11, lineHeight: 1.55, color: "#16A34A" }}>
                ✓ Claude.ai opened in a new tab — paste with Ctrl/⌘+V.
              </div>
            )}
          </div>
          <div style={{ marginTop: 9, fontSize: 10, color: T.slate400, lineHeight: 1.5 }}>
            Opens <em>your</em> Claude account — your subscription, your Project.
          </div>
        </div>
      )}
    </div>
  );
};

// ─── Section: Overview ────────────────────────────────────────
const AutomationOverview = ({ recipes, runLog, connections }) => {
  const active    = recipes.filter(r => r.is_active).length;

  // KPIs reflect the last 24h, not all-time. Historical pre-2026-06-13 failures
  // (Composio auth refactor era) should not light up the dashboard today.
  const cutoff24h = Date.now() - 24 * 60 * 60 * 1000;
  const recent24h = (runLog || []).filter(r => {
    const t = r.run_at ? new Date(r.run_at).getTime() : NaN;
    return Number.isFinite(t) && t >= cutoff24h;
  });
  const failed    = recent24h.filter(r => r.status === "failed").length;
  const partial   = recent24h.filter(r => r.status === "partial").length;
  const connError = connections.filter(c => c.status === "error").length;
  const failedRecipeNames = Array.from(new Set(
    recent24h.filter(r => r.status === "failed").map(r => r.recipe_name).filter(Boolean)
  ));

  const recentRuns = runLog.slice(0, 8);

  return (
    <div>
      {/* KPI Row */}
      <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fit,minmax(130px,1fr))", gap:10, marginBottom:16 }}>
        {[
          { label:"Active Automations", value:active,   color:T.green,  border:T.green },
          { label:"Failed (24h)",      value:failed,   color:failed>0?T.red:T.green,  border:failed>0?T.red:T.green },
          { label:"Partial Runs",       value:partial,  color:partial>0?T.amber:T.green, border:partial>0?T.amber:T.green },
          { label:"Connection Issues",  value:connError,color:connError>0?T.red:T.green, border:connError>0?T.red:T.green },
        ].map((k,i) => (
          <div key={i} style={{ background:T.white, border:`1px solid ${T.slate200}`, borderTop:`3px solid ${k.border}`, borderRadius:12, padding:"14px 16px" }}>
            <div style={{ fontSize:11, color:T.slate500, fontWeight:500, marginBottom:6 }}>{k.label}</div>
            <div style={{ fontSize:24, fontWeight:700, color:k.color, letterSpacing:"-0.02em" }}>{k.value}</div>
          </div>
        ))}
      </div>

      {/* Failed/Partial Alert */}
      {(failed > 0 || connError > 0) && (
        <div style={{ background:T.redLt, border:`1px solid #FECACA`, borderLeft:`4px solid ${T.red}`, borderRadius:10, padding:"12px 16px", marginBottom:16 }}>
          <div style={{ fontSize:12, fontWeight:700, color:"#991B1B", marginBottom:4 }}>⚠️ Action Required</div>
          {connError > 0 && <div style={{ fontSize:12, color:"#991B1B", marginBottom:2 }}>• Gmail connection error — OAuth token expired. Go to Connections tab to reconnect.</div>}
          {failed > 0 && (
            <div style={{ fontSize:12, color:"#991B1B" }}>
              {`• ${failed} automation run${failed === 1 ? "" : "s"} failed in the last 24h`}
              {failedRecipeNames.length > 0 && ` (${failedRecipeNames.join(", ")})`}
              {" — check Run Log for details."}
            </div>
          )}
          <div style={{ marginTop:8 }}>
            <AskBtn size="small" context="My BCC has automation failures: Gmail OAuth token expired causing Daily Briefing to fail. Help me understand what steps I need to take to reconnect Gmail in Composio and get my Daily Briefing running again." />
          </div>
        </div>
      )}

      {/* Architecture Note */}
      <div style={{ background:T.blueLt, border:`1px solid ${T.blue}20`, borderLeft:`4px solid ${T.blue}`, borderRadius:10, padding:"12px 16px", marginBottom:16 }}>
        <div style={{ fontSize:12, fontWeight:600, color:T.navy, marginBottom:4 }}>How your automations work</div>
        <div style={{ fontSize:11, color:T.slate600, lineHeight:1.7 }}>
          Recipe definitions live in your Supabase database. Cron triggers fire on schedule. Composio executes the recipe using your connected accounts (Gmail, Drive, Facebook, LinkedIn). Document parsing uses the Composio-hosted LLM — free, no separate API key needed. Every run is logged here automatically.
        </div>
      </div>

      <div style={{ display:"grid", gridTemplateColumns:"minmax(0,1.4fr) minmax(0,1fr)", gap:12 }}>
        {/* Recent Run Log */}
        <Card>
          <div style={{ fontSize:13, fontWeight:600, color:T.slate800, marginBottom:12 }}>Recent runs — last 24 hours</div>
          {recentRuns.map((run,i) => (
            <div key={run.id} style={{ display:"flex", alignItems:"center", justifyContent:"space-between", gap:8, padding:"7px 0", borderBottom:i<recentRuns.length-1?`1px solid ${T.slate100}`:"none" }}>
              <div style={{ flex:1, minWidth:0 }}>
                <div style={{ fontSize:12, fontWeight:500, color:T.slate800, whiteSpace:"nowrap", overflow:"hidden", textOverflow:"ellipsis" }}>{run.recipe_name}</div>
                <div style={{ fontSize:10, color:T.slate400 }}>{run.run_at} · {run.duration_seconds}s</div>
              </div>
              <StatusPill status={run.status} />
            </div>
          ))}
        </Card>

        {/* Connection Health */}
        <Card>
          <div style={{ fontSize:13, fontWeight:600, color:T.slate800, marginBottom:12 }}>Connection health</div>
          {connections.map((conn,i) => (
            <div key={conn.id} style={{ display:"flex", alignItems:"center", gap:10, padding:"8px 0", borderBottom:i<connections.length-1?`1px solid ${T.slate100}`:"none" }}>
              <span style={{ fontSize:18, flexShrink:0 }}>{conn.icon}</span>
              <div style={{ flex:1 }}>
                <div style={{ fontSize:12, fontWeight:500, color:T.slate800 }}>{conn.platform}</div>
                <div style={{ fontSize:10, color:T.slate400, whiteSpace:"nowrap", overflow:"hidden", textOverflow:"ellipsis" }}>{conn.connected_account}</div>
              </div>
              <StatusPill status={conn.status} />
            </div>
          ))}
        </Card>
      </div>
    </div>
  );
};

// ─── Section: Run Log ─────────────────────────────────────────
const RunLog = ({ runLog }) => {
  const [filter, setFilter] = useState("all");
  const [expanded, setExpanded] = useState(null);

  const filtered = useMemo(() =>
    runLog.filter(r => filter === "all" || r.status === filter),
    [runLog, filter]
  );

  return (
    <Card>
      <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:14 }}>
        <div>
          <div style={{ fontSize:13, fontWeight:600, color:T.slate800 }}>Automation Run Log</div>
          <div style={{ fontSize:11, color:T.slate500, marginTop:2 }}>Every execution — what ran, what succeeded, what failed</div>
        </div>
        <AskBtn context="I'm reviewing my automation run log. Help me understand any failures or partial runs and what I should do to fix them." />
      </div>

      {/* Filters */}
      <div style={{ display:"flex", gap:6, marginBottom:14, flexWrap:"wrap" }}>
        {[{id:"all",label:"All"},{id:"success",label:"Success"},{id:"failed",label:"Failed"},{id:"partial",label:"Partial"}].map(f => (
          <button key={f.id} onClick={() => setFilter(f.id)} style={{ padding:"5px 12px", fontSize:11, fontWeight:filter===f.id?600:400, color:filter===f.id?T.white:T.slate600, background:filter===f.id?T.navy:T.white, border:`1px solid ${filter===f.id?T.navy:T.slate200}`, borderRadius:6, cursor:"pointer" }}>
            {f.label} {f.id !== "all" && `(${runLog.filter(r => r.status === f.id).length})`}
          </button>
        ))}
      </div>

      <div style={{ display:"flex", flexDirection:"column", gap:4 }}>
        {filtered.map(run => {
          const isExpanded = expanded === run.id;
          const borderColor = run.status === "success" ? T.green : run.status === "failed" ? T.red : T.amber;

          return (
            <div key={run.id} style={{ border:`1px solid ${isExpanded?borderColor:T.slate200}`, borderLeft:`4px solid ${borderColor}`, borderRadius:8, overflow:"hidden" }}>
              <div
                style={{ display:"flex", alignItems:"center", gap:10, padding:"10px 12px", cursor:"pointer" }}
                onClick={() => setExpanded(isExpanded ? null : run.id)}
              >
                <div style={{ flex:1 }}>
                  <div style={{ display:"flex", alignItems:"center", gap:8, marginBottom:2 }}>
                    <span style={{ fontSize:12, fontWeight:600, color:T.slate800 }}>{run.recipe_name}</span>
                    <StatusPill status={run.status} />
                  </div>
                  <div style={{ fontSize:10, color:T.slate400 }}>
                    {run.run_at} · {run.duration_seconds}s · {run.records_processed} records processed
                  </div>
                </div>
                <span style={{ color:T.slate400, fontSize:12 }}>{isExpanded?"▲":"▼"}</span>
              </div>

              {isExpanded && (
                <div style={{ padding:"0 12px 12px", borderTop:`1px solid ${T.slate100}` }}>
                  <div style={{ fontSize:11, color:T.slate700, lineHeight:1.6, marginTop:8, marginBottom:run.error_message?8:0 }}>
                    {run.output_summary}
                  </div>
                  {run.error_message && (
                    <div style={{ fontSize:11, color:"#991B1B", background:T.redLt, padding:"8px 10px", borderRadius:6, marginTop:8, marginBottom:8 }}>
                      🔴 {run.error_message}
                    </div>
                  )}
                  <div style={{ marginTop:8 }}>
                    <AskBtn size="small" context={`Automation run details:\nRecipe: ${run.recipe_name}\nStatus: ${run.status}\nTime: ${run.run_at}\nDuration: ${run.duration_seconds}s\nRecords processed: ${run.records_processed}\nSummary: ${run.output_summary}${run.error_message?"\nError: "+run.error_message:""}\n\nHelp me understand this result and what action I should take.`} />
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </Card>
  );
};

// ─── Section: Recipes ─────────────────────────────────────────
const Recipes = ({ recipes, onToggle }) => {
  const [expanded, setExpanded] = useState(null);

  return (
    <div>
      <div style={{ fontSize:13, color:T.slate500, marginBottom:14, lineHeight:1.6 }}>
        Recipe definitions live in your Supabase database. Each recipe defines what triggers it, which Composio connection executes it, whether the Composio-hosted LLM parses the output, and which table receives the results. Enable or disable any recipe at any time.
      </div>

      <div style={{ display:"flex", flexDirection:"column", gap:8 }}>
        {recipes.map(recipe => {
          const isExpanded = expanded === recipe.id;
          return (
            <div key={recipe.id} style={{ background:T.white, border:`1px solid ${isExpanded?T.blue:T.slate200}`, borderRadius:12, overflow:"hidden" }}>
              {/* Recipe Header */}
              <div style={{ display:"flex", alignItems:"center", gap:12, padding:"14px 16px" }}>
                <div style={{ flex:1, cursor:"pointer" }} onClick={() => setExpanded(isExpanded?null:recipe.id)}>
                  <div style={{ display:"flex", alignItems:"center", gap:8, marginBottom:4, flexWrap:"wrap" }}>
                    <span style={{ fontSize:13, fontWeight:600, color:recipe.is_active?T.slate900:T.slate400 }}>{recipe.recipe_name}</span>
                    <CategoryBadge category={recipe.category} />
                    {recipe.uses_groq && (
                      <span style={{ fontSize:10, fontWeight:600, padding:"2px 7px", borderRadius:20, background:T.tealLt, color:T.teal }}>LLM</span>
                    )}
                  </div>
                  <div style={{ fontSize:11, color:T.slate400 }}>
                    {recipe.cron_label} · Last run: {recipe.last_run_at} · {recipe.run_count_30d} runs/30 days · {recipe.success_rate}% success
                  </div>
                </div>

                <div style={{ display:"flex", alignItems:"center", gap:10, flexShrink:0 }}>
                  <StatusPill status={recipe.last_run_status} />
                  {/* Toggle */}
                  <div
                    onClick={() => onToggle(recipe.id)}
                    style={{
                      width:40, height:22, borderRadius:11, cursor:"pointer",
                      background:recipe.is_active?T.green:T.slate300,
                      position:"relative", transition:"background 0.2s",
                      flexShrink:0,
                    }}
                  >
                    <div style={{
                      width:18, height:18, borderRadius:"50%", background:T.white,
                      position:"absolute", top:2,
                      left:recipe.is_active?20:2,
                      transition:"left 0.2s",
                      boxShadow:"0 1px 3px rgba(0,0,0,0.2)",
                    }} />
                  </div>
                </div>
              </div>

              {/* Expanded Details */}
              {isExpanded && (
                <div style={{ padding:"0 16px 16px", borderTop:`1px solid ${T.slate100}` }}>
                  <div style={{ fontSize:12, color:T.slate600, lineHeight:1.6, marginTop:10, marginBottom:12 }}>
                    {recipe.recipe_description}
                  </div>
                  <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fit,minmax(160px,1fr))", gap:8, marginBottom:12 }}>
                    {[
                      { label:"Trigger",    value:recipe.cron_label },
                      { label:"Action",     value:recipe.composio_action || "Internal only" },
                      { label:"Connection", value:recipe.composio_connection ? recipe.composio_connection.charAt(0).toUpperCase()+recipe.composio_connection.slice(1) : "None needed" },
                      { label:"Processing", value:recipe.uses_groq?"Composio LLM (free)":"None" },
                    ].map((detail,i) => (
                      <div key={i} style={{ background:T.slate50, borderRadius:8, padding:"8px 10px" }}>
                        <div style={{ fontSize:10, color:T.slate400, marginBottom:2 }}>{detail.label}</div>
                        <div style={{ fontSize:11, fontWeight:500, color:T.slate700 }}>{detail.value}</div>
                      </div>
                    ))}
                  </div>
                  <AskBtn size="small" context={`Automation recipe details:\nName: ${recipe.recipe_name}\nDescription: ${recipe.recipe_description}\nTrigger: ${recipe.cron_label}\nComposio Action: ${recipe.composio_action || "None"}\nConnection: ${recipe.composio_connection || "None"}\nUses Composio LLM parsing: ${recipe.uses_groq}\nSuccess Rate: ${recipe.success_rate}%\n\nHelp me understand what this automation does and whether it's configured optimally for my agency.`} />
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
};

// ─── Section: Connections ─────────────────────────────────────
const Connections = ({ connections }) => (
  <div style={{ display:"flex", flexDirection:"column", gap:10 }}>
    <div style={{ fontSize:13, color:T.slate500, marginBottom:4, lineHeight:1.6 }}>
      These are your Composio connected accounts. Every automation that interacts with Gmail, Drive, Facebook, LinkedIn, or other services uses one of these connections. If a connection shows an error, automations that depend on it will fail until it is reconnected.
    </div>

    {(connections || []).length === 0 && (
      <div style={{ fontSize:11, color:T.slate400, padding:"8px 4px" }}>No connections configured.</div>
    )}
    {(connections || []).map(conn => (
      <Card key={conn.id}>
        <div style={{ display:"flex", alignItems:"flex-start", gap:14 }}>
          <div style={{ width:44, height:44, borderRadius:12, background:T.slate50, border:`1px solid ${T.slate200}`, display:"flex", alignItems:"center", justifyContent:"center", fontSize:22, flexShrink:0 }}>
            {conn.icon}
          </div>
          <div style={{ flex:1 }}>
            <div style={{ display:"flex", alignItems:"center", gap:10, marginBottom:4, flexWrap:"wrap" }}>
              <span style={{ fontSize:13, fontWeight:700, color:T.slate900 }}>{conn.platform}</span>
              <StatusPill status={conn.status} />
            </div>
            <div style={{ fontSize:11, color:T.slate600, marginBottom:4 }}>{conn.connected_account}</div>
            <div style={{ fontSize:11, color:conn.status==="error"?T.red:T.slate400 }}>{conn.note}</div>
            {conn.status !== "manual" && (
              <div style={{ fontSize:10, color:T.slate400, marginTop:4 }}>Last sync: {conn.last_sync}</div>
            )}
          </div>
          {conn.status === "error" && (
            <button style={{ padding:"6px 14px", fontSize:11, fontWeight:600, color:T.white, background:T.red, border:"none", borderRadius:7, cursor:"pointer", flexShrink:0 }}>
              Reconnect
            </button>
          )}
          {conn.status === "healthy" && (
            <div style={{ fontSize:10, color:T.green, fontWeight:600, flexShrink:0, paddingTop:4 }}>✓ Connected</div>
          )}
        </div>
      </Card>
    ))}
  </div>
);

// ─── Section: Daily Briefing ──────────────────────────────────
const DailyBriefingSection = ({ briefings }) => {
  const list = briefings || [];
  const [selected, setSelected] = useState(list[0]?.id);
  useEffect(() => {
    // When briefings load asynchronously, hydrate selection to the first row.
    if (!selected && list.length > 0) setSelected(list[0].id);
  }, [list, selected]);
  const current = list.find(b => b.id === selected);
  const isHtml = (s) => typeof s === "string" && /<[a-z][\s\S]*>/i.test(s);

  return (
    <div style={{ display:"grid", gridTemplateColumns:"minmax(0,1fr) minmax(0,2fr)", gap:12 }}>
      {/* Briefing List */}
      <Card>
        <div style={{ fontSize:13, fontWeight:600, color:T.slate800, marginBottom:12 }}>Briefing history</div>
        {list.length === 0 && (
          <div style={{ fontSize:11, color:T.slate400, padding:"8px 4px" }}>No briefings yet.</div>
        )}
        {list.map(b => (
          <div
            key={b.id}
            onClick={() => setSelected(b.id)}
            style={{ padding:"10px 12px", borderRadius:8, cursor:"pointer", background:selected===b.id?T.blueLt:"transparent", border:`1px solid ${selected===b.id?T.blue:T.slate200}`, marginBottom:6 }}
          >
            <div style={{ fontSize:12, fontWeight:600, color:T.slate800 }}>{b.date}</div>
            <div style={{ fontSize:10, color:T.slate400, marginTop:2 }}>
              Sent {b.sent_at} · {b.delivered?"Delivered":"Not delivered"} · {b.opened?"Opened":"Not opened"}
            </div>
            <div style={{ display:"flex", gap:4, marginTop:4 }}>
              {b.delivered && <span style={{ fontSize:9, padding:"2px 6px", borderRadius:10, background:T.greenLt, color:"#065F46", fontWeight:600 }}>Delivered</span>}
              {b.opened    && <span style={{ fontSize:9, padding:"2px 6px", borderRadius:10, background:T.blueLt,  color:"#1E40AF", fontWeight:600 }}>Opened</span>}
            </div>
          </div>
        ))}
      </Card>

      {/* Briefing Content */}
      {current && (
        <Card>
          <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:14 }}>
            <div style={{ fontSize:13, fontWeight:600, color:T.slate800 }}>{current.date} — Briefing Content</div>
            <AskBtn size="small" context={`My daily briefing from ${current.date}:\n\n${current.content}\n\nBased on this briefing, what should be my top 3 priorities today?`} />
          </div>
          <div style={{ background:T.slate50, borderRadius:10, padding:"14px 16px", fontSize:12, color:T.slate700, lineHeight:1.8, whiteSpace: isHtml(current.content) ? "normal" : "pre-line", fontFamily:"inherit" }}>
            {isHtml(current.content)
              ? <div dangerouslySetInnerHTML={{ __html: current.content }} />
              : current.content}
          </div>
        </Card>
      )}
    </div>
  );
};

// ─── Section: Document Importer ───────────────────────────────
const DocImporter = ({ imports }) => {
  const [expanded, setExpanded] = useState(null);

  const typeLabel = (t) => ({
    comp_recap:    "COMP_RECAP",
    payroll_export:"Payroll Export",
    bank_statement:"Bank Statement",
    resume:        "Resume",
    tax_document:  "Tax Document",
  }[t] || t);

  const typeColor = (t) => ({
    comp_recap:     { bg:T.greenLt,  color:"#065F46" },
    payroll_export: { bg:T.blueLt,   color:"#1E40AF" },
    bank_statement: { bg:T.amberLt,  color:"#92400E" },
    resume:         { bg:T.purpleLt, color:"#5B21B6" },
    tax_document:   { bg:T.tealLt,   color:T.teal    },
  }[t] || { bg:T.slate100, color:T.slate500 });

  return (
    <Card>
      <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:14 }}>
        <div>
          <div style={{ fontSize:13, fontWeight:600, color:T.slate800 }}>Document Importer — Processing History</div>
          <div style={{ fontSize:11, color:T.slate500, marginTop:2 }}>Documents received via Gmail, parsed by Composio LLM, loaded to Supabase</div>
        </div>
        <AskBtn context="I'm reviewing my document importer history. Are there any documents that failed or need manual review? What should I follow up on?" />
      </div>

      {/* How It Works */}
      <div style={{ display:"flex", gap:0, marginBottom:16, overflow:"hidden", borderRadius:10, border:`1px solid ${T.slate200}` }}>
        {[
          { step:"1", label:"Email arrives", sub:"to your Gmail" },
          { step:"2", label:"Composio detects", sub:"attachment scanned" },
          { step:"3", label:"LLM classifies", sub:"Composio-hosted, free" },
          { step:"4", label:"Data loaded", sub:"to Supabase tables" },
          { step:"5", label:"Drive filed", sub:"correct folder" },
        ].map((s,i) => (
          <div key={i} style={{ flex:1, padding:"8px 4px", textAlign:"center", background:i%2===0?T.slate50:T.white, borderRight:i<4?`1px solid ${T.slate200}`:"none" }}>
            <div style={{ fontSize:14, fontWeight:700, color:T.blue }}>{s.step}</div>
            <div style={{ fontSize:9, fontWeight:600, color:T.slate700 }}>{s.label}</div>
            <div style={{ fontSize:9, color:T.slate400 }}>{s.sub}</div>
          </div>
        ))}
      </div>

      <div style={{ display:"flex", flexDirection:"column", gap:4 }}>
        {(imports || []).length === 0 && (
          <div style={{ fontSize:11, color:T.slate400, padding:"12px 4px" }}>No imports yet.</div>
        )}
        {(imports || []).map(doc => {
          const isExpanded = expanded === doc.id;
          const tc = typeColor(doc.groq_type);
          return (
            <div key={doc.id} style={{ border:`1px solid ${isExpanded?T.blue:T.slate200}`, borderRadius:8, overflow:"hidden" }}>
              <div
                style={{ display:"flex", alignItems:"center", gap:10, padding:"10px 12px", cursor:"pointer" }}
                onClick={() => setExpanded(isExpanded?null:doc.id)}
              >
                <div style={{ flex:1, minWidth:0 }}>
                  <div style={{ display:"flex", alignItems:"center", gap:8, marginBottom:2, flexWrap:"wrap" }}>
                    <span style={{ fontSize:12, fontWeight:500, color:T.slate800, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{doc.file_name}</span>
                    <span style={{ fontSize:10, fontWeight:600, padding:"2px 7px", borderRadius:20, background:tc.bg, color:tc.color, flexShrink:0 }}>{typeLabel(doc.groq_type)}</span>
                  </div>
                  <div style={{ fontSize:10, color:T.slate400 }}>{doc.date} · {doc.source} · {doc.records} records loaded</div>
                </div>
                <StatusPill status={doc.status} />
              </div>

              {isExpanded && (
                <div style={{ padding:"0 12px 12px", borderTop:`1px solid ${T.slate100}` }}>
                  <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:8, marginTop:8, marginBottom:10 }}>
                    <div style={{ background:T.slate50, borderRadius:8, padding:"8px 10px" }}>
                      <div style={{ fontSize:10, color:T.slate400, marginBottom:2 }}>Source</div>
                      <div style={{ fontSize:11, fontWeight:500, color:T.slate700 }}>{doc.source}</div>
                    </div>
                    <div style={{ background:T.slate50, borderRadius:8, padding:"8px 10px" }}>
                      <div style={{ fontSize:10, color:T.slate400, marginBottom:2 }}>Tables Updated</div>
                      <div style={{ fontSize:11, fontWeight:500, color:T.slate700 }}>{(doc.tables || []).join(", ") || "—"}</div>
                    </div>
                  </div>
                  {doc.status === "partial" && (
                    <div style={{ fontSize:11, color:"#92400E", background:T.amberLt, padding:"8px 10px", borderRadius:6, marginBottom:8 }}>
                      ⚠ Partial import — one or more pages could not be parsed. File saved to Google Drive for manual review.
                    </div>
                  )}
                  <AskBtn size="small" context={`Document import record:\nFile: ${doc.file_name}\nDate: ${doc.date}\nSource: ${doc.source}\nLLM Classification: ${doc.groq_type}\nStatus: ${doc.status}\nRecords loaded: ${doc.records}\nTables updated: ${(doc.tables || []).join(", ") || "—"}\n\nHelp me verify this import looks correct and identify any follow-up needed.`} />
                </div>
              )}
            </div>
          );
        })}
      </div>
    </Card>
  );
};

// ─── Main Automations Module ──────────────────────────────────
export default function Automations() {
  const [section, setSection] = useState("overview");

  // ─── Live data ────────────────────────────────────────────
  // Recipes + run log were already live; we now add briefings, documents,
  // and settings so Daily Briefing / Doc Importer / Connections tabs all
  // pull from Supabase instead of hardcoded mocks.
  const { data: liveRecipes,  loading: recipesLoading } = useSupabaseTable("automation_recipes",  AGENCY_ID, { orderBy: "created_at", ascending: false });
  const { data: liveRunLog }                            = useSupabaseTable("automation_run_log",  AGENCY_ID, { orderBy: "run_at",     ascending: false });
  const { data: liveBriefings }                         = useSupabaseTable("briefings",           AGENCY_ID, { orderBy: "briefing_date", ascending: false });
  const { data: liveDocuments }                         = useSupabaseTable("documents",           AGENCY_ID, { orderBy: "uploaded_at", ascending: false });
  const { data: liveSettings }                          = useSupabaseTable("settings",            AGENCY_ID, { orderBy: "setting_key", ascending: true });

  // ─── Recipes state (optimistic toggle, revert on failure) ─
  const [recipes, setRecipes] = useState([]);
  useEffect(() => {
    if (Array.isArray(liveRecipes)) setRecipes(liveRecipes);
  }, [liveRecipes]);

  const runLog = Array.isArray(liveRunLog) ? liveRunLog : [];

  const toggleRecipe = async (id) => {
    const current = recipes.find(r => r.id === id);
    if (!current || !supabase) return;
    const next = !current.is_active;
    // Optimistic UI
    setRecipes(prev => prev.map(r => r.id === id ? { ...r, is_active: next } : r));
    const { error } = await supabase
      .from("automation_recipes")
      .update({ is_active: next })
      .eq("id", id)
      .eq("agency_id", AGENCY_ID);
    if (error) {
      console.error("toggleRecipe failed:", error);
      // Revert
      setRecipes(prev => prev.map(r => r.id === id ? { ...r, is_active: current.is_active } : r));
    }
  };

  // ─── Derived: Connections (settings + recipes + recent run_log) ─
  // For each CONNECTOR_DEF, we resolve:
  //   connected_account: the auth_config_id in settings (or the legacy
  //     account_id key if present), else "Not connected"
  //   status: derived from recent run_log status for recipes using this
  //     connector — "error" if last run failed, "healthy" if last run
  //     succeeded, "manual" for Instagram, "warning" otherwise
  const connections = useMemo(() => {
    const settingsByKey = {};
    (liveSettings || []).forEach(s => { settingsByKey[s.setting_key] = s.setting_value; });
    const recipesByConn = {};
    (recipes || []).forEach(r => {
      const k = r.composio_connection;
      if (!k) return;
      if (!recipesByConn[k]) recipesByConn[k] = [];
      recipesByConn[k].push(r);
    });
    const recentByRecipe = {};
    (runLog || []).forEach(l => {
      if (recentByRecipe[l.recipe_id]) return; // first one wins (run_log sorted DESC)
      recentByRecipe[l.recipe_id] = l;
    });
    return CONNECTOR_DEFS.map(def => {
      const ac = settingsByKey[`composio_${def.key}_auth_config_id`];
      const recs = recipesByConn[def.key] || [];
      const latestRuns = recs
        .map(r => recentByRecipe[r.id])
        .filter(Boolean)
        .sort((a,b) => new Date(b.run_at) - new Date(a.run_at));
      const latest = latestRuns[0];

      let status, note, last_sync;
      if (def.manual) {
        status    = "manual";
        note      = "Instagram requires manual daily posting — no API scheduling available";
        last_sync = "N/A";
      } else if (!ac) {
        status    = "warning";
        note      = "Not connected — add this connector in Composio to enable related recipes";
        last_sync = "—";
      } else if (latest && latest.status === "failed") {
        status    = "error";
        note      = latest.error_message
          ? latest.error_message.slice(0, 140)
          : "Most recent run failed — check Composio connection";
        last_sync = fmtRelative(latest.run_at);
      } else if (latest) {
        status    = "healthy";
        note      = `${recs.length} recipe${recs.length === 1 ? "" : "s"} using this connector`;
        last_sync = fmtRelative(latest.run_at);
      } else {
        status    = "healthy";
        note      = recs.length > 0
          ? `${recs.length} recipe${recs.length === 1 ? "" : "s"} configured · no runs yet`
          : "Connected · no recipes yet";
        last_sync = "—";
      }
      return {
        id: def.key,
        platform: def.platform,
        icon: def.icon,
        status,
        connected_account: ac || "Not connected",
        note,
        last_sync,
      };
    });
  }, [liveSettings, recipes, runLog]);

  // ─── Derived: Briefings ───────────────────────────────────
  const briefings = useMemo(() => {
    return (liveBriefings || []).map(b => ({
      id:        b.id,
      date:      fmtBriefingDate(b.briefing_date),
      sent_at:   b.sent_at ? fmtRelative(b.sent_at) : (b.generated_at ? `Draft · generated ${fmtRelative(b.generated_at)}` : "Draft"),
      delivered: !!b.sent_at,
      opened:    false, // briefings table does not track opens; reserved for future
      content:   b.body_html || b.subject || "",
    }));
  }, [liveBriefings]);

  // ─── Derived: Doc Importer history ────────────────────────
  // Only show docs that have a meaningful processing_type. Sort newest first.
  const imports = useMemo(() => {
    return (liveDocuments || []).map(d => ({
      id:         d.id,
      file_name:  d.file_name || "(unnamed)",
      date:       fmtBriefingDate((d.uploaded_at || d.created_at || "").slice(0, 10)),
      source:     d.upload_source || stripHtml(d.notes) || "—",
      records:    d.records_created || 0,
      tables:     Array.isArray(d.tables_updated) ? d.tables_updated : [],
      groq_type:  mapDocType(d.processing_type),
      status:     mapDocStatus(d.processing_status),
    }));
  }, [liveDocuments]);

  // ─── Loading / empty states ────────────────────────────────
  if (recipesLoading) return <div style={{padding:40,textAlign:"center",fontSize:13,color:"#64748B"}}>Loading automations…</div>;
  if (recipes.length === 0) return <EmptyState module="automations" />;

  // ─── Dynamic header copy ───────────────────────────────────
  const activeCount = recipes.filter(r => r.is_active).length;
  const sections = [
    { id:"overview",    label:"Overview"             },
    { id:"runlog",      label:"Run Log"              },
    { id:"recipes",     label:`Recipes (${recipes.length})` },
    { id:"connections", label:"Connections"          },
    { id:"briefing",    label:"Daily Briefing"       },
    { id:"importer",    label:"Doc Importer"         },
  ];

  return (
    <div>
      {/* Module Header */}
      <div style={{ display:"flex", alignItems:"flex-start", justifyContent:"space-between", marginBottom:16 }}>
        <div>
          <div style={{ fontSize:20, fontWeight:700, color:T.slate900, letterSpacing:"-0.02em" }}>Automations</div>
          <div style={{ fontSize:12, color:T.slate500, marginTop:3 }}>
            {activeCount} active recipe{activeCount === 1 ? "" : "s"} · Composio executes · Composio LLM parses · All results logged here
          </div>
        </div>
        <AskBtn context="I'm reviewing my BCC automations. Give me a health check — what's running well, what needs attention, and are there any automation improvements I should consider for my agency?" />
      </div>

      {/* Section Navigation */}
      <div style={{ display:"flex", gap:2, flexWrap:"wrap", background:T.slate100, borderRadius:10, padding:4, marginBottom:18 }}>
        {sections.map(s => (
          <button key={s.id} onClick={() => setSection(s.id)} style={{ padding:"7px 14px", fontSize:12, fontWeight:section===s.id?600:400, color:section===s.id?T.slate900:T.slate500, background:section===s.id?T.white:"transparent", border:"none", borderRadius:7, cursor:"pointer", transition:"all 0.12s", boxShadow:section===s.id?"0 1px 3px rgba(0,0,0,0.08)":"none" }}>
            {s.label}
          </button>
        ))}
      </div>

      {/* Section Content */}
      {section === "overview"    && <AutomationOverview recipes={recipes} runLog={runLog} connections={connections} />}
      {section === "runlog"      && <RunLog runLog={runLog} />}
      {section === "recipes"     && <Recipes recipes={recipes} onToggle={toggleRecipe} />}
      {section === "connections" && <Connections connections={connections} />}
      {section === "briefing"    && <DailyBriefingSection briefings={briefings} />}
      {section === "importer"    && <DocImporter imports={imports} />}
    </div>
  );
}
