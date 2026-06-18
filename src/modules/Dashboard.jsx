import { useState, useEffect } from "react";
import { supabase, AGENCY_ID } from "../lib/supabase.js";

// ── Design Tokens ──────────────────────────────────────────────
const T = {
  navy:"#1E3A5F", blue:"#2563EB", green:"#16A34A", amber:"#D97706",
  red:"#DC2626", slate900:"#0F172A", slate800:"#1E293B", slate700:"#334155",
  slate600:"#475569", slate500:"#64748B", slate400:"#94A3B8", slate300:"#CBD5E1",
  slate200:"#E2E8F0", slate100:"#F1F5F9", slate50:"#F8FAFC", white:"#FFFFFF",
  greenLt:"#DCFCE7", amberLt:"#FEF3C7", redLt:"#FEE2E2", blueLt:"#DBEAFE",
  navyLt:"#EFF6FF",
};

const fmt = v => { const n=parseFloat(v); return isNaN(n)?"$0.00":"$"+Math.abs(n).toLocaleString("en-US",{minimumFractionDigits:2,maximumFractionDigits:2}); };
const pct = (v,m) => (((parseFloat(v)||0)/(parseFloat(m)||1))*100).toFixed(1);

// ── Mini Components ────────────────────────────────────────────
const Card = ({children, style={}}) => (
  <div style={{background:T.white, borderRadius:12, border:`1px solid ${T.slate200}`, padding:"16px 18px", ...style}}>
    {children}
  </div>
);

const SectionTitle = ({icon, title, action}) => (
  <div style={{display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:14}}>
    <div style={{display:"flex", alignItems:"center", gap:8}}>
      <span style={{fontSize:16}}>{icon}</span>
      <span style={{fontSize:13, fontWeight:700, color:T.slate800}}>{title}</span>
    </div>
    {action}
  </div>
);

const Badge = ({type="info", children}) => {
  const styles = {
    info:    {bg:T.blueLt,  color:T.blue},
    success: {bg:T.greenLt, color:T.green},
    warning: {bg:T.amberLt, color:T.amber},
    danger:  {bg:T.redLt,   color:T.red},
  };
  const s = styles[type] || styles.info;
  return (
    <span style={{display:"inline-flex", alignItems:"center", padding:"2px 8px", borderRadius:20, fontSize:10, fontWeight:700, background:s.bg, color:s.color}}>
      {children}
    </span>
  );
};

const EmptyRow = ({message}) => (
  <div style={{padding:"20px 0", textAlign:"center", color:T.slate400, fontSize:12}}>{message}</div>
);

const ProgressBar = ({value, max, color=T.blue, height=6}) => {
  const pctVal = Math.min(100, Math.max(0, ((parseFloat(value)||0)/(parseFloat(max)||1))*100));
  return (
    <div style={{background:T.slate100, borderRadius:99, height, overflow:"hidden"}}>
      <div style={{width:`${pctVal}%`, background:color, height:"100%", borderRadius:99, transition:"width 0.5s ease"}} />
    </div>
  );
};

