import { useState, useMemo, useEffect, useRef, useCallback } from "react";
import { supabase, AGENCY_ID } from "../lib/supabase.js";

// ============================================================
// BCC COMPLIANCE CENTER MODULE v2.0
// Business Command Center — Tyler Insurance and Financial Services LLC
// Built by Imaginary Farms LLC · imaginary-farms.com
//
// v2.0 (2026-06-18): Wired to live compliance_rules / compliance_calendar /
//   compliance_log tables. Mock arrays removed. Live counts everywhere.
//   Pre-Post Checklist pulled from compliance_rules WHERE category =
//   'social_media_checklist'. Calendar hides [OFFICE]-prefixed items per the
//   operational rule (office staff handle PFA, not the agent-facing BCC).
//   Audit log reads + writes compliance_log.
//
// SECTIONS:
//   1. Dashboard          — KPIs, upcoming deadlines, critical rules ref
//   2. Rules Library      — All non-checklist rules (50), searchable, filterable
//   3. Pre-Post Checklist — 26 social_media_checklist rules (live)
//   4. Calendar           — compliance_calendar items, dynamic days_remaining
//   5. Audit Log          — compliance_log read + write
// ============================================================


// ─── Design Tokens ────────────────────────────────────────────
const T = {
  navy:    "#1B2B4B",
  navyLt:  "#EEF2FF",
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

// ─── Category Config ──────────────────────────────────────────
// Matches the actual categories in compliance_rules.
const CATEGORY_CONFIG = {
  contract:              { label: "Contract Basics",     color: T.navy,    icon: "📜" },
  advertising:           { label: "Advertising",         color: T.blue,    icon: "📢" },
  social_media:          { label: "Social Media",        color: T.purple,  icon: "📱" },
  social_media_checklist:{ label: "Pre-Post Checklist",  color: T.teal,    icon: "✅" },
  trademark:             { label: "Trademark & Brand",   color: T.amber,   icon: "®️" },
  giveaways:             { label: "Giveaways",           color: T.green,   icon: "🎁" },
  financial:             { label: "Financial",           color: T.blue,    icon: "💰" },
  licensing:             { label: "Licensing",           color: T.red,     icon: "🪪" },
  data_privacy:          { label: "Data Privacy",        color: T.slate700,icon: "🔒" },
  medicare:              { label: "Medicare",            color: T.red,     icon: "🏥" },
};

const UNKNOWN_CATEGORY = { label: "Other", color: T.slate500, icon: "•" };
const cfgFor = (cat) => CATEGORY_CONFIG[cat] || UNKNOWN_CATEGORY;

// ─── Helpers ──────────────────────────────────────────────────
const severityConfig = (s) => ({
  critical: { color: T.red,    bg: T.redLt,    label: "Critical" },
  warning:  { color: T.amber,  bg: T.amberLt,  label: "Warning"  },
  info:     { color: T.blue,   bg: T.blueLt,   label: "Info"     },
}[s] || { color: T.slate500, bg: T.slate100, label: s || "—" });

const statusConfig = (s) => ({
  upcoming:       { color: T.blue,    bg: T.blueLt,   label: "Upcoming"     },
  due:            { color: T.amber,   bg: T.amberLt,  label: "Due Soon"     },
  overdue:        { color: T.red,     bg: T.redLt,    label: "Overdue"      },
  completed:      { color: T.green,   bg: T.greenLt,  label: "Complete"     },
  rolled_forward: { color: T.slate500,bg: T.slate100, label: "Rolled"       },
}[s] || { color: T.slate500, bg: T.slate100, label: s || "—" });

const eventConfig = (e) => ({
  review:           { color: T.blue,    icon: "👁" },
  completed:        { color: T.green,   icon: "✅" },
  claude_pushback:  { color: T.amber,   icon: "⚡" },
  violation_flagged:{ color: T.red,     icon: "🚨" },
  acknowledged:     { color: T.slate500,icon: "📋" },
  manual_note:      { color: T.slate500,icon: "📝" },
}[e] || { color: T.slate500, icon: "📋" });

const fmtDate = (d) => {
  try { return new Date(d).toLocaleDateString("en-US", { month:"short", day:"numeric", year:"numeric" }); }
  catch { return d || ""; }
};

const daysFromToday = (dateStr) => {
  if (!dateStr) return null;
  const due = new Date(dateStr + "T00:00:00");
  const today = new Date();
  today.setHours(0,0,0,0);
  return Math.round((due - today) / 86400000);
};

// Derive a display status from the raw row + computed days_remaining.
const deriveStatus = (item) => {
  if (item.status === "completed") return "completed";
  if (item.status === "rolled_forward") return "rolled_forward";
  const d = item.days_remaining;
  if (d == null) return item.status || "upcoming";
  if (d < 0) return "overdue";
  if (d <= 14) return "due";
  return "upcoming";
};

// ─── Shared Components ────────────────────────────────────────
const Card = ({ children, style = {} }) => (
  <div style={{ background: T.white, border: `1px solid ${T.slate200}`, borderRadius: 12, padding: "16px 18px", ...style }}>
    {children}
  </div>
);

const Pill = ({ type, children }) => {
  const s = severityConfig(type);
  return (
    <span style={{ display:"inline-flex", alignItems:"center", fontSize:10, fontWeight:600, padding:"3px 8px", borderRadius:20, background:s.bg, color:s.color, whiteSpace:"nowrap" }}>
      {children || s.label}
    </span>
  );
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
                <strong>Demo mode.</strong> On a real BCC this opens the agent’s own Claude.ai, ready to paste.
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

// ─── Section: Dashboard ───────────────────────────────────────
const ComplianceDashboard = ({ rules, calendar, log }) => {
  const totalRules = rules.length;
  const critical   = rules.filter(r => r.severity === "critical").length;
  const due14      = calendar.filter(c => c.days_remaining != null && c.days_remaining >= 0 && c.days_remaining <= 14).length;
  const overdue    = calendar.filter(c => c.days_remaining != null && c.days_remaining < 0
                       && c.status !== "completed" && c.status !== "rolled_forward").length;

  // Top 8 critical rules (by rule_code) for quick-reference card
  const criticalRef = rules
    .filter(r => r.severity === "critical")
    .slice()
    .sort((a,b) => (a.rule_code || "").localeCompare(b.rule_code || ""))
    .slice(0, 8);

  // Upcoming deadlines: not completed/rolled, sorted by days_remaining asc
  const upcoming = calendar
    .filter(c => c.status !== "completed" && c.status !== "rolled_forward")
    .slice()
    .sort((a,b) => (a.days_remaining ?? 9999) - (b.days_remaining ?? 9999))
    .slice(0, 6);

  return (
    <div>
      {/* Status KPIs */}
      <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fit,minmax(140px,1fr))", gap:10, marginBottom:16 }}>
        {[
          { label:"Critical Rules",     value: critical, color: T.red,   border: T.red   },
          { label:"Due Within 14 Days", value: due14,    color: T.amber, border: T.amber },
          { label:"Overdue Items",      value: overdue,  color: overdue>0?T.red:T.green, border: overdue>0?T.red:T.green },
          { label:"Rules in Library",   value: totalRules, color: T.blue, border: T.blue },
        ].map((k,i) => (
          <div key={i} style={{ background:T.white, border:`1px solid ${T.slate200}`, borderTop:`3px solid ${k.border}`, borderRadius:12, padding:"14px 16px" }}>
            <div style={{ fontSize:11, color:T.slate500, fontWeight:500, marginBottom:6 }}>{k.label}</div>
            <div style={{ fontSize:24, fontWeight:700, color:k.color, letterSpacing:"-0.02em" }}>{k.value}</div>
          </div>
        ))}
      </div>

      <div style={{ display:"grid", gridTemplateColumns:"minmax(0,1fr) minmax(0,1fr)", gap:12 }}>
        {/* Upcoming Deadlines */}
        <Card>
          <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:12 }}>
            <span style={{ fontSize:13, fontWeight:600, color:T.slate800 }}>Upcoming deadlines</span>
            <AskBtn size="small" context="Here are my upcoming compliance deadlines. Help me prioritize what needs my immediate attention and what I should plan for in the next 90 days." />
          </div>
          {upcoming.length === 0 && (
            <div style={{ fontSize:12, color:T.slate400, fontStyle:"italic", padding:"6px 0" }}>No upcoming deadlines.</div>
          )}
          {upcoming.map((item,i) => {
            const sc = statusConfig(deriveStatus(item));
            const urgent = (item.days_remaining ?? 9999) <= 14;
            return (
              <div key={item.id} style={{ display:"flex", alignItems:"flex-start", justifyContent:"space-between", gap:8, padding:"8px 0", borderBottom:i<upcoming.length-1?`1px solid ${T.slate100}`:"none" }}>
                <div style={{ flex:1, minWidth:0 }}>
                  <div style={{ fontSize:12, fontWeight:500, color:urgent?T.red:T.slate800 }}>{item.title}</div>
                  <div style={{ fontSize:10, color:T.slate400, marginTop:2 }}>
                    {item.days_remaining < 0
                      ? `Overdue by ${Math.abs(item.days_remaining)} days`
                      : item.days_remaining === 0
                        ? "Due today"
                        : item.days_remaining <= 14
                          ? `\u26a0 ${item.days_remaining} days remaining`
                          : `${item.days_remaining} days`}
                    {item.recurrence ? ` \u00b7 ${item.recurrence}` : ""}
                  </div>
                </div>
                <span style={{ fontSize:10, fontWeight:600, padding:"3px 8px", borderRadius:20, background:sc.bg, color:sc.color, whiteSpace:"nowrap" }}>{sc.label}</span>
              </div>
            );
          })}
        </Card>

        {/* Critical Rules Quick Reference */}
        <Card>
          <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:12 }}>
            <span style={{ fontSize:13, fontWeight:600, color:T.slate800 }}>Critical rules — quick reference</span>
          </div>
          {criticalRef.length === 0 && (
            <div style={{ fontSize:12, color:T.slate400, fontStyle:"italic" }}>No critical rules.</div>
          )}
          {criticalRef.map((r,i) => (
            <div key={r.id} style={{ display:"flex", gap:10, alignItems:"flex-start", padding:"6px 0", borderBottom:i<criticalRef.length-1?`1px solid ${T.slate100}`:"none" }}>
              <div style={{ width:6, height:6, borderRadius:"50%", background:T.red, flexShrink:0, marginTop:7 }} />
              <div style={{ flex:1, minWidth:0 }}>
                <span style={{ fontSize:11, color:T.slate700, lineHeight:1.5 }}>{r.title}</span>
                {r.rule_code && <span style={{ fontSize:10, color:T.slate400, marginLeft:6 }}>({r.rule_code})</span>}
              </div>
            </div>
          ))}
        </Card>
      </div>

      {/* Recent Audit Log */}
      <Card style={{ marginTop:12 }}>
        <div style={{ fontSize:13, fontWeight:600, color:T.slate800, marginBottom:12 }}>Recent compliance activity</div>
        {log.length === 0 && (
          <div style={{ fontSize:12, color:T.slate400, fontStyle:"italic", padding:"6px 0" }}>
            No compliance activity logged yet. Use the Audit Log tab to record reviews, completions, and Claude pushbacks.
          </div>
        )}
        {log.slice(0,4).map((entry,i,arr) => {
          const ec = eventConfig(entry.event_type);
          return (
            <div key={entry.id} style={{ display:"flex", gap:10, alignItems:"flex-start", padding:"8px 0", borderBottom:i<arr.length-1?`1px solid ${T.slate100}`:"none" }}>
              <span style={{ fontSize:16, flexShrink:0 }}>{ec.icon}</span>
              <div style={{ flex:1, minWidth:0 }}>
                <div style={{ fontSize:12, color:T.slate800 }}>{entry.description}</div>
                <div style={{ fontSize:10, color:T.slate400, marginTop:2 }}>
                  {fmtDate(entry.created_at)} · {entry.created_by || "system"}
                </div>
              </div>
            </div>
          );
        })}
      </Card>
    </div>
  );
};