// ── Widget: Financial KPIs (Option C — federal YTD, YoY, P&C, annual pace) ─────
// Reads from data.financialKpis which is computed in loadDashboard() from
// comp_recap.ytd_snapshot aggregates (NOT from v_income_statement, which only
// holds post-cutover GL data). This gives the agent the truthful federal-reported
// income picture rather than the partial post-cutover ledger.
const FinancialWidget = ({ data, onNavigate }) => {
  const k = data.financialKpis || {};
  const hasData = (k.federalYtd2026 || 0) > 0;
  const yoy = k.yoyPct;
  const yoyColor = !Number.isFinite(yoy) ? T.slate500 : yoy >= 0 ? T.green : T.red;
  const yoyArrow = !Number.isFinite(yoy) ? "" : yoy >= 0 ? "↑" : "↓";
  const yoyText = !Number.isFinite(yoy) ? "—" : `${yoyArrow} ${yoy >= 0 ? "+" : ""}${yoy.toFixed(1)}%`;
  const pcYoy = k.pcYoyPct;
  const pcYoyText = !Number.isFinite(pcYoy) ? "" : ` (${pcYoy >= 0 ? "+" : ""}${pcYoy.toFixed(1)}% YoY)`;
  const recapDate = k.latestRecapDate
    ? new Date(k.latestRecapDate + "T12:00:00Z").toLocaleDateString("en-US",{month:"short", day:"numeric", year:"numeric"})
    : null;
  const paceVsLast = !Number.isFinite(k.annualPace2026) || !Number.isFinite(k.federalFull2025) || k.federalFull2025 === 0
    ? ""
    : ` vs ${fmt(k.federalFull2025).replace(".00","")}`;
  const cells = [
    {
      label: "Federal YTD",
      value: fmt(k.federalYtd2026),
      sub: recapDate ? `as of ${recapDate}` : "no recap loaded",
      color: T.navy, border: T.navy,
    },
    {
      label: recapDate ? `vs ${new Date((k.latestRecapDate||"").replace(/^2026/,"2025") + "T12:00:00Z").toLocaleDateString("en-US",{month:"short",day:"numeric",year:"numeric"})}` : "vs 2025 same period",
      value: yoyText,
      sub: Number.isFinite(k.federalYtd2025) ? `${fmt(k.federalYtd2025)} last year` : "",
      color: yoyColor, border: yoyColor,
    },
    {
      label: "P&C Premium YTD",
      value: fmt(k.pcYtd2026),
      sub: `AIPP base${pcYoyText}`,
      color: T.blue, border: T.blue,
    },
    {
      label: "2026 Annual Pace",
      value: fmt(k.annualPace2026),
      sub: `empirical${paceVsLast}`,
      color: T.green, border: T.green,
    },
  ];
  return (
    <Card>
      <SectionTitle icon="💰" title="Financial Overview"
        action={<button onClick={()=>onNavigate("financials")} style={{fontSize:11,color:T.blue,background:"none",border:"none",cursor:"pointer",fontWeight:600}}>View Full P&L →</button>}
      />
      {!hasData ? (
        <EmptyRow message="No comp_recap data yet — once the Document Processor ingests recaps, KPIs populate here." />
      ) : (
        <div style={{display:"grid", gridTemplateColumns:"1fr 1fr", gap:10}}>
          {cells.map((c,i) => (
            <div key={i} style={{padding:"10px 12px", borderRadius:8, border:`1px solid ${c.border}20`, background:`${c.border}08`}}>
              <div style={{fontSize:10, color:T.slate500, marginBottom:4, fontWeight:600, lineHeight:1.2}}>{c.label}</div>
              <div style={{fontSize:18, fontWeight:800, color:c.color, lineHeight:1.1}}>{c.value}</div>
              {c.sub && <div style={{fontSize:9, color:T.slate400, marginTop:3, fontWeight:500}}>{c.sub}</div>}
            </div>
          ))}
        </div>
      )}
    </Card>
  );
};

// ── Widget: AIPP Progress ──────────────────────────────────────
const AIPPWidget = ({ data, onNavigate }) => {
  const a = data.aipp || {};
  const earned = parseFloat(a.earned)||0;
  const target = parseFloat(a.target)||1;
  const achievement = pct(earned, target);
  return (
    <Card>
      <SectionTitle icon="🏆" title={`AIPP ${a.year||2026} Progress`}
        action={<button onClick={()=>onNavigate("financials")} style={{fontSize:11,color:T.blue,background:"none",border:"none",cursor:"pointer",fontWeight:600}}>Details →</button>}
      />
      <div style={{display:"flex", justifyContent:"space-between", alignItems:"flex-end", marginBottom:8}}>
        <div>
          <div style={{fontSize:28, fontWeight:800, color:parseFloat(achievement)>=80?T.green:T.amber}}>{achievement}%</div>
          <div style={{fontSize:11, color:T.slate500}}>{fmt(earned)} of {fmt(target)} target</div>
        </div>
        <div style={{textAlign:"right"}}>
          <div style={{fontSize:11, color:T.slate500}}>Projected</div>
          <div style={{fontSize:16, fontWeight:700, color:T.navy}}>{fmt(a.projected)}</div>
        </div>
      </div>
      <ProgressBar value={earned} max={target} color={parseFloat(achievement)>=80?T.green:T.amber} height={8} />
    </Card>
  );
};