// ─── Section: Rules Library ───────────────────────────────────
const RulesLibrary = ({ rules }) => {
  const [search,    setSearch]    = useState("");
  const [category,  setCategory]  = useState("all");
  const [severity,  setSeverity]  = useState("all");
  const [expanded,  setExpanded]  = useState(null);

  // Exclude social_media_checklist (has its own tab)
  const libRules = useMemo(() => rules.filter(r => r.category !== "social_media_checklist"), [rules]);

  const categories = useMemo(() => {
    const present = new Set(libRules.map(r => r.category));
    return Object.keys(CATEGORY_CONFIG).filter(c => c !== "social_media_checklist" && present.has(c));
  }, [libRules]);

  const filtered = useMemo(() => libRules.filter(r => {
    if (category !== "all" && r.category !== category) return false;
    if (severity !== "all" && r.severity !== severity) return false;
    if (search) {
      const q = search.toLowerCase();
      return (r.title || "").toLowerCase().includes(q)
          || (r.description || "").toLowerCase().includes(q)
          || (r.rule_code || "").toLowerCase().includes(q)
          || (r.source || "").toLowerCase().includes(q);
    }
    return true;
  }), [libRules, search, category, severity]);

  return (
    <div>
      <div style={{ display:"flex", gap:8, marginBottom:16, flexWrap:"wrap" }}>
        <input
          value={search} onChange={e => setSearch(e.target.value)}
          placeholder="Search rules, codes, or sources..."
          style={{ flex:1, minWidth:200, padding:"8px 12px", fontSize:12, color:T.slate800, border:`1px solid ${T.slate200}`, borderRadius:8, outline:"none", background:T.white }}
        />
        <select value={category} onChange={e => setCategory(e.target.value)} style={{ padding:"8px 10px", fontSize:12, color:T.slate700, border:`1px solid ${T.slate200}`, borderRadius:8, background:T.white, outline:"none" }}>
          <option value="all">All Categories</option>
          {categories.map(c => (
            <option key={c} value={c}>{cfgFor(c).label}</option>
          ))}
        </select>
        <select value={severity} onChange={e => setSeverity(e.target.value)} style={{ padding:"8px 10px", fontSize:12, color:T.slate700, border:`1px solid ${T.slate200}`, borderRadius:8, background:T.white, outline:"none" }}>
          <option value="all">All Severity</option>
          <option value="critical">Critical</option>
          <option value="warning">Warning</option>
          <option value="info">Info</option>
        </select>
      </div>

      <div style={{ fontSize:11, color:T.slate400, marginBottom:12 }}>
        Showing {filtered.length} of {libRules.length} rules
      </div>

      <div style={{ display:"flex", flexDirection:"column", gap:6 }}>
        {filtered.length === 0 && (
          <div style={{ textAlign:"center", padding:"30px 20px", color:T.slate400, fontSize:13 }}>
            No rules match these filters.
          </div>
        )}
        {filtered.map(rule => {
          const cat = cfgFor(rule.category);
          const sev = severityConfig(rule.severity);
          const isExpanded = expanded === rule.id;
          return (
            <div
              key={rule.id}
              style={{ background:T.white, border:`1px solid ${isExpanded?cat.color||T.slate200:T.slate200}`, borderLeft:`4px solid ${cat.color||T.slate300}`, borderRadius:10, overflow:"hidden", transition:"border-color 0.15s" }}
            >
              <div
                style={{ display:"flex", alignItems:"flex-start", justifyContent:"space-between", gap:10, padding:"12px 14px", cursor:"pointer" }}
                onClick={() => setExpanded(isExpanded ? null : rule.id)}
              >
                <div style={{ flex:1, minWidth:0 }}>
                  <div style={{ display:"flex", alignItems:"center", gap:8, marginBottom:4, flexWrap:"wrap" }}>
                    {rule.rule_code && <span style={{ fontSize:10, fontFamily:"monospace", color:T.slate400, background:T.slate100, padding:"2px 6px", borderRadius:4 }}>{rule.rule_code}</span>}
                    <span style={{ fontSize:10, color:cat.color||T.slate500 }}>{cat.icon} {cat.label}</span>
                    <span style={{ fontSize:10, fontWeight:600, padding:"2px 8px", borderRadius:20, background:sev.bg, color:sev.color }}>{sev.label}</span>
                  </div>
                  <div style={{ fontSize:13, fontWeight:600, color:T.slate800 }}>{rule.title}</div>
                </div>
                <span style={{ color:T.slate400, fontSize:14, flexShrink:0, marginTop:2 }}>{isExpanded ? "\u25b2" : "\u25bc"}</span>
              </div>

              {isExpanded && (
                <div style={{ padding:"0 14px 14px", borderTop:`1px solid ${T.slate100}` }}>
                  <div style={{ fontSize:12, color:T.slate700, lineHeight:1.7, marginTop:10, marginBottom:10, whiteSpace:"pre-wrap" }}>
                    {rule.description}
                  </div>
                  {rule.requirement && (
                    <div style={{ fontSize:11, color:T.slate600, background:T.slate50, padding:"8px 10px", borderRadius:6, marginBottom:10 }}>
                      <strong>Requirement:</strong> {rule.requirement}
                    </div>
                  )}
                  <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", flexWrap:"wrap", gap:8 }}>
                    <div style={{ fontSize:10, color:T.slate400 }}>
                      📜 <em>{rule.source || "(no source cited)"}</em>
                    </div>
                    <AskBtn size="small" context={`Compliance rule: ${rule.title} (${rule.rule_code || "no code"})\n\nDescription: ${rule.description}\n\nSource: ${rule.source || "(none)"}\n\nHelp me understand this rule and how it applies to my agency. What are the most common ways agents accidentally violate this?`} />
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
};

// ─── Section: Pre-Post Checklist ──────────────────────────────
const PrePostChecklist = ({ checklistRules }) => {
  const [checked, setChecked] = useState({});
  const [sessionDate] = useState(new Date().toLocaleDateString("en-US", { month:"long", day:"numeric", year:"numeric" }));

  const items = checklistRules; // already sorted by rule_code in main fetch

  const toggleCheck = (id) => setChecked(prev => ({ ...prev, [id]: !prev[id] }));
  const resetChecklist = () => setChecked({});

  const checkedCount = Object.values(checked).filter(Boolean).length;
  const total = items.length;
  const allPassed = total > 0 && checkedCount === total;
  const criticalItems = items.filter(i => i.severity === "critical");
  const criticalPassed = criticalItems.every(i => checked[i.id]);

  // Strip the "Pre-Post Check N — " prefix from the display title to keep it tight.
  const cleanTitle = (t) => (t || "").replace(/^Pre-Post Check\s+\d+\s+\u2014\s+/i, "");

  return (
    <div>
      <div style={{ display:"flex", justifyContent:"space-between", alignItems:"flex-start", marginBottom:16, gap:12, flexWrap:"wrap" }}>
        <div>
          <div style={{ fontSize:13, fontWeight:600, color:T.slate800 }}>Social Media Pre-Post Compliance Checklist</div>
          <div style={{ fontSize:11, color:T.slate500, marginTop:2 }}>
            Run every piece of content through all {total} items before publishing · {sessionDate}
          </div>
        </div>
        <div style={{ display:"flex", gap:8 }}>
          <AskBtn context={`I just completed the social media pre-post compliance checklist. ${checkedCount} of ${total} items passed. ${allPassed ? "All items cleared." : "Some items need attention."} Help me review any compliance concerns before I publish this content.`} />
          <button onClick={resetChecklist} style={{ padding:"7px 14px", fontSize:11, fontWeight:600, color:T.slate600, background:T.slate100, border:"none", borderRadius:7, cursor:"pointer" }}>Reset</button>
        </div>
      </div>

      <div style={{ background:T.white, border:`1px solid ${T.slate200}`, borderRadius:12, padding:"14px 18px", marginBottom:16 }}>
        <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:8, flexWrap:"wrap", gap:8 }}>
          <span style={{ fontSize:12, fontWeight:600, color:T.slate700 }}>{checkedCount} of {total} items verified</span>
          {allPassed
            ? <span style={{ fontSize:11, fontWeight:600, padding:"3px 10px", borderRadius:20, background:T.greenLt, color:"#065F46" }}>✓ All Clear — Safe to Post</span>
            : criticalPassed && criticalItems.length > 0
              ? <span style={{ fontSize:11, fontWeight:600, padding:"3px 10px", borderRadius:20, background:T.amberLt, color:"#92400E" }}>Critical Items Passed — Review Warnings</span>
              : <span style={{ fontSize:11, fontWeight:600, padding:"3px 10px", borderRadius:20, background:T.redLt, color:"#991B1B" }}>Do Not Post — Critical Items Pending</span>
          }
        </div>
        <div style={{ height:8, background:T.slate100, borderRadius:4, overflow:"hidden" }}>
          <div style={{ height:"100%", width: total>0 ? `${(checkedCount/total)*100}%` : "0%", background:allPassed?T.green:criticalPassed?T.amber:T.blue, borderRadius:4, transition:"width 0.3s ease" }} />
        </div>
      </div>

      {total === 0 && (
        <div style={{ textAlign:"center", padding:"30px 20px", color:T.slate400, fontSize:13 }}>
          No checklist rules loaded.
        </div>
      )}

      <div style={{ display:"flex", flexDirection:"column", gap:4 }}>
        {items.map((item, idx) => {
          const isChecked = !!checked[item.id];
          const isCritical = item.severity === "critical";
          return (
            <div
              key={item.id}
              onClick={() => toggleCheck(item.id)}
              style={{
                display:"flex", alignItems:"center", gap:12,
                padding:"10px 14px",
                background: isChecked ? (isCritical ? "#F0FDF4" : T.slate50) : T.white,
                border:`1px solid ${isChecked ? (isCritical ? "#BBF7D0" : T.slate200) : T.slate200}`,
                borderLeft:`4px solid ${isCritical ? T.red : T.amber}`,
                borderRadius:8, cursor:"pointer",
                transition:"all 0.12s",
                opacity: isChecked ? 0.75 : 1,
              }}
            >
              <div style={{
                width:20, height:20, borderRadius:5, flexShrink:0,
                border: isChecked ? "none" : `2px solid ${T.slate300}`,
                background: isChecked ? T.green : "transparent",
                display:"flex", alignItems:"center", justifyContent:"center",
                transition:"all 0.15s",
              }}>
                {isChecked && <span style={{ color:T.white, fontSize:12, lineHeight:1 }}>✓</span>}
              </div>

              <div style={{ flex:1, minWidth:0 }}>
                <div style={{ display:"flex", alignItems:"center", gap:6, flexWrap:"wrap" }}>
                  <span style={{ fontSize:10, color:T.slate400, fontWeight:500 }}>{String(idx+1).padStart(2,"0")}</span>
                  <span style={{ fontSize:12, fontWeight:isChecked?400:500, color:isChecked?T.slate400:T.slate800, textDecoration:isChecked?"line-through":"none" }}>
                    {cleanTitle(item.title)}
                  </span>
                </div>
              </div>

              <Pill type={item.severity}>{isCritical ? "Critical" : "Warning"}</Pill>
            </div>
          );
        })}
      </div>

      {allPassed && (
        <div style={{ marginTop:14, padding:"12px 16px", background:T.greenLt, border:`1px solid #BBF7D0`, borderRadius:10, fontSize:12, color:"#065F46" }}>
          ✓ All {total} compliance items verified. This content is cleared for publishing. Log this review in the Audit Log tab before posting.
        </div>
      )}
    </div>
  );
};

// ─── Section: Calendar ────────────────────────────────────────
const ComplianceCalendar = ({ calendar }) => {
  const [filter, setFilter] = useState("all");

  const filtered = calendar.filter(item => {
    if (filter === "all") return true;
    if (filter === "due")       return item.days_remaining != null && item.days_remaining <= 30;
    if (filter === "annual")    return item.recurrence === "annual";
    if (filter === "quarterly") return item.recurrence === "quarterly";
    if (filter === "monthly")   return item.recurrence === "monthly";
    return true;
  });

  return (
    <Card>
      <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:14, flexWrap:"wrap", gap:8 }}>
        <div>
          <div style={{ fontSize:13, fontWeight:600, color:T.slate800 }}>Compliance Calendar</div>
          <div style={{ fontSize:11, color:T.slate500, marginTop:2 }}>Annual and recurring compliance deadlines</div>
        </div>
        <AskBtn context="I am reviewing my compliance calendar. Help me prioritize the most urgent items and create an action plan for the next 90 days." />
      </div>

      <div style={{ display:"flex", gap:6, marginBottom:16, flexWrap:"wrap" }}>
        {[{id:"all",label:"All"},{id:"due",label:"Due Within 30 Days"},{id:"annual",label:"Annual"},{id:"quarterly",label:"Quarterly"},{id:"monthly",label:"Monthly"}].map(f => (
          <button key={f.id} onClick={() => setFilter(f.id)} style={{
            padding:"5px 12px", fontSize:11, fontWeight:filter===f.id?600:400,
            color:filter===f.id?T.white:T.slate600,
            background:filter===f.id?T.navy:T.white,
            border:`1px solid ${filter===f.id?T.navy:T.slate200}`,
            borderRadius:6, cursor:"pointer",
          }}>{f.label}</button>
        ))}
      </div>

      <div style={{ display:"flex", flexDirection:"column", gap:6 }}>
        {filtered.length === 0 && (
          <div style={{ textAlign:"center", padding:"24px 20px", color:T.slate400, fontSize:13 }}>
            No items in this view.
          </div>
        )}
        {filtered.map((item) => {
          const status = deriveStatus(item);
          const sc = statusConfig(status);
          const sev = severityConfig("warning");
          const overdue = (item.days_remaining ?? 0) < 0 && status !== "rolled_forward";
          const urgent  = !overdue && (item.days_remaining ?? 9999) <= 14;
          const dayBoxBg = overdue ? T.red : urgent ? T.amber : sev.bg;
          const dayBoxColor = (overdue || urgent) ? T.white : sev.color;
          return (
            <div key={item.id} style={{
              display:"flex", alignItems:"center", gap:12, padding:"12px 14px",
              background: overdue ? T.redLt : urgent ? T.amberLt : T.white,
              border:`1px solid ${overdue ? "#FECACA" : urgent ? "#FDE68A" : T.slate200}`,
              borderRadius:10
            }}>
              <div style={{ width:54, height:54, borderRadius:10, background:dayBoxBg, display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center", flexShrink:0 }}>
                <span style={{ fontSize:14, fontWeight:700, color:dayBoxColor, lineHeight:1 }}>
                  {item.days_remaining < 0 ? `+${Math.abs(item.days_remaining)}` : item.days_remaining}
                </span>
                <span style={{ fontSize:8, color:dayBoxColor, marginTop:1 }}>
                  {item.days_remaining < 0 ? "overdue" : "days"}
                </span>
              </div>
              <div style={{ flex:1, minWidth:0 }}>
                <div style={{ fontSize:13, fontWeight:600, color:overdue?T.red:T.slate800 }}>{item.title}</div>
                <div style={{ fontSize:10, color:T.slate400, marginTop:2 }}>
                  Due: {item.due_date}{item.recurrence ? ` \u00b7 ${item.recurrence.charAt(0).toUpperCase()+item.recurrence.slice(1)}` : ""}
                </div>
              </div>
              <span style={{ fontSize:10, fontWeight:600, padding:"3px 10px", borderRadius:20, background:sc.bg, color:sc.color }}>{sc.label}</span>
            </div>
          );
        })}
      </div>
    </Card>
  );
};

// ─── Section: Audit Log ───────────────────────────────────────
const AuditLog = ({ log, onAdd, saving }) => {
  const [newNote, setNewNote] = useState("");
  const [eventType, setEventType] = useState("review");

  const submit = async () => {
    if (!newNote.trim() || saving) return;
    await onAdd({ description: newNote.trim(), event_type: eventType });
    setNewNote("");
  };

  return (
    <Card>
      <div style={{ fontSize:13, fontWeight:600, color:T.slate800, marginBottom:14 }}>Compliance Audit Log</div>

      <div style={{ marginBottom:16, padding:"12px 14px", background:T.slate50, borderRadius:10, border:`1px solid ${T.slate200}` }}>
        <div style={{ fontSize:11, fontWeight:600, color:T.slate600, marginBottom:8 }}>LOG A COMPLIANCE ACTIVITY</div>
        <textarea
          value={newNote}
          onChange={e => setNewNote(e.target.value)}
          placeholder="Describe the compliance activity, review, or action taken..."
          rows={2}
          style={{ width:"100%", padding:"8px 10px", fontSize:12, color:T.slate800, border:`1px solid ${T.slate200}`, borderRadius:8, outline:"none", resize:"vertical", fontFamily:"inherit", lineHeight:1.6, boxSizing:"border-box" }}
        />
        <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginTop:8, gap:8, flexWrap:"wrap" }}>
          <select value={eventType} onChange={e => setEventType(e.target.value)} style={{ padding:"6px 8px", fontSize:11, color:T.slate700, border:`1px solid ${T.slate200}`, borderRadius:6, background:T.white }}>
            <option value="review">Review</option>
            <option value="completed">Completed</option>
            <option value="claude_pushback">Claude pushback</option>
            <option value="violation_flagged">Violation flagged</option>
            <option value="acknowledged">Acknowledged</option>
            <option value="manual_note">Manual note</option>
          </select>
          <button
            onClick={submit}
            disabled={!newNote.trim() || saving}
            style={{ padding:"6px 14px", fontSize:11, fontWeight:600, color:T.white, background:T.navy, border:"none", borderRadius:7, cursor:(newNote.trim() && !saving)?"pointer":"not-allowed", opacity:(newNote.trim() && !saving)?1:0.5 }}
          >{saving ? "Logging\u2026" : "Log Activity"}</button>
        </div>
      </div>

      <div style={{ display:"flex", flexDirection:"column", gap:0 }}>
        {log.length === 0 && (
          <div style={{ textAlign:"center", padding:"24px 20px", color:T.slate400, fontSize:13 }}>
            No activity logged yet. Add the first entry above.
          </div>
        )}
        {log.map((entry,i) => {
          const ec = eventConfig(entry.event_type);
          return (
            <div key={entry.id} style={{ display:"flex", gap:12, padding:"10px 0", borderBottom:i<log.length-1?`1px solid ${T.slate100}`:"none" }}>
              <div style={{ width:32, height:32, borderRadius:8, background:T.slate50, border:`1px solid ${T.slate200}`, display:"flex", alignItems:"center", justifyContent:"center", flexShrink:0, fontSize:14 }}>
                {ec.icon}
              </div>
              <div style={{ flex:1, minWidth:0 }}>
                <div style={{ fontSize:12, color:T.slate800, lineHeight:1.5 }}>{entry.description}</div>
                <div style={{ fontSize:10, color:T.slate400, marginTop:3 }}>
                  {fmtDate(entry.created_at)} · {entry.created_by || "system"} · {(entry.event_type || "").replace(/_/g," ")}
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </Card>
  );
};

// ─── Main Compliance Center Module ───────────────────────────
export default function ComplianceCenter() {
  const [section, setSection] = useState("dashboard");

  const [rules,    setRules]    = useState([]);
  const [calendar, setCalendar] = useState([]);
  const [log,      setLog]      = useState([]);
  const [loading,  setLoading]  = useState(true);
  const [errorMsg, setErrorMsg] = useState(null);
  const [saving,   setSaving]   = useState(false);

  // Add Custom Rule modal state
  const [showAddRule, setShowAddRule] = useState(false);
  const [newRule, setNewRule] = useState({ title:"", category:"", description:"", severity:"info", rule_code:"", source:"" });

  const loadAll = useCallback(async () => {
    setLoading(true); setErrorMsg(null);
    try {
      const [rulesRes, calRes, logRes] = await Promise.all([
        supabase.from("compliance_rules")
          .select("id, rule_code, category, title, description, requirement, source, severity, is_active, effective_date, expiration_date, created_at")
          .eq("agency_id", AGENCY_ID)
          .neq("is_active", false)
          .order("rule_code", { ascending: true }),
        supabase.from("compliance_calendar")
          .select("id, compliance_rule_id, title, description, due_date, recurrence, status, completed_at, completed_by, alert_days_before, created_at")
          .eq("agency_id", AGENCY_ID)
          .order("due_date", { ascending: true }),
        supabase.from("compliance_log")
          .select("id, compliance_rule_id, event_type, description, conversation_reference, created_by, created_at")
          .eq("agency_id", AGENCY_ID)
          .order("created_at", { ascending: false })
          .limit(200),
      ]);
      if (rulesRes.error) throw rulesRes.error;
      if (calRes.error)   throw calRes.error;
      if (logRes.error)   throw logRes.error;

      const allRules = Array.isArray(rulesRes.data) ? rulesRes.data : [];
      setRules(allRules);

      // Compute days_remaining client-side, and HIDE [OFFICE]-prefixed items
      // (per operational rule: office staff handle PFA, not the agent-facing BCC).
      const calRaw = Array.isArray(calRes.data) ? calRes.data : [];
      const calClean = calRaw
        .filter(c => !(c.title || "").startsWith("[OFFICE]"))
        .map(c => ({ ...c, days_remaining: daysFromToday(c.due_date) }));
      setCalendar(calClean);

      setLog(Array.isArray(logRes.data) ? logRes.data : []);
    } catch (e) {
      setErrorMsg(e?.message || "Failed to load compliance data.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadAll(); }, [loadAll]);

  const checklistRules = useMemo(
    () => rules.filter(r => r.category === "social_media_checklist"),
    [rules]
  );

  // Save Custom Rule
  const saveRule = async () => {
    if (!newRule.title.trim() || !newRule.description.trim() || !newRule.category.trim()) return;
    setSaving(true); setErrorMsg(null);
    try {
      const { error } = await supabase.from("compliance_rules").insert([{
        agency_id: AGENCY_ID,
        rule_code: newRule.rule_code.trim() || `CUSTOM-${Date.now().toString().slice(-6)}`,
        category:  newRule.category.trim(),
        title:     newRule.title.trim(),
        description: newRule.description.trim(),
        severity:  newRule.severity,
        source:    newRule.source.trim() || "Agency custom rule",
        is_active: true,
      }]);
      if (error) throw error;
      setShowAddRule(false);
      setNewRule({ title:"", category:"", description:"", severity:"info", rule_code:"", source:"" });
      await loadAll();
    } catch (e) {
      setErrorMsg(e?.message || "Save failed.");
    } finally {
      setSaving(false);
    }
  };

  // Add Audit Log Entry
  const addLogEntry = async ({ description, event_type }) => {
    setSaving(true); setErrorMsg(null);
    try {
      const { error } = await supabase.from("compliance_log").insert([{
        agency_id: AGENCY_ID,
        event_type,
        description,
        created_by: "Kwame Tyler",
      }]);
      if (error) throw error;
      await loadAll();
    } catch (e) {
      setErrorMsg(e?.message || "Log failed.");
    } finally {
      setSaving(false);
    }
  };

  const totalRules = rules.length;

  const sections = [
    { id:"dashboard", label:"Dashboard" },
    { id:"rules",     label:`Rules Library (${totalRules})` },
    { id:"checklist", label:"Pre-Post Checklist" },
    { id:"calendar",  label:"Calendar" },
    { id:"log",       label:"Audit Log" },
  ];

  return (
    <div>
      <div style={{ display:"flex", alignItems:"flex-start", justifyContent:"space-between", marginBottom:16, gap:12, flexWrap:"wrap" }}>
        <div>
          <div style={{ fontSize:20, fontWeight:700, color:T.slate900, letterSpacing:"-0.02em" }}>Compliance Center</div>
          <div style={{ fontSize:12, color:T.slate500, marginTop:3 }}>
            {loading ? "Loading\u2026" : `${totalRules} rules \u00b7 AA05 contract-based \u00b7 Claude enforces these in every conversation`}
          </div>
        </div>
        <AskBtn context="I am reviewing my compliance center. I need you to act as my compliance advisor. What are the most critical compliance items I should be focused on right now as a State Farm agent? What are the most common compliance mistakes agents make?" />
      </div>

      {/* AA05 Notice */}
      <div style={{ background:T.blueLt, border:`1px solid ${T.blue}20`, borderLeft:`4px solid ${T.blue}`, borderRadius:10, padding:"12px 16px", marginBottom:16, display:"flex", alignItems:"flex-start", gap:12 }}>
        <span style={{ fontSize:18, flexShrink:0 }}>📜</span>
        <div>
          <div style={{ fontSize:12, fontWeight:600, color:T.navy, marginBottom:2 }}>
            These rules are grounded in your AA05 Agent Agreement
          </div>
          <div style={{ fontSize:11, color:T.slate600, lineHeight:1.6 }}>
            Every compliance rule in this library cites the AA05 clause or regulatory requirement that makes it binding. Your Claude uses this library as guardrails in every conversation — it will push back when you ask it to generate non-compliant content, and it will explain exactly which contract clause applies.
          </div>
        </div>
      </div>

      {errorMsg && (
        <div style={{ background:T.redLt, border:`1px solid ${T.red}40`, borderLeft:`4px solid ${T.red}`, borderRadius:10, padding:"10px 14px", marginBottom:16, fontSize:12, color:"#991B1B" }}>
          {errorMsg}
        </div>
      )}

      {/* Section Navigation */}
      <div style={{ display:"flex", gap:2, flexWrap:"wrap", background:T.slate100, borderRadius:10, padding:4, marginBottom:18 }}>
        {sections.map(s => (
          <button key={s.id} onClick={() => setSection(s.id)} style={{ padding:"7px 14px", fontSize:12, fontWeight:section===s.id?600:400, color:section===s.id?T.slate900:T.slate500, background:section===s.id?T.white:"transparent", border:"none", borderRadius:7, cursor:"pointer", transition:"all 0.12s", boxShadow:section===s.id?"0 1px 3px rgba(0,0,0,0.08)":"none" }}>
            {s.label}
          </button>
        ))}
      </div>

      {/* Action Buttons */}
      <div style={{ display:"flex", justifyContent:"flex-end", marginBottom:12 }}>
        {section === "rules" && (
          <button
            onClick={() => setShowAddRule(v => !v)}
            style={{ padding:"7px 16px", fontSize:12, fontWeight:600, background:T.navy, color:T.white, border:"none", borderRadius:8, cursor:"pointer", display:"flex", alignItems:"center", gap:6 }}
          >
            ➕ Add Custom Rule
          </button>
        )}
      </div>

      {/* Add Custom Rule Form */}
      {showAddRule && (
        <div style={{ background:T.navyLt, border:`1px solid ${T.blue}30`, borderRadius:10, padding:16, marginBottom:16 }}>
          <div style={{ fontSize:13, fontWeight:700, color:T.navy, marginBottom:12 }}>Add Custom Compliance Rule</div>
          <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:10, marginBottom:10 }}>
            <input
              placeholder="Rule title *"
              value={newRule.title}
              onChange={e=>setNewRule({...newRule, title:e.target.value})}
              style={{ padding:"8px 10px", borderRadius:6, border:`1px solid ${T.slate300}`, fontSize:12, gridColumn:"1/-1" }}
            />
            <select
              value={newRule.category}
              onChange={e=>setNewRule({...newRule, category:e.target.value})}
              style={{ padding:"8px 10px", borderRadius:6, border:`1px solid ${T.slate300}`, fontSize:12 }}
            >
              <option value="">Select category *</option>
              {Object.keys(CATEGORY_CONFIG).filter(c => c !== "social_media_checklist").map(c => (
                <option key={c} value={c}>{cfgFor(c).label}</option>
              ))}
            </select>
            <select
              value={newRule.severity}
              onChange={e=>setNewRule({...newRule, severity:e.target.value})}
              style={{ padding:"8px 10px", borderRadius:6, border:`1px solid ${T.slate300}`, fontSize:12 }}
            >
              <option value="info">Info</option>
              <option value="warning">Warning</option>
              <option value="critical">Critical</option>
            </select>
            <input
              placeholder="Rule code (optional, e.g. AGENCY-001)"
              value={newRule.rule_code}
              onChange={e=>setNewRule({...newRule, rule_code:e.target.value})}
              style={{ padding:"8px 10px", borderRadius:6, border:`1px solid ${T.slate300}`, fontSize:12 }}
            />
            <input
              placeholder="Source / citation (optional)"
              value={newRule.source}
              onChange={e=>setNewRule({...newRule, source:e.target.value})}
              style={{ padding:"8px 10px", borderRadius:6, border:`1px solid ${T.slate300}`, fontSize:12 }}
            />
            <textarea
              placeholder="Description / requirement *"
              value={newRule.description}
              onChange={e=>setNewRule({...newRule, description:e.target.value})}
              rows={3}
              style={{ padding:"8px 10px", borderRadius:6, border:`1px solid ${T.slate300}`, fontSize:12, gridColumn:"1/-1", resize:"vertical", fontFamily:"inherit" }}
            />
          </div>
          <div style={{ display:"flex", gap:8, justifyContent:"flex-end" }}>
            <button onClick={()=>setShowAddRule(false)} disabled={saving} style={{ padding:"6px 14px", fontSize:12, background:T.slate100, color:T.slate700, border:"none", borderRadius:6, cursor:saving?"not-allowed":"pointer" }}>Cancel</button>
            <button onClick={saveRule} disabled={saving || !newRule.title.trim() || !newRule.description.trim() || !newRule.category} style={{ padding:"6px 14px", fontSize:12, background:T.navy, color:T.white, border:"none", borderRadius:6, cursor:"pointer", fontWeight:600, opacity:(saving || !newRule.title.trim() || !newRule.description.trim() || !newRule.category)?0.5:1 }}>{saving ? "Saving\u2026" : "Save Rule"}</button>
          </div>
        </div>
      )}

      {/* Section content */}
      {loading && (
        <div style={{ textAlign:"center", padding:"40px 20px", color:T.slate400, fontSize:13 }}>Loading compliance data…</div>
      )}
      {!loading && section === "dashboard" && <ComplianceDashboard rules={rules} calendar={calendar} log={log} />}
      {!loading && section === "rules"     && <RulesLibrary rules={rules} />}
      {!loading && section === "checklist" && <PrePostChecklist checklistRules={checklistRules} />}
      {!loading && section === "calendar"  && <ComplianceCalendar calendar={calendar} />}
      {!loading && section === "log"       && <AuditLog log={log} onAdd={addLogEntry} saving={saving} />}
    </div>
  );
}