// ── Widget: Monthly Close Progress ────────────────────────────
// Visual checklist: closed months shown as compact pills, current month shows
// item-by-item received/outstanding with the actual document labels.
const MonthlyCloseWidget = ({ data, onNavigate }) => {
  const checklist = data.closeChecklist || [];
  const monthName = (y, m) => new Date(y, m-1, 1).toLocaleDateString("en-US",{month:"short", year:"numeric"});
  const monthLong = (y, m) => new Date(y, m-1, 1).toLocaleDateString("en-US",{month:"long", year:"numeric"});

  // Group rows by year-month
  const groups = {};
  for (const row of checklist) {
    const key = `${row.period_year}-${String(row.period_month).padStart(2,"0")}`;
    if (!groups[key]) groups[key] = { year: row.period_year, month: row.period_month, items: [], is_closed: row.is_closed };
    groups[key].items.push(row);
    if (row.is_closed) groups[key].is_closed = true;
  }
  const sortedKeys = Object.keys(groups).sort().reverse();
  const periods = sortedKeys.map(k => groups[k]);

  // Empty state
  if (periods.length === 0) {
    return (
      <Card>
        <SectionTitle icon="📅" title="Monthly Close" />
        <div style={{padding:"16px 0", fontSize:12, color:T.slate400, textAlign:"center"}}>
          Ask your Claude to set up your monthly close checklist
        </div>
      </Card>
    );
  }

  const current = periods.find(p => !p.is_closed) || periods[0];
  const closedMonths = periods.filter(p => p.is_closed).slice(0, 4);

  const received = current.items.filter(i => i.received_at).length;
  const total = current.items.length;
  const allReceived = received === total && total > 0;
  const outstandingItems = current.items.filter(i => !i.received_at);
  const receivedItems = current.items.filter(i => i.received_at);
  const formatDate = (d) => d ? new Date(d).toLocaleDateString("en-US",{month:"short",day:"numeric"}) : "";

  return (
    <Card>
      <SectionTitle icon="📅" title={`Monthly Close — ${monthLong(current.year, current.month)}`}
        action={<button onClick={()=>onNavigate("documents")} style={{fontSize:11,color:T.blue,background:"none",border:"none",cursor:"pointer",fontWeight:600}}>View All →</button>}
      />

      {/* Summary header */}
      <div style={{display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:10}}>
        <div style={{fontSize:13, color:T.slate700}}>
          <span style={{fontWeight:700, color:allReceived?T.green:T.amber}}>{received}</span>
          <span style={{color:T.slate400}}> / {total} documents received</span>
        </div>
        <Badge type={allReceived?"success":"warning"}>{allReceived?"Ready to Close":"In Progress"}</Badge>
      </div>
      <ProgressBar value={received} max={total} color={allReceived?T.green:T.amber} height={6} />

      {/* Item-by-item checklist for current month */}
      <div style={{marginTop:12, display:"flex", flexDirection:"column", gap:5}}>
        {receivedItems.map((item, i) => (
          <div key={`r${i}`} style={{display:"flex", alignItems:"center", justifyContent:"space-between", fontSize:11, padding:"5px 8px", borderRadius:6, background:T.greenLt}}>
            <div style={{display:"flex", alignItems:"center", gap:7, minWidth:0, flex:1}}>
              <span style={{color:T.green, fontSize:13, lineHeight:1}}>✓</span>
              <span style={{color:T.slate800, fontWeight:500, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap"}}>{item.doc_label}</span>
            </div>
            <span style={{color:T.slate500, fontSize:10, flexShrink:0, marginLeft:8}}>{formatDate(item.received_at)}</span>
          </div>
        ))}
        {outstandingItems.map((item, i) => (
          <div key={`o${i}`} style={{display:"flex", alignItems:"center", justifyContent:"space-between", fontSize:11, padding:"5px 8px", borderRadius:6, background:T.amberLt}}>
            <div style={{display:"flex", alignItems:"center", gap:7, minWidth:0, flex:1}}>
              <span style={{color:T.amber, fontSize:13, lineHeight:1}}>○</span>
              <span style={{color:T.slate800, fontWeight:500, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap"}}>{item.doc_label}</span>
            </div>
            <span style={{color:T.amber, fontSize:10, fontWeight:600, flexShrink:0, marginLeft:8}}>
              Expected {formatDate(item.expected_by)}
            </span>
          </div>
        ))}
      </div>

      {/* Closed prior months — compact strip */}
      {closedMonths.length > 0 && (
        <div style={{marginTop:14, paddingTop:10, borderTop:`1px dashed ${T.slate200}`}}>
          <div style={{fontSize:10, color:T.slate500, fontWeight:600, marginBottom:6, letterSpacing:"0.04em", textTransform:"uppercase"}}>
            Recently Closed
          </div>
          <div style={{display:"flex", gap:6, flexWrap:"wrap"}}>
            {closedMonths.map((p, i) => (
              <div key={i} style={{display:"flex", alignItems:"center", gap:5, padding:"3px 8px", borderRadius:12, background:T.green, color:"#fff", fontSize:10, fontWeight:600}}>
                <span>✓</span>
                <span>{monthName(p.year, p.month)}</span>
                <span style={{opacity:0.75, fontSize:9, fontWeight:500}}>{p.items.length}/{p.items.length}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </Card>
  );
};

// ── Widget: High Priority Tasks ───────────────────────────────
const TasksWidget = ({ data, onNavigate }) => {
  const tasks = (data.tasks || [])
    .filter(t => t.priority === "high" && t.status !== "completed")
    .slice(0, 5);
  return (
    <Card>
      <SectionTitle icon="✅" title="High Priority Tasks"
        action={<button onClick={()=>onNavigate("tasks")} style={{fontSize:11,color:T.blue,background:"none",border:"none",cursor:"pointer",fontWeight:600}}>All Tasks →</button>}
      />
      {tasks.length === 0 ? (
        <EmptyRow message="No high priority tasks — you're clear! ✨" />
      ) : (
        <div style={{display:"flex", flexDirection:"column", gap:8}}>
          {tasks.map((t,i) => (
            <div key={i} style={{display:"flex", justifyContent:"space-between", alignItems:"center", padding:"8px 10px", borderRadius:8, background:T.slate50, border:`1px solid ${T.slate200}`}}>
              <div>
                <div style={{fontSize:12, fontWeight:600, color:T.slate800}}>{t.title||t.task_title}</div>
                {t.due_date && <div style={{fontSize:10, color:T.slate500, marginTop:2}}>Due: {t.due_date}</div>}
              </div>
              <Badge type="danger">High</Badge>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
};

// ── Widget: Open Items (Claude waiting on answers) ────────────
const OpenItemsWidget = ({ data, onNavigate }) => {
  const openItems = (data.openItems || data.persistentMemory || [])
    .filter(m => m.memory_type === "open_item" || m.needs_followup === true || m.is_active === true || m.status === "pending_agent_input")
    .slice(0, 5);
  return (
    <Card>
      <SectionTitle icon="🔍" title="Open Items — Claude Needs Your Input"
        action={<button onClick={()=>onNavigate("memory")} style={{fontSize:11,color:T.blue,background:"none",border:"none",cursor:"pointer",fontWeight:600}}>View All →</button>}
      />
      {openItems.length === 0 ? (
        <EmptyRow message="No open items — Claude has everything it needs ✨" />
      ) : (
        <div style={{display:"flex", flexDirection:"column", gap:8}}>
          {openItems.map((item,i) => (
            <div key={i} style={{padding:"8px 10px", borderRadius:8, background:T.amberLt, border:`1px solid #FDE68A`}}>
              <div style={{fontSize:12, fontWeight:600, color:"#92400E"}}>{item.title||item.content?.slice(0,60)||"Pending item"}</div>
              {item.context && <div style={{fontSize:10, color:"#B45309", marginTop:2}}>{item.context.slice(0,80)}</div>}
            </div>
          ))}
        </div>
      )}
    </Card>
  );
};

// ── Widget: Active Alerts ─────────────────────────────────────
const AlertsWidget = ({ data, onNavigate }) => {
  const alerts = (data.alerts || [])
    .filter(a => !a.is_resolved)
    .sort((a,b) => {
      const sev = {critical:0, warning:1, info:2};
      return (sev[a.severity]||2) - (sev[b.severity]||2);
    })
    .slice(0, 4);
  return (
    <Card>
      <SectionTitle icon="🔔" title="Active Alerts"
        action={<button onClick={()=>onNavigate("alerts")} style={{fontSize:11,color:T.blue,background:"none",border:"none",cursor:"pointer",fontWeight:600}}>All Alerts →</button>}
      />
      {alerts.length === 0 ? (
        <div style={{display:"flex", alignItems:"center", gap:10, padding:"12px 0"}}>
          <span style={{fontSize:24}}>✅</span>
          <div>
            <div style={{fontSize:13, fontWeight:600, color:T.green}}>All Clear</div>
            <div style={{fontSize:11, color:T.slate500}}>No active alerts requiring attention</div>
          </div>
        </div>
      ) : (
        <div style={{display:"flex", flexDirection:"column", gap:8}}>
          {alerts.map((a,i) => (
            <div key={i} style={{display:"flex", justifyContent:"space-between", alignItems:"flex-start", padding:"8px 10px", borderRadius:8, background:a.severity==="critical"?T.redLt:a.severity==="warning"?T.amberLt:T.blueLt, border:`1px solid ${a.severity==="critical"?"#FCA5A5":a.severity==="warning"?"#FDE68A":"#BFDBFE"}`}}>
              <div style={{flex:1}}>
                <div style={{fontSize:12, fontWeight:600, color:a.severity==="critical"?T.red:a.severity==="warning"?T.amber:T.blue}}>{a.title}</div>
                {a.due_date && <div style={{fontSize:10, color:T.slate600, marginTop:2}}>Due: {a.due_date}</div>}
              </div>
              <Badge type={a.severity==="critical"?"danger":a.severity==="warning"?"warning":"info"}>
                {a.severity}
              </Badge>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
};

// ── Widget: Compliance Summary ────────────────────────────────
const ComplianceWidget = ({ data, onNavigate }) => {
  const rules = data.complianceRules || [];
  // v2: violations are ONLY rows with status='violation' — is_active means the rule is in
  // force, not that it's been violated. All 76 SF compliance_rules are active by design.
  const violations = rules.filter(r => r.status === "violation").length;
  const pending = rules.filter(r => r.status === "pending_review").length;
  const compliant = rules.filter(r => r.status === "compliant" || (r.is_active && !r.status)).length;
  const total = rules.length;

  return (
    <Card>
      <SectionTitle icon="⚖️" title="Compliance Status"
        action={<button onClick={()=>onNavigate("compliance")} style={{fontSize:11,color:T.blue,background:"none",border:"none",cursor:"pointer",fontWeight:600}}>Review →</button>}
      />
      {total === 0 ? (
        <div style={{fontSize:11, color:T.amber, textAlign:"center", padding:"12px 0"}}>
          ⚠️ Compliance rules not seeded yet<br/>
          <span style={{color:T.slate500}}>Ask Claude: "Seed my SF compliance rules"</span>
        </div>
      ) : (
        <div style={{display:"grid", gridTemplateColumns:"1fr 1fr 1fr", gap:8}}>
          {[
            {label:"Compliant", value:compliant, color:T.green, bg:T.greenLt},
            {label:"Pending",   value:pending,   color:T.amber, bg:T.amberLt},
            {label:"Violations",value:violations,color:T.red,   bg:T.redLt},
          ].map((s,i) => (
            <div key={i} style={{textAlign:"center", padding:"10px 8px", borderRadius:8, background:s.bg}}>
              <div style={{fontSize:22, fontWeight:800, color:s.color}}>{s.value}</div>
              <div style={{fontSize:10, color:T.slate600, fontWeight:600}}>{s.label}</div>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
};

// ── Main Dashboard Component ───────────────────────────────────
export default function Dashboard({ onNavigate = () => {} }) {
  const [dashData, setDashData] = useState({});
  const [loading, setLoading] = useState(true);
  const [agencyName, setAgencyName] = useState("Your Agency");
  const [greeting, setGreeting] = useState("Good morning");

  useEffect(() => {
    const hr = new Date().getHours();
    setGreeting(hr < 12 ? "Good morning" : hr < 17 ? "Good afternoon" : "Good evening");
  }, []);

  useEffect(() => {
    async function loadDashboard() {
      setLoading(true);
      try {
        // Parallel fetch all dashboard data
        const [
          agencyRes, summaryRes, aippRes, tasksRes,
          alertsRes, memoryRes, complianceRes, closeRes, closeChecklistRes
        ] = await Promise.allSettled([
          supabase.from("agency").select("*").limit(1).single(),
          Promise.resolve({ data: null }), // removed — no comp_recap_data  table
          //Promise.resolve({ data: null }), // comp_recap_data  removed — no such table in schema
          supabase.from("aipp_tracking").select("*").order("program_year",{ascending:false}).limit(1).single(),
          supabase.from("tasks").select("*").eq("status","open").order("priority").limit(20),
          supabase.from("alerts").select("*").eq("is_resolved",false).order("created_at",{ascending:false}).limit(10),
          supabase.from("persistent_memory").select("*").eq("is_active",true).order("updated_at",{ascending:false}).limit(10),
          supabase.from("compliance_rules").select("id,title,severity,is_active").limit(100),
          supabase.from("documents").select("*").order("created_at",{ascending:false}).limit(20),
          supabase.from("monthly_close_checklist").select("*").order("period_year",{ascending:false}).order("period_month",{ascending:false}).limit(60),
        ]);

        const agency = agencyRes.status==="fulfilled" ? agencyRes.value.data : null;
        if (agency?.name) setAgencyName(agency.name);

        // ── Comp_recap-driven KPIs (Option C) ───────────────────────────
        // Federal-reported income comes from comp_recap.ytd_snapshot (the truthful
        // SF compensation, includes pre-cutover history). v_income_statement
        // only holds post-cutover GL entries and would understate real YTD.
        // Pull latest 2026 + same-period 2025 + full-year 2025 in parallel for
        // YoY + annual pace.
        const PC_TYPES = ["MUTL","FIRE","STDAUTO"];
        const sumOnRecap = (rows, dateStr, filter=null) => {
          if (!dateStr) return 0;
          return (rows || [])
            .filter(r => r.recap_date === dateStr && r.amount_type === "ytd_snapshot")
            .filter(r => filter ? filter(r) : true)
            .reduce((s,r) => s + (parseFloat(r.amount) || 0), 0);
        };
        const ytdSnapshotFor = async (year, opts={}) => {
          const { data, error } = await supabase
            .from("comp_recap")
            .select("recap_date,amount,amount_type,comp_type,comp_category")
            .eq("period_year", year)
            .eq("amount_type", "ytd_snapshot")
            .order("recap_date", { ascending: false });
          if (error || !data) return { rows: [], latest: null, latestSamePeriod: null };
          const dates = [...new Set(data.map(r => r.recap_date))].sort().reverse();
          return { rows: data, latest: dates[0] || null, allDates: dates };
        };
        const rec2026 = await ytdSnapshotFor(2026);
        const rec2025 = await ytdSnapshotFor(2025);
        // Same-period 2025 = the 2025 recap whose (month,half-marker) matches latest 2026.
        // Encode as MM-DD since both years' recaps land on 15th and last-day of month.
        const sameMmDd = (latest2026 => {
          if (!latest2026) return null;
          const mmdd = latest2026.slice(5); // "MM-DD"
          // Find 2025 recap whose MM-DD matches. Feb edge: 02-28 vs 02-29 handled by exact MM-DD.
          return (rec2025.allDates || []).find(d => d.slice(5) === mmdd) || null;
        })(rec2026.latest);
        const lastOf2025 = (rec2025.allDates || [])[0] || null;

        const federalYtd2026 = sumOnRecap(rec2026.rows, rec2026.latest);
        const federalYtd2025 = sumOnRecap(rec2025.rows, sameMmDd);
        const federalFull2025 = sumOnRecap(rec2025.rows, lastOf2025);
        const pcYtd2026 = sumOnRecap(rec2026.rows, rec2026.latest, r => PC_TYPES.includes(r.comp_type));
        const pcYtd2025 = sumOnRecap(rec2025.rows, sameMmDd, r => PC_TYPES.includes(r.comp_type));
        const yoyPct = (federalYtd2025 > 0)
          ? ((federalYtd2026 - federalYtd2025) / federalYtd2025) * 100
          : NaN;
        const pcYoyPct = (pcYtd2025 > 0)
          ? ((pcYtd2026 - pcYtd2025) / pcYtd2025) * 100
          : NaN;
        // Empirical annual pace: 2026 YTD * (2025 full / 2025 same-period).
        // More accurate than straight-line annualization because comp comes in
        // bumpy (AIPP lump sum January, Q3 L&H push, etc.)
        const annualPace2026 = (federalYtd2025 > 0 && federalFull2025 > 0)
          ? federalYtd2026 * (federalFull2025 / federalYtd2025)
          : NaN;

        // Legacy income statement summary kept for any backward-compat consumers
        const now = new Date();
        const curYear  = now.getFullYear();
        const curMonth = now.getMonth() + 1;
        let revenueMTD = 0, expensesMTD = 0, revenueYTD = 0;
        try {
          const { data: isData } = await supabase.from("v_income_statement")
            .select("account_name, account_type, amount, month, year")
            .eq("year", curYear)
            .limit(500);
          const incomeLines  = (isData||[]).filter(r => r.account_type === "income");
          const expenseLines = (isData||[]).filter(r => r.account_type === "expense");
          const sum = rows => rows.reduce((s, r) => s + parseFloat(r.amount || 0), 0);
          revenueMTD  = sum(incomeLines.filter(r  => r.month === curMonth));
          expensesMTD = sum(expenseLines.filter(r => r.month === curMonth));
          revenueYTD  = sum(incomeLines);
        } catch (_e) { /* v_income_statement is optional fallback */ }

        setDashData({
          agency,
          summary: {
            revenueMTD, expensesMTD,
            netIncomeMTD: revenueMTD - expensesMTD,
            revenueYTD,
          },
          financialKpis: {
            latestRecapDate: rec2026.latest,
            sameMmDd2025: sameMmDd,
            lastOf2025,
            federalYtd2026, federalYtd2025, federalFull2025,
            pcYtd2026, pcYtd2025,
            yoyPct, pcYoyPct,
            annualPace2026,
          },
          aipp: (() => {
            const a = aippRes.status==="fulfilled" ? aippRes.value.data : null;
            if (!a) return { year: new Date().getFullYear(), target:0, earned:0, projected:0 };
            return {
              year:      a.program_year || new Date().getFullYear(),
              target:    parseFloat(a.target_amount)        || 0,
              earned:    parseFloat(a.earned_ytd)           || 0,
              projected: parseFloat(a.projected_full_year)  || 0,
              achievement: parseFloat(a.achievement_percentage) || 0,
              notes:     a.notes || null,
            };
          })(),
          tasks: tasksRes.status==="fulfilled" ? (tasksRes.value.data||[]) : [],
          alerts: alertsRes.status==="fulfilled" ? (alertsRes.value.data||[]) : [],
          openItems: memoryRes.status==="fulfilled" ? (memoryRes.value.data||[]) : [],
          complianceRules: complianceRes.status==="fulfilled" ? (complianceRes.value.data||[]) : [],
          closeDocuments: closeRes.status==="fulfilled" ? (closeRes.value.data||[]) : [],
          closeChecklist: closeChecklistRes.status==="fulfilled" ? (closeChecklistRes.value.data||[]) : [],
        });
      } catch (err) {
        console.error("Dashboard load error:", err);
      } finally {
        setLoading(false);
      }
    }
    loadDashboard();
  }, []);

  const today = new Date().toLocaleDateString("en-US",{weekday:"long",month:"long",day:"numeric",year:"numeric"});

  if (loading) {
    return (
      <div style={{padding:32, display:"flex", flexDirection:"column", alignItems:"center", gap:16}}>
        <div style={{fontSize:32}}>⚡</div>
        <div style={{fontSize:14, color:T.slate500}}>Loading your command center...</div>
      </div>
    );
  }

  return (
    <div style={{padding:"0 0 40px 0"}}>
      {/* Header */}
      <div style={{padding:"20px 0 16px 0", borderBottom:`1px solid ${T.slate200}`, marginBottom:20}}>
        <div style={{fontSize:20, fontWeight:800, color:T.navy}}>{greeting}, {agencyName} 👋</div>
        <div style={{fontSize:12, color:T.slate500, marginTop:4}}>{today}</div>
      </div>

      {/* Top Row — Financial + AIPP */}
      <div style={{display:"grid", gridTemplateColumns:"1fr 1fr", gap:14, marginBottom:14}}>
        <FinancialWidget data={dashData} onNavigate={onNavigate} />
        <AIPPWidget data={dashData} onNavigate={onNavigate} />
      </div>

      {/* Second Row — Monthly Close + Alerts */}
      <div style={{display:"grid", gridTemplateColumns:"1fr 1fr", gap:14, marginBottom:14}}>
        <MonthlyCloseWidget data={dashData} onNavigate={onNavigate} />
        <AlertsWidget data={dashData} onNavigate={onNavigate} />
      </div>

      {/* Third Row — Tasks + Compliance */}
      <div style={{display:"grid", gridTemplateColumns:"1fr 1fr", gap:14, marginBottom:14}}>
        <TasksWidget data={dashData} onNavigate={onNavigate} />
        <ComplianceWidget data={dashData} onNavigate={onNavigate} />
      </div>

      {/* Bottom Row — Open Items (full width) */}
      <OpenItemsWidget data={dashData} onNavigate={onNavigate} />
    </div>
  );
}
