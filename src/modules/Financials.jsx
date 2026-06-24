import { useState, useEffect, useRef } from "react";
import { supabase, AGENCY_ID } from "../lib/supabase.js";

// ============================================================
// BCC FINANCIALS MODULE v1.0
// Business Command Center — State Farm Agent Edition
// Built by Imaginary Farms LLC · imaginary-farms.com
//
// SECTIONS:
//   1. Overview        — Summary cards + revenue trend chart
//   2. P&L             — Monthly/quarterly/annual P&L
//   3. COMP_RECAP      — SF compensation detail by period
//   4. AIPP & ScoreBoard — Progress tracking
//   5. Payroll         — Staff payroll history
//   6. Bank Accounts   — Account balances and reconciliation
//   7. Credit & Debt   — Cards, loans, lines of credit
//   8. General Ledger  — Full transaction ledger
//
// DATA: Reads from Supabase via props (passed from BCCApp)
// In production replace MOCK_DATA with Supabase queries:
//   const { data } = await supabase.from('comp_recap')...
// ============================================================


// ─── Design Tokens (matches BCCApp shell) ────────────────────

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
  slate50: "#F8FAFC",
  slate100:"#F1F5F9",
  slate200:"#E2E8F0",
  slate400:"#94A3B8",
  slate500:"#64748B",
  slate600:"#475569",
  slate700:"#334155",
  slate800:"#1E293B",
  slate900:"#0F172A",
  white:   "#FFFFFF",
};

// ─── Live Supabase Data Hook ─────────────────────────────────
function useFinancialsData() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function load() {
      try {
        const currentYear  = new Date().getFullYear();
        const currentMonth = new Date().getMonth() + 1;     // 1-12
        const quarterStart = Math.floor((currentMonth - 1) / 3) * 3 + 1;

        const [
          isRows, isPriorRows, compRows, bankRows, ccRows, glRows,
          payrollRunsRes, payrollDetailRows,
          aippRows, scoreboardRows,
        ] = await Promise.all([
          // Income statement view — current year
          supabase.from("v_income_statement")
            .select("account_name, account_type, amount, month, year")
            .eq("year", currentYear).order("month"),

          // Income statement view — prior year (we slice to YTD-through-current-data-month client-side for fair YoY)
          supabase.from("v_income_statement")
            .select("account_type, amount, month")
            .eq("year", currentYear - 1),

          // SF comp recap — half_month_activity only (the ytd_snapshot rows would
          // double-count each line). Pull all 17 months (~1,117 rows for Tyler).
          supabase.from("comp_recap")
            .select("period_year, period_month, comp_type, comp_category, description, amount, is_aipp_eligible, is_scoreboard_eligible")
            .eq("amount_type", "half_month_activity")
            .order("period_year", { ascending: false })
            .order("period_month", { ascending: false })
            .limit(2000),

          // Bank
          supabase.from("bank_accounts")
            .select("account_name, current_balance, as_of_date, account_type, account_number_last4, institution"),

          // Credit
          supabase.from("credit_accounts")
            .select("account_name, current_balance, updated_at, account_type, account_number_last4, credit_limit, available_credit, interest_rate, minimum_payment, payment_due_day, institution"),

          // GL
          supabase.from("journal_lines")
            .select(`
              debit, credit, created_at,
              journal_entries!inner ( entry_date, reference_number, description, source ),
              chart_of_accounts!inner ( account_name )
            `)
            .order("created_at", { ascending: false }).limit(50),

          // Payroll runs (header) — pull plenty so YTD totals + history table both populate
          supabase.from("payroll_runs")
            .select("id, pay_period_start, pay_period_end, pay_date, payroll_provider, gross_payroll, employer_taxes, net_payroll, status, is_synthesized")
            .order("pay_date", { ascending: false }).limit(50),

          // Payroll detail (per-employee)
          supabase.from("payroll_detail")
            .select("payroll_run_id, gross_pay, federal_tax, state_tax, social_security, medicare, other_deductions, net_pay, employment_type"),

          // AIPP — real schema
          supabase.from("aipp_tracking")
            .select("program_year, target_amount, earned_ytd, projected_full_year, achievement_percentage, notes")
            .order("program_year", { ascending: false }).limit(2),

          // ScoreBoard
          supabase.from("scoreboard_tracking")
            .select("program_year, period, metric_name, target, actual, achievement_percentage, notes")
            .order("program_year", { ascending: false })
            .order("metric_name", { ascending: true })
            .limit(40),
        ]);

        const isData = isRows.data || [];
        const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

        // Monthly chart
        const monthlyRevenue = months.map((m, i) => {
          const mo = i + 1;
          const rev = isData.filter(r => r.month === mo && r.account_type === "income").reduce((s,r) => s + parseFloat(r.amount||0), 0);
          const exp = isData.filter(r => r.month === mo && r.account_type === "expense").reduce((s,r) => s + parseFloat(r.amount||0), 0);
          return { month: m, revenue: Math.round(rev), expenses: Math.round(exp) };
        });

        // P&L line items
        const buildLines = (type) =>
          [...new Set(isData.filter(r=>r.account_type===type).map(r=>r.account_name))].map(name => {
            const rows = isData.filter(r=>r.account_name===name && r.account_type===type);
            const ytd = rows.reduce((s,r)=>s+parseFloat(r.amount||0),0);
            const mtd = rows.filter(r=>r.month===currentMonth).reduce((s,r)=>s+parseFloat(r.amount||0),0);
            const qtd = rows.filter(r=>r.month>=quarterStart && r.month<=currentMonth).reduce((s,r)=>s+parseFloat(r.amount||0),0);
            return { name, mtd: Math.round(mtd), qtd: Math.round(qtd), ytd: Math.round(ytd) };
          });

        const incomeLines  = buildLines("income");
        const expenseLines = buildLines("expense");

        const sumByPeriod = (type, predicate) =>
          isData.filter(r => r.account_type === type && predicate(r))
                .reduce((s,r) => s + parseFloat(r.amount||0), 0);

        const revYTD = sumByPeriod("income",  () => true);
        const expYTD = sumByPeriod("expense", () => true);
        const revMTD = sumByPeriod("income",  r => r.month === currentMonth);
        const expMTD = sumByPeriod("expense", r => r.month === currentMonth);
        const revQTD = sumByPeriod("income",  r => r.month >= quarterStart && r.month <= currentMonth);
        const expQTD = sumByPeriod("expense", r => r.month >= quarterStart && r.month <= currentMonth);

        // Comp recap — group rows into "periods" (e.g. "Apr 2026") and pre-format for the section
        const compRecapsRaw = compRows.data || [];
        const compRecaps = compRecapsRaw.map(r => ({
          period_year:  r.period_year,
          period_month: r.period_month,
          period_label: `${months[r.period_month-1]} ${r.period_year}`,
          comp_type:    r.comp_type,
          comp_category: r.comp_category,
          description:  r.description || `${r.comp_type} — ${r.comp_category}`,
          amount:       parseFloat(r.amount || 0),
          is_aipp_eligible: r.is_aipp_eligible,
          is_scoreboard_eligible: r.is_scoreboard_eligible,
        }));

        // AIPP — alias schema fields to the names AIPPSection expects
        const aippList = aippRows.data || [];
        const aippRaw   = aippList[0] || null;     // latest program year (e.g. 2027)
        const aippPrior = aippList[1] || null;     // prior program year (e.g. 2026, paid Jan 2026)
        const aipp = aippRaw ? {
          year:          aippRaw.program_year || currentYear,
          target:        parseFloat(aippRaw.target_amount)        || 0,
          earned:        parseFloat(aippRaw.earned_ytd)           || 0,
          projected:     parseFloat(aippRaw.projected_full_year)  || 0,
          priorYear:     aippPrior ? parseFloat(aippPrior.earned_ytd) || 0 : 0,
          monthlyEarned: months.map((m,i) => {
            const mo = i + 1;
            // Canonical AIPP formula (per aipp_intelligence memory 2026-06-18, confirmed by Kwame):
            //   AIPP earned = 5% × (NEW Auto + NEW Fire) for the calendar year.
            //   NEW Auto  = comp_type IN ('MUTL','STDAUTO') AND comp_category IN ('new_business','new_amd66')
            //   NEW Fire  = comp_type = 'FIRE'              AND comp_category IN ('new_business','new_amd66')
            // The is_aipp_eligible flag on comp_recap is over-inclusive (includes renewals,
            // SFL first-year writing, etc.). Using it here caused bricks to sum to $232K while
            // aipp_tracking.earned_ytd correctly showed $1,517. Fixed 2026-06-22.
            const isNewAuto = (r) =>
              (r.comp_type === "MUTL" || r.comp_type === "STDAUTO") &&
              (r.comp_category === "new_business" || r.comp_category === "new_amd66");
            const isNewFire = (r) =>
              r.comp_type === "FIRE" &&
              (r.comp_category === "new_business" || r.comp_category === "new_amd66");
            const base = compRecapsRaw
              .filter(r => r.period_year === currentYear && r.period_month === mo && (isNewAuto(r) || isNewFire(r)))
              .reduce((s,r) => s + parseFloat(r.amount || 0), 0);
            return { month: m, amount: Math.round(base * 0.05) };
          }),
        } : { year: currentYear, target: 0, earned: 0, projected: 0, priorYear: 0, monthlyEarned: months.map(m => ({month:m, amount:0})) };

        // ScoreBoard — alias to {metric, actual, target, pct, year, notes}.
        // target/pct stay null when SF hasn't published a target — the render
        // shows a "Target pending" pill instead of a 0% danger pill.
        const scoreboard = (scoreboardRows.data || []).map(s => {
          const actualV = parseFloat(s.actual || 0);
          const targetV = (s.target == null || s.target === "") ? null : parseFloat(s.target);
          const pctV    = (targetV && targetV > 0) ? Math.round((actualV / targetV) * 100) : null;
          return {
            metric: s.metric_name,
            actual: actualV,
            target: targetV,
            pct:    pctV,
            year:   s.program_year,
            notes:  s.notes || "",
          };
        });

        // Payroll — combine runs + detail, grouped by run
        const detailByRun = {};
        for (const d of (payrollDetailRows.data || [])) {
          (detailByRun[d.payroll_run_id] ||= []).push(d);
        }
        const payroll = (payrollRunsRes.data || []).map(run => {
          const startStr = new Date(run.pay_period_start).toLocaleDateString("en-US", { month:"short", day:"numeric" });
          const endStr   = new Date(run.pay_period_end).toLocaleDateString("en-US", { month:"short", day:"numeric", year:"numeric" });
          const dateStr  = run.pay_date ? new Date(run.pay_date).toLocaleDateString("en-US", { month:"short", day:"numeric", year:"numeric" }) : "";
          return {
            pay_period:     `${startStr} – ${endStr}`,
            pay_date:       dateStr,
            pay_date_iso:   run.pay_date,
            gross:          parseFloat(run.gross_payroll || 0),
            taxes:          parseFloat(run.employer_taxes || 0),
            net:            parseFloat(run.net_payroll || 0),
            status:         run.status || "paid",
            provider:       run.payroll_provider,
            is_synthesized: !!run.is_synthesized,
          };
        });

        // Credit accounts — alias to what CreditSection expects
        const creditAccounts = (ccRows.data || []).map(c => ({
          name:    c.account_name,
          balance: parseFloat(c.current_balance || 0),
          asOf:    c.updated_at,
          type:    c.account_type,
          last4:   c.account_number_last4,
          limit:   parseFloat(c.credit_limit || 0) || null,
          rate:    parseFloat(c.interest_rate || 0),
          payment: parseFloat(c.minimum_payment || 0),
          dueDay:  c.payment_due_day,
        }));

        // Prior-year YTD income for fair YoY%: filter prior year to the same months
        // that have actual data in the current year (avoids 5-month vs 6-month skew
        // when the current calendar month has not yet been ingested).
        const currentYearMonths = isData.filter(r => parseFloat(r.amount || 0) !== 0).map(r => r.month);
        const latestDataMonth = currentYearMonths.length > 0 ? Math.max(...currentYearMonths) : currentMonth;
        const priorYearYTD = (isPriorRows.data || [])
          .filter(r => r.account_type === "income" && r.month <= latestDataMonth)
          .reduce((s,r) => s + parseFloat(r.amount || 0), 0);

        // Period labels — dynamic, replace stale hardcoded "Apr 2026" / "Q1 2026" headers
        const monthAbbr = months[currentMonth - 1];
        const quarterNum = Math.ceil(currentMonth / 3);
        const mtdLabel = `${monthAbbr} ${currentYear}`;
        const qtdLabel = `Q${quarterNum} ${currentYear}`;
        const ytdLabel = `YTD ${currentYear}`;

        setData({
          summary: {
            revenueMTD:   Math.round(revMTD),
            revenueQTD:   Math.round(revQTD),
            revenueYTD:   Math.round(revYTD),
            expensesMTD:  Math.round(expMTD),
            expensesQTD:  Math.round(expQTD),
            expensesYTD:  Math.round(expYTD),
            netIncomeMTD: Math.round(revMTD - expMTD),
            netIncomeQTD: Math.round(revQTD - expQTD),
            netIncomeYTD: Math.round(revYTD - expYTD),
            priorYearYTD: Math.round(priorYearYTD),
            mtdLabel, qtdLabel, ytdLabel,
          },
          monthlyRevenue,
          pl: { income: incomeLines, expenses: expenseLines },
          compRecaps,
          aipp,
          scoreboard,
          bankAccounts: (bankRows.data || []).map(b => ({
            name: b.account_name,
            balance: parseFloat(b.current_balance||0),
            asOf: b.as_of_date,
            type: b.account_type,
            last4: b.account_number_last4,
            institution: b.institution,
          })),
          creditAccounts,
          glEntries: (glRows.data || []).map(g => ({
            date:        g.journal_entries?.entry_date,
            ref:         g.journal_entries?.reference_number,
            description: g.journal_entries?.description,
            source:      g.journal_entries?.source,
            account:     g.chart_of_accounts?.account_name,
            debit:       parseFloat(g.debit  || 0),
            credit:      parseFloat(g.credit || 0),
          })),
          payroll,
        });
      } catch(e) {
        console.error("Financials load error:", e);
      } finally {
        setLoading(false);
      }
    }
    load();
  }, []);

  return { data, loading };
}


// ─── Helpers ─────────────────────────────────────────────────
const fmt = (n) => { const v = Number(n); if (!Number.isFinite(v)) return "—"; if (v === 0) return "—"; return "$" + v.toLocaleString("en-US", { minimumFractionDigits: 0 }); };
const pct  = (n, t) => t ? Math.round((n / t) * 100) : 0;
const yoy  = (curr, prior) => prior ? (((curr - prior) / prior) * 100).toFixed(1) : null;

// ─── Data Store (populated by Financials component with live data) ────────────
let MOCK = {
  summary: { revenueMTD:0,revenueQTD:0,revenueYTD:0,expensesMTD:0,netIncomeMTD:0,netIncomeYTD:0,priorYearYTD:0 },
  monthlyRevenue: Array(12).fill(0).map((_,i)=>({month:["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"][i],revenue:0,expenses:0})),
  pl:{income:[],expenses:[]},
  compRecaps:[],
  aipp: { year: new Date().getFullYear(), target:0, earned:0, projected:0, priorYear:0, monthlyEarned: ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"].map(m=>({month:m,amount:0})) },
  scoreboard: [],
  bankAccounts:[],creditAccounts:[],glEntries:[],payroll:[],
};


// ─── Shared Components ───────────────────────────────────────
const Card = ({ children, style = {} }) => (
  <div style={{
    background: T.white,
    border: `1px solid ${T.slate200}`,
    borderRadius: 12,
    padding: "16px 18px",
    ...style,
  }}>
    {children}
  </div>
);

const CardHeader = ({ title, sub, action }) => (
  <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", marginBottom: 14 }}>
    <div>
      <div style={{ fontSize: 13, fontWeight: 600, color: T.slate800 }}>{title}</div>
      {sub && <div style={{ fontSize: 11, color: T.slate500, marginTop: 2 }}>{sub}</div>}
    </div>
    {action}
  </div>
);

const KPICard = ({ label, value, sub, color = T.slate900, border }) => (
  <div style={{
    background: T.white,
    border: `1px solid ${border || T.slate200}`,
    borderRadius: 12,
    padding: "14px 16px",
    borderTop: border ? `3px solid ${border}` : undefined,
  }}>
    <div style={{ fontSize: 11, color: T.slate500, fontWeight: 500, marginBottom: 6 }}>{label}</div>
    <div style={{ fontSize: 20, fontWeight: 700, color, letterSpacing: "-0.02em", marginBottom: 4 }}>{value}</div>
    {sub && <div style={{ fontSize: 11, color: T.slate400 }}>{sub}</div>}
  </div>
);

const Pill = ({ children, type = "info" }) => {
  const map = {
    success: { bg: T.greenLt,  color: "#065F46" },
    warning: { bg: T.amberLt,  color: "#92400E" },
    danger:  { bg: T.redLt,    color: "#991B1B" },
    info:    { bg: T.blueLt,   color: "#1E40AF" },
    purple:  { bg: T.purpleLt, color: "#5B21B6" },
  };
  const s = map[type] || map.info;
  return (
    <span style={{
      display: "inline-flex", alignItems: "center",
      fontSize: 10, fontWeight: 600,
      padding: "3px 8px", borderRadius: 20,
      background: s.bg, color: s.color,
      whiteSpace: "nowrap",
    }}>{children}</span>
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

const TabBar = ({ tabs, active, onChange }) => (
  <div style={{
    display: "flex", gap: 2,
    background: T.slate100,
    borderRadius: 8, padding: 3,
    marginBottom: 16,
    flexWrap: "wrap",
  }}>
    {tabs.map(t => (
      <button key={t.id} onClick={() => onChange(t.id)} style={{
        padding: "6px 14px", fontSize: 12, fontWeight: active === t.id ? 600 : 400,
        color: active === t.id ? T.slate900 : T.slate500,
        background: active === t.id ? T.white : "transparent",
        border: "none", borderRadius: 6, cursor: "pointer",
        transition: "all 0.12s",
        boxShadow: active === t.id ? "0 1px 3px rgba(0,0,0,0.08)" : "none",
      }}>{t.label}</button>
    ))}
  </div>
);

// ─── Mini Bar Chart ──────────────────────────────────────────
const MiniBarChart = ({ data }) => {
  const maxVal = Math.max(...data.map(d => Math.max(d.revenue, d.expenses)));
  const barH = 80;
  return (
    <div style={{ display: "flex", alignItems: "flex-end", gap: 3, height: barH + 24 }}>
      {data.map((d, i) => (
        <div key={i} style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", gap: 2 }}>
          <div style={{ width: "100%", display: "flex", flexDirection: "column", alignItems: "center", gap: 1, height: barH, justifyContent: "flex-end" }}>
            {d.revenue > 0 && (
              <div style={{
                width: "60%", background: T.blue, borderRadius: "2px 2px 0 0",
                height: `${(d.revenue / maxVal) * barH}px`,
                transition: "height 0.6s ease",
              }} />
            )}
            {d.revenue === 0 && (
              <div style={{ width: "60%", background: T.slate200, borderRadius: "2px 2px 0 0", height: 3 }} />
            )}
          </div>
          <div style={{ fontSize: 9, color: T.slate400 }}>{d.month}</div>
        </div>
      ))}
    </div>
  );
};

// ─── Progress Bar ────────────────────────────────────────────
const ProgressBar = ({ value, max, color = T.blue, height = 8 }) => {
  const p = Math.min(pct(value, max), 100);
  return (
    <div style={{ height, background: T.slate100, borderRadius: height / 2, overflow: "hidden" }}>
      <div style={{
        height: "100%", width: `${p}%`,
        background: color, borderRadius: height / 2,
        transition: "width 0.7s ease",
      }} />
    </div>
  );
};

// ─── Section: Overview ───────────────────────────────────────
const OverviewSection = ({ period, setPeriod, data }) => {
  const d = data?.summary || {};
  const yoyPct = yoy(d.revenueYTD || 0, d.priorYearYTD || 0);

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 14 }}>
        <TabBar
          tabs={[{ id:"mtd", label:"This Month" },{ id:"qtd", label:"This Quarter" },{ id:"ytd", label:"Year to Date" }]}
          active={period}
          onChange={setPeriod}
        />
        <AskBtn context={`My agency financials — ${period.toUpperCase()}: Revenue $${period==="mtd"?d.revenueMTD:period==="qtd"?d.revenueQTD:d.revenueYTD}, Expenses $${period==="mtd"?d.expensesMTD:"N/A"}, Net Income $${period==="mtd"?d.netIncomeMTD:d.netIncomeYTD}. YTD is up ${yoyPct}% vs prior year. Help me analyze my financial performance.`} />
      </div>

      {/* KPI Cards — use REAL period-scoped values (no fake multipliers), guard divide-by-zero */}
      {(() => {
        const rev = period==="mtd" ? d.revenueMTD : period==="qtd" ? d.revenueQTD : d.revenueYTD;
        const exp = period==="mtd" ? d.expensesMTD : period==="qtd" ? d.expensesQTD : d.expensesYTD;
        const net = period==="mtd" ? d.netIncomeMTD : period==="qtd" ? d.netIncomeQTD : d.netIncomeYTD;
        const ratio = rev > 0 ? Math.round((exp / rev) * 100) + "%" : "—";
        const yoyText = period === "ytd" && yoyPct != null ? `↑ ${yoyPct}% vs prior year` : undefined;
        return (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(140px,1fr))", gap: 10, marginBottom: 16 }}>
            <KPICard label="Revenue"       value={fmt(rev)}   sub={yoyText} color={T.blue}  border={T.blue} />
            <KPICard label="Expenses"      value={fmt(exp)}   sub="Cash basis" border={T.amber} />
            <KPICard label="Net Income"    value={fmt(net)}   color={T.green} border={T.green} />
            <KPICard label="Expense Ratio" value={ratio}       sub="Target: <45%" border={T.slate200} />
          </div>
        );
      })()}

      <div style={{ display: "grid", gridTemplateColumns: "minmax(0,1.4fr) minmax(0,1fr)", gap: 12 }}>
        <Card>
          <CardHeader title="Monthly revenue — 2026" sub="Blue bars = revenue · Gray = no data yet" />
          <MiniBarChart data={data.monthlyRevenue} />
        </Card>

        <Card>
          {/* Period-aware income breakdown: respects the This Month / This Quarter / YTD toggle */}
          {(() => {
            const periodKey   = period === "mtd" ? "mtd" : period === "qtd" ? "qtd" : "ytd";
            const periodLabel = period === "mtd" ? d.mtdLabel : period === "qtd" ? d.qtdLabel : d.ytdLabel;
            const periodMax   = period === "mtd" ? d.revenueMTD : period === "qtd" ? d.revenueQTD : d.revenueYTD;
            return (
              <>
                <CardHeader title={`Income breakdown — ${periodLabel || "current period"}`} />
                {(Array.isArray(data?.pl?.income) ? data.pl.income : []).map((item, i) => {
                  const v = item[periodKey] || 0;
                  return (
                    <div key={i} style={{ marginBottom: 10 }}>
                      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, marginBottom: 3 }}>
                        <span style={{ color: T.slate600 }}>{item.name}</span>
                        <span style={{ fontWeight: 600, color: T.slate900 }}>{fmt(v)}</span>
                      </div>
                      <ProgressBar value={v} max={periodMax || 1} color={item.code?.startsWith("41") ? T.green : T.blue} />
                    </div>
                  );
                })}
              </>
            );
          })()}
        </Card>
      </div>
    </div>
  );
};

// ─── Section: P&L ────────────────────────────────────────────
const PLSection = ({ data }) => {
  const pl = data?.pl || { income: [], expenses: [] };
  const incomeRows  = Array.isArray(pl.income)   ? pl.income   : [];
  const expenseRows = Array.isArray(pl.expenses) ? pl.expenses : [];
  const totalIncomeMTD  = incomeRows.reduce((s,r) => s + (r?.mtd || 0), 0);
  const totalExpMTD     = expenseRows.reduce((s,r) => s + (r?.mtd || 0), 0);
  const totalIncomeYTD  = incomeRows.reduce((s,r) => s + (r?.ytd || 0), 0);
  const totalExpYTD     = expenseRows.reduce((s,r) => s + (r?.ytd || 0), 0);

  const TRow = ({ label, mtd, qtd, ytd, bold, indent, isTotal, isNeg }) => (
    <tr style={{ background: isTotal ? T.slate50 : "transparent" }}>
      <td style={{ padding: "7px 8px", fontSize: 12, color: indent ? T.slate600 : T.slate800, paddingLeft: indent ? 24 : 8, fontWeight: bold ? 600 : 400 }}>{label}</td>
      <td style={{ padding: "7px 8px", fontSize: 12, textAlign: "right", fontWeight: bold ? 600 : 400, color: isNeg ? T.red : bold ? T.slate900 : T.slate700 }}>{fmt(mtd)}</td>
      <td style={{ padding: "7px 8px", fontSize: 12, textAlign: "right", fontWeight: bold ? 600 : 400, color: isNeg ? T.red : bold ? T.slate900 : T.slate700 }}>{fmt(qtd)}</td>
      <td style={{ padding: "7px 8px", fontSize: 12, textAlign: "right", fontWeight: bold ? 600 : 400, color: isNeg ? T.red : bold ? T.slate900 : T.slate700 }}>{fmt(ytd)}</td>
    </tr>
  );

  return (
    <Card>
      <CardHeader
        title="Profit & Loss Statement"
        sub="Cash basis · Calendar year 2026"
        action={<AskBtn context={`My P&L: YTD Revenue $${totalIncomeYTD}, YTD Expenses $${totalExpYTD}, Net Income $${totalIncomeYTD - totalExpYTD}. Expense ratio ${Math.round((totalExpYTD/totalIncomeYTD)*100)}%. Help me analyze my profitability and identify areas to improve.`} />}
      />
      <div style={{ overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead>
            <tr style={{ borderBottom: `2px solid ${T.slate200}` }}>
              <th style={{ padding: "8px 8px", fontSize: 11, fontWeight: 600, color: T.slate500, textAlign: "left" }}>Account</th>
              <th style={{ padding: "8px 8px", fontSize: 11, fontWeight: 600, color: T.slate500, textAlign: "right" }}>{data?.summary?.mtdLabel || "MTD"}</th>
              <th style={{ padding: "8px 8px", fontSize: 11, fontWeight: 600, color: T.slate500, textAlign: "right" }}>{data?.summary?.qtdLabel || "QTD"}</th>
              <th style={{ padding: "8px 8px", fontSize: 11, fontWeight: 600, color: T.slate500, textAlign: "right" }}>{data?.summary?.ytdLabel || "YTD"}</th>
            </tr>
          </thead>
          <tbody>
            <TRow label="INCOME" bold />
            {incomeRows.map((r,i) => (
              <TRow key={i} label={r.name} mtd={r.mtd} qtd={r.qtd} ytd={r.ytd} indent />
            ))}
            <TRow label="Total Income" mtd={totalIncomeMTD} qtd={incomeRows.reduce((s,r)=>s+r.qtd,0)} ytd={totalIncomeYTD} bold isTotal />

            <tr><td colSpan={4} style={{ padding: "6px 0" }} /></tr>

            <TRow label="EXPENSES" bold />
            {expenseRows.map((r,i) => (
              <TRow key={i} label={r.name} mtd={r.mtd} qtd={r.qtd} ytd={r.ytd} indent />
            ))}
            <TRow label="Total Expenses" mtd={totalExpMTD} qtd={expenseRows.reduce((s,r)=>s+r.qtd,0)} ytd={totalExpYTD} bold isTotal />

            <tr><td colSpan={4} style={{ padding: "2px 0", borderTop: `2px solid ${T.slate800}` }} /></tr>
            <TRow label="NET INCOME" mtd={totalIncomeMTD-totalExpMTD} qtd={incomeRows.reduce((s,r)=>s+r.qtd,0)-expenseRows.reduce((s,r)=>s+r.qtd,0)} ytd={totalIncomeYTD-totalExpYTD} bold isTotal />
          </tbody>
        </table>
      </div>
    </Card>
  );
};

// ─── Section: COMP_RECAP ─────────────────────────────────────
const CompRecapSection = ({ data }) => {
  const compRecaps = Array.isArray(data?.compRecaps) ? data.compRecaps : [];
  const allPeriods = [...new Set(compRecaps.map(r => r?.period_label).filter(Boolean))];
  const [period, setPeriod] = useState("");
  // Initialize period to most recent once data arrives
  useEffect(() => {
    if (allPeriods.length > 0 && !allPeriods.includes(period)) {
      setPeriod(allPeriods[0]);
    }
  }, [allPeriods.join("|")]);
  const periods  = allPeriods;
  const filtered = compRecaps.filter(r => r.period_label === period);
  const total    = filtered.reduce((s,r) => s + parseFloat(r.amount || 0), 0);
  const aippTotal = filtered.filter(r => r.is_aipp_eligible).reduce((s,r) => s + parseFloat(r.amount || 0), 0);

  return (
    <Card>
      <CardHeader
        title="SF COMP_RECAP Detail"
        sub="State Farm compensation breakdown by period"
        action={<AskBtn context={`My SF COMP_RECAP for ${period}: Total $${total}. AIPP eligible: $${aippTotal}. Help me reconcile this to my GL and confirm my AIPP calculation.`} />}
      />
      <div style={{ display: "flex", gap: 8, marginBottom: 14, flexWrap: "wrap" }}>
        {periods.map(p => (
          <button key={p} onClick={() => setPeriod(p)} style={{
            padding: "5px 12px", fontSize: 11, fontWeight: period===p ? 600 : 400,
            color: period===p ? T.white : T.slate600,
            background: period===p ? T.navy : T.white,
            border: `1px solid ${period===p ? T.navy : T.slate200}`,
            borderRadius: 6, cursor: "pointer",
          }}>{p}</button>
        ))}
      </div>

      <table style={{ width: "100%", borderCollapse: "collapse" }}>
        <thead>
          <tr style={{ borderBottom: `1px solid ${T.slate200}` }}>
            <th style={{ padding: "8px 8px", fontSize: 11, fontWeight: 600, color: T.slate500, textAlign: "left" }}>Compensation Type</th>
            <th style={{ padding: "8px 8px", fontSize: 11, fontWeight: 600, color: T.slate500, textAlign: "center" }}>AIPP Eligible</th>
            <th style={{ padding: "8px 8px", fontSize: 11, fontWeight: 600, color: T.slate500, textAlign: "right" }}>Amount</th>
          </tr>
        </thead>
        <tbody>
          {filtered.map((r,i) => (
            <tr key={i} style={{ borderBottom: `1px solid ${T.slate100}` }}>
              <td style={{ padding: "8px 8px", fontSize: 12, color: T.slate800 }}>{r.description}</td>
              <td style={{ padding: "8px 8px", textAlign: "center" }}>
                {r.is_aipp_eligible
                  ? <Pill type="success">AIPP</Pill>
                  : <span style={{ fontSize: 11, color: T.slate400 }}>—</span>}
              </td>
              <td style={{ padding: "8px 8px", fontSize: 12, fontWeight: 600, color: T.slate900, textAlign: "right" }}>{fmt(Math.round(r.amount))}</td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr style={{ borderTop: `2px solid ${T.slate800}` }}>
            <td style={{ padding: "8px 8px", fontSize: 12, fontWeight: 700, color: T.slate900 }}>Total</td>
            <td style={{ padding: "8px 8px", fontSize: 11, textAlign: "center", color: T.slate500 }}>AIPP: {fmt(aippTotal)}</td>
            <td style={{ padding: "8px 8px", fontSize: 13, fontWeight: 700, color: T.blue, textAlign: "right" }}>{fmt(total)}</td>
          </tr>
        </tfoot>
      </table>
    </Card>
  );
};

// ─── Section: AIPP & ScoreBoard ──────────────────────────────
const AIPPSection = ({ data }) => {
  const aippData = data?.aipp || {};
  const year       = aippData.year       || new Date().getFullYear();
  const target     = aippData.target     || 0;
  const earned     = aippData.earned     || 0;
  const projected  = aippData.projected  || 0;
  const priorYear  = aippData.priorYear  || 0;
  const monthlyEarned = Array.isArray(aippData.monthlyEarned) ? aippData.monthlyEarned : [];
  const scoreboard    = Array.isArray(data?.scoreboard) ? data.scoreboard : [];
  const achievement = pct(earned, target);
  const projPct = pct(projected, target);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <div style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) minmax(0,1fr)", gap: 12 }}>

        {/* AIPP Progress */}
        <Card>
          <CardHeader
            title={`AIPP ${year} — Annual Incentive Progress`}
            action={<AskBtn context={`AIPP ${year}: Target $${target}, Earned YTD $${earned}, Achievement ${achievement}%, Projected $${projected}, Prior Year $${priorYear}. Am I on track? What do I need to focus on?`} />}
          />
          <div style={{ fontSize: 32, fontWeight: 700, color: T.green, letterSpacing: "-0.03em", marginBottom: 4 }}>
            {achievement}%
          </div>
          <div style={{ fontSize: 12, color: T.slate500, marginBottom: 12 }}>
            {fmt(earned)} earned of {fmt(target)} target
          </div>
          <ProgressBar value={earned} max={target} color={T.green} height={10} />
          <div style={{ display: "flex", justifyContent: "space-between", fontSize: 10, color: T.slate400, marginTop: 6, marginBottom: 16 }}>
            <span>Jan {year}</span><span>Dec {year}</span>
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8 }}>
            {[
              { label: "Earned YTD",    value: fmt(earned),    color: T.green },
              { label: "Projected",     value: fmt(projected), color: projPct >= 95 ? T.green : T.amber },
              { label: "Prior Year",    value: fmt(priorYear), color: T.slate500 },
            ].map((s,i) => (
              <div key={i} style={{ background: T.slate50, borderRadius: 8, padding: "10px 12px", textAlign: "center" }}>
                <div style={{ fontSize: 10, color: T.slate500, marginBottom: 4 }}>{s.label}</div>
                <div style={{ fontSize: 13, fontWeight: 700, color: s.color }}>{s.value}</div>
              </div>
            ))}
          </div>

          <div style={{ marginTop: 14 }}>
            <div style={{ fontSize: 11, fontWeight: 600, color: T.slate600, marginBottom: 8 }}>Monthly earned — {year}</div>
            <div style={{ display: "flex", gap: 6 }}>
              {monthlyEarned.map((m,i) => (
                <div key={i} style={{ flex: 1, background: T.blueLt, borderRadius: 6, padding: "6px 4px", textAlign: "center" }}>
                  <div style={{ fontSize: 9, color: T.slate500 }}>{m.month}</div>
                  <div style={{ fontSize: 10, fontWeight: 700, color: T.blue, marginTop: 2 }}>{fmt(m.amount)}</div>
                </div>
              ))}
            </div>
          </div>
        </Card>

        {/* ScoreBoard */}
        <Card>
          <CardHeader
            title={`ScoreBoard Bonuses — ${year}`}
            sub={`Lump-sum bonus paid Mar 15 for ${year - 1} qualifying activity`}
            action={<AskBtn context={`My ScoreBoard bonuses ${year}: reviewing what was paid for ${year - 1} qualifying activity, and what's accruing toward the ${year + 1} payout.`} />}
          />
          {(() => {
            const cur = scoreboard.filter(m => m.year === year);
            const prior = scoreboard.filter(m => m.year === year - 1);
            if (cur.length === 0) {
              return (
                <div style={{ fontSize: 12, color: T.slate500, padding: "12px 0" }}>
                  No ScoreBoard bonus data for {year} yet.
                </div>
              );
            }
            const curTotal = cur.reduce((s, m) => s + (Number.isFinite(m.actual) ? m.actual : 0), 0);
            const priorTotal = prior.reduce((s, m) => s + (Number.isFinite(m.actual) ? m.actual : 0), 0);
            const totalYoy = priorTotal > 0 ? Math.round(((curTotal / priorTotal) - 1) * 100) : null;
            return (
              <>
                {cur.map((m, i) => {
                  const priorMatch = prior.find(p => p.metric === m.metric);
                  const priorAmt = priorMatch ? priorMatch.actual : null;
                  const yoyPct = (priorAmt && priorAmt > 0)
                    ? Math.round(((m.actual / priorAmt) - 1) * 100)
                    : null;
                  return (
                    <div key={i} style={{ marginBottom: 14 }}>
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
                        <span style={{ fontSize: 12, color: T.slate700 }}>{m.metric}</span>
                        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                          <span style={{ fontSize: 11, color: T.slate500 }}>
                            {fmt(m.actual)}{m.target != null ? ` / ${fmt(m.target)}` : ""}
                          </span>
                          {m.target != null
                            ? <Pill type={m.pct >= 100 ? "success" : m.pct >= 75 ? "warning" : "danger"}>{m.pct}%</Pill>
                            : <Pill type="info">Target pending</Pill>}
                        </div>
                      </div>
                      {m.target != null ? (
                        <ProgressBar
                          value={m.actual}
                          max={m.target}
                          color={m.pct >= 100 ? T.green : m.pct >= 75 ? T.amber : T.red}
                          height={6}
                        />
                      ) : (
                        <div style={{ fontSize: 10, color: T.slate400 }}>
                          {yoyPct != null
                            ? `${yoyPct >= 0 ? "+" : ""}${yoyPct}% vs ${year - 1} (${fmt(priorAmt)})`
                            : `No ${year - 1} comparison available`}
                        </div>
                      )}
                    </div>
                  );
                })}
                <div style={{
                  marginTop: 16, padding: "10px 12px",
                  background: T.slate50, borderRadius: 8,
                  fontSize: 11, color: T.slate600,
                  borderLeft: `3px solid ${T.blue}`,
                }}>
                  <strong>{year} total: {fmt(curTotal)}</strong>
                  {totalYoy != null && (
                    <> · {totalYoy >= 0 ? "+" : ""}{totalYoy}% vs {year - 1} ({fmt(priorTotal)})</>
                  )}
                  {totalYoy == null && priorTotal === 0 && (
                    <> · no {year - 1} baseline</>
                  )}
                </div>
              </>
            );
          })()}
        </Card>
      </div>
    </div>
  );
};

// ─── Section: Payroll ─────────────────────────────────────────
const PayrollSection = ({ data }) => {
  // YTD totals — filter to current calendar year only (don't aggregate the full history)
  const currentYear = new Date().getFullYear();
  const ytdRows = (data.payroll || []).filter(r => r.pay_date_iso && new Date(r.pay_date_iso).getFullYear() === currentYear);
  const ytdGross = ytdRows.reduce((s,r) => s + parseFloat(r.gross || 0), 0);
  const ytdTax   = ytdRows.reduce((s,r) => s + parseFloat(r.taxes || 0), 0);
  const anySynth = (data.payroll || []).some(r => r.is_synthesized);

  return (
    <Card>
      <CardHeader
        title="Payroll History"
        sub={`YTD Gross: ${fmt(ytdGross)} · YTD Taxes: ${fmt(ytdTax)}${anySynth ? "  ·  ⓘ rows marked † are synthesized from bank transactions — actual Paychex statements pending" : ""}`}
        action={<AskBtn context={`My agency payroll YTD: Gross ${fmt(ytdGross)}, Employer taxes ${fmt(ytdTax)}. Help me review payroll expenses and identify any concerns.`} />}
      />
      <table style={{ width: "100%", borderCollapse: "collapse" }}>
        <thead>
          <tr style={{ borderBottom: `1px solid ${T.slate200}` }}>
            {["Pay Period","Pay Date","Gross","Employer Taxes","Net Payroll","Status"].map((h,i) => (
              <th key={i} style={{ padding: "8px", fontSize: 11, fontWeight: 600, color: T.slate500, textAlign: i > 1 ? "right" : "left" }}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {(data.payroll || []).map((r,i) => (
            <tr key={i} style={{ borderBottom: `1px solid ${T.slate100}` }}>
              <td style={{ padding: "9px 8px", fontSize: 12, color: T.slate800 }}>
                {r.pay_period||r.period}
                {r.is_synthesized && <span style={{ color: T.amber, marginLeft: 4, fontWeight: 600 }} title="Synthesized from bank transactions — actual Paychex statement pending">†</span>}
              </td>
              <td style={{ padding: "9px 8px", fontSize: 12, color: T.slate600 }}>{r.pay_date||r.payDate||"-"}</td>
              <td style={{ padding: "9px 8px", fontSize: 12, fontWeight: 600, color: T.slate900, textAlign: "right" }}>{fmt(r.gross)}</td>
              <td style={{ padding: "9px 8px", fontSize: 12, color: T.slate700, textAlign: "right" }}>{fmt(parseFloat(r.taxes||0))}</td>
              <td style={{ padding: "9px 8px", fontSize: 12, color: T.slate700, textAlign: "right" }}>{fmt(parseFloat(r.net||0))}</td>
              <td style={{ padding: "9px 8px", textAlign: "right" }}>
                <Pill type="success">{r.status}</Pill>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  );
};

// ─── Section: Bank Accounts ───────────────────────────────────
const BankSection = ({ data }) => {
  const bankAccounts = Array.isArray(data?.bankAccounts) ? data.bankAccounts : [];
  const totalCash = bankAccounts.reduce((s,r) => s + (r?.balance || 0), 0);
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px,1fr))", gap: 10 }}>
        {bankAccounts.map((a, i) => (
          <Card key={i}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 8 }}>
              <div style={{ fontSize: 11, fontWeight: 600, color: T.slate700 }}>{a.name}</div>
              <Pill type={a.reconciled ? "success" : "warning"}>
                {a.reconciled ? "Reconciled" : "Pending"}
              </Pill>
            </div>
            <div style={{ fontSize: 24, fontWeight: 700, color: T.slate900, letterSpacing: "-0.02em" }}>
              {fmt(a.balance)}
            </div>
            <div style={{ fontSize: 10, color: T.slate400, marginTop: 4 }}>
              As of {a.asOf} · ••••{a.last4}
            </div>
          </Card>
        ))}
        <Card style={{ background: T.navy, border: "none" }}>
          <div style={{ fontSize: 11, fontWeight: 600, color: "rgba(255,255,255,0.7)", marginBottom: 8 }}>Total Cash Position</div>
          <div style={{ fontSize: 26, fontWeight: 700, color: T.white, letterSpacing: "-0.02em" }}>{fmt(totalCash)}</div>
          <div style={{ fontSize: 10, color: "rgba(255,255,255,0.5)", marginTop: 4 }}>All accounts combined</div>
        </Card>
      </div>
    </div>
  );
};

// ─── Section: Credit & Debt ───────────────────────────────────
const CreditSection = ({ data }) => {
  const totalDebt = (data.creditAccounts || []).reduce((s,r) => s + r.balance, 0);
  const totalAvailable = (data.creditAccounts || []).filter(a => a.limit).reduce((s,r) => s + (r.limit - r.balance), 0);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px,1fr))", gap: 10, marginBottom: 4 }}>
        <KPICard label="Total Debt Exposure" value={fmt(totalDebt)} color={T.red} border={T.red} />
        <KPICard label="Available Credit" value={fmt(totalAvailable)} color={T.green} border={T.green} />
        {(() => {
          // Compute Next Payment Due from REAL credit_accounts data (no hardcoded SBA Loan).
          // Shows the earliest upcoming payment across all credit accounts that have a dueDay set.
          const today = new Date();
          const upcoming = (data.creditAccounts || [])
            .filter(a => a.dueDay && (a.payment || a.balance > 0))
            .map(a => {
              let due = new Date(today.getFullYear(), today.getMonth(), a.dueDay);
              if (due < today) due = new Date(today.getFullYear(), today.getMonth() + 1, a.dueDay);
              return { name: a.name, due, payment: a.payment || 0 };
            })
            .sort((x, y) => x.due - y.due)[0];
          const value = upcoming ? upcoming.due.toLocaleDateString("en-US", { month: "short", day: "numeric" }) : "—";
          const sub   = upcoming
            ? `${upcoming.name.split(" ").slice(0,3).join(" ")} — ${upcoming.payment ? fmt(upcoming.payment) : "min TBD"}`
            : "No scheduled payments";
          return <KPICard label="Next Payment Due" value={value} sub={sub} border={T.amber} />;
        })()}
      </div>

      {(data.creditAccounts || []).map((a, i) => (
        <Card key={i}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 12 }}>
            <div>
              <div style={{ fontSize: 13, fontWeight: 600, color: T.slate800 }}>{a.name}</div>
              <div style={{ fontSize: 11, color: T.slate500, marginTop: 2 }}>
                {a.type === "credit_card" ? "Credit Card" : a.type === "loan" ? "Loan" : "Line of Credit"} · ••••{a.last4} · {a.rate}% APR
              </div>
            </div>
            <AskBtn context={`${a.name}: Balance ${fmt(a.balance)}, Rate ${a.rate}%, Payment due on the ${a.dueDay}. Minimum payment: ${fmt(a.payment)}. Help me think about this debt.`} />
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(120px,1fr))", gap: 10 }}>
            <div>
              <div style={{ fontSize: 10, color: T.slate500, marginBottom: 2 }}>Current Balance</div>
              <div style={{ fontSize: 16, fontWeight: 700, color: T.red }}>{fmt(a.balance)}</div>
            </div>
            {a.limit && (
              <div>
                <div style={{ fontSize: 10, color: T.slate500, marginBottom: 2 }}>Available Credit</div>
                <div style={{ fontSize: 16, fontWeight: 700, color: T.green }}>{fmt(a.limit - a.balance)}</div>
              </div>
            )}
            <div>
              <div style={{ fontSize: 10, color: T.slate500, marginBottom: 2 }}>Min Payment</div>
              <div style={{ fontSize: 16, fontWeight: 700, color: T.amber }}>{fmt(a.payment)}</div>
            </div>
            <div>
              <div style={{ fontSize: 10, color: T.slate500, marginBottom: 2 }}>Due Date</div>
              <div style={{ fontSize: 14, fontWeight: 600, color: T.slate800 }}>{(() => {
                if (!a.dueDay) return "—";
                const t = new Date();
                let nd = new Date(t.getFullYear(), t.getMonth(), a.dueDay);
                if (nd < t) nd = new Date(t.getFullYear(), t.getMonth() + 1, a.dueDay);
                return nd.toLocaleDateString("en-US", { month: "short", day: "numeric" });
              })()}</div>
            </div>
          </div>

          {a.limit && (
            <div style={{ marginTop: 10 }}>
              <div style={{ fontSize: 10, color: T.slate400, marginBottom: 4 }}>Utilization: {pct(a.balance, a.limit)}%</div>
              <ProgressBar value={a.balance} max={a.limit} color={pct(a.balance,a.limit) > 30 ? T.amber : T.green} height={6} />
            </div>
          )}
        </Card>
      ))}
    </div>
  );
};

// ─── Section: General Ledger ──────────────────────────────────
const GLSection = ({ data }) => (
  <Card>
    <CardHeader
      title="General Ledger — Recent Entries"
      sub="Last 30 days · All accounts"
      action={<AskBtn context="I am reviewing my General Ledger recent entries. Help me verify these entries look correct and identify anything that needs attention." />}
    />
    <table style={{ width: "100%", borderCollapse: "collapse" }}>
      <thead>
        <tr style={{ borderBottom: `1px solid ${T.slate200}` }}>
          {["Date","Ref","Description","Account","Debit","Credit"].map((h,i) => (
            <th key={i} style={{ padding: "8px", fontSize: 11, fontWeight: 600, color: T.slate500, textAlign: i >= 4 ? "right" : "left" }}>{h}</th>
          ))}
        </tr>
      </thead>
      <tbody>
        {(Array.isArray(data?.glEntries) ? data.glEntries : []).map((r,i) => (
          <tr key={i} style={{ borderBottom: `1px solid ${T.slate100}` }}>
            <td style={{ padding: "8px", fontSize: 11, color: T.slate500 }}>{r.date}</td>
            <td style={{ padding: "8px", fontSize: 11, color: T.blue, fontFamily: "monospace" }}>{r.ref}</td>
            <td style={{ padding: "8px", fontSize: 12, color: T.slate800 }}>{r.description}</td>
            <td style={{ padding: "8px", fontSize: 11, color: T.slate500, fontFamily: "monospace" }}>{r.account}</td>
            <td style={{ padding: "8px", fontSize: 12, textAlign: "right", color: T.slate900, fontWeight: r.debit ? 500 : 400 }}>{r.debit ? fmt(r.debit) : "—"}</td>
            <td style={{ padding: "8px", fontSize: 12, textAlign: "right", color: T.green, fontWeight: r.credit ? 500 : 400 }}>{r.credit ? fmt(r.credit) : "—"}</td>
          </tr>
        ))}
      </tbody>
    </table>
  </Card>
);

// ─── Main Financials Module ───────────────────────────────────
// ============================================================
// FULL FINANCIAL REPORT — Item 1 (Kwame request 2026-06-24, v2 comprehensive)
// Print button generates a printable Full Financial Report:
//   - Cover + Executive KPI snapshot (Month / Quarter / YTD)
//   - Unified P&L with 6-column layout (M / M-PY / Q / Q-PY / YTD / YTD-PY)
//   - SF COMP_RECAP YTD summary by comp_type
//   - Payroll YTD summary + recent pay runs
//   - AIPP & ScoreBoard annual progress
// Reads from v_income_statement (unified pre+post cutover), comp_recap,
// payroll_runs, aipp_tracking, agency, settings.
// Landscape Letter for readable multi-period columns.
// ============================================================

// ── Date range helpers ───────────────────────────────────────
function monthRange(year, month /* 1-12 */) {
  const start = new Date(Date.UTC(year, month - 1, 1));
  const end = new Date(Date.UTC(year, month, 0));
  const iso = (d) => d.toISOString().slice(0, 10);
  return { start: iso(start), end: iso(end) };
}
function ytdRange(year, throughMonth /* 1-12 */) {
  const start = new Date(Date.UTC(year, 0, 1));
  const end = new Date(Date.UTC(year, throughMonth, 0));
  const iso = (d) => d.toISOString().slice(0, 10);
  return { start: iso(start), end: iso(end) };
}
function quarterThroughRange(year, month /* 1-12 */) {
  const qStart = Math.floor((month - 1) / 3) * 3 + 1;
  const start = new Date(Date.UTC(year, qStart - 1, 1));
  const end = new Date(Date.UTC(year, month, 0));
  const iso = (d) => d.toISOString().slice(0, 10);
  return { start: iso(start), end: iso(end) };
}

const MONTH_LABEL = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

// ── Data fetch ───────────────────────────────────────────────
async function fetchReportSource(asOfDate) {
  const asOf = asOfDate instanceof Date ? asOfDate : new Date(asOfDate);
  const currentYear = asOf.getUTCFullYear();
  const startISO = `${currentYear - 1}-01-01`;
  const endISO = asOf.toISOString().slice(0, 10);

  const [isRes, agencyRes, settingsRes, compRes, runsRes, aippRes] = await Promise.all([
    supabase.from("v_income_statement")
      .select("year, month, period_date, account_id, account_code, account_name, account_type, account_subtype, amount")
      .gte("period_date", startISO).lte("period_date", endISO)
      .order("period_date", { ascending: true }),
    supabase.from("agency").select("name").limit(1),
    supabase.from("settings").select("setting_key, setting_value").in("setting_key", ["gl_cutover_date"]),
    supabase.from("comp_recap")
      .select("period_year, period_month, comp_type, comp_category, description, amount, is_aipp_eligible, is_scoreboard_eligible")
      .eq("amount_type", "half_month_activity")
      .gte("period_year", currentYear - 1)
      .order("period_year", { ascending: false })
      .order("period_month", { ascending: false })
      .limit(3000),
    supabase.from("payroll_runs")
      .select("pay_period_start, pay_period_end, pay_date, gross_payroll, employer_taxes, net_payroll, status, payroll_provider, is_synthesized")
      .order("pay_date", { ascending: false })
      .limit(60),
    supabase.from("aipp_tracking")
      .select("program_year, target_amount, earned_ytd, projected_full_year, achievement_percentage, notes")
      .order("program_year", { ascending: false })
      .limit(3),
  ]);

  return {
    rows: (isRes && isRes.data) || [],
    agencyName: (agencyRes && agencyRes.data && agencyRes.data[0] && agencyRes.data[0].name) || "Tyler Insurance and Financial Services LLC",
    cutover: ((settingsRes && settingsRes.data) || []).find((s) => s.setting_key === "gl_cutover_date") ?
      ((settingsRes.data.find((s) => s.setting_key === "gl_cutover_date")) || {}).setting_value || "2026-04-30" :
      "2026-04-30",
    compRows: (compRes && compRes.data) || [],
    payrollRuns: (runsRes && runsRes.data) || [],
    aippRows: (aippRes && aippRes.data) || [],
  };
}

// ── P&L aggregator ───────────────────────────────────────────
function aggregateWindow(rows, startISO, endISO) {
  const byAccount = new Map();
  let totalIncome = 0;
  let totalExpense = 0;
  for (const r of rows) {
    const pd = r.period_date;
    if (!pd || pd < startISO || pd > endISO) continue;
    const key = r.account_id || `${r.account_code}|${r.account_name}`;
    const amount = parseFloat(r.amount || 0);
    const existing = byAccount.get(key) || {
      account_id: r.account_id,
      account_code: r.account_code || "",
      account_name: r.account_name || "(unnamed)",
      account_type: r.account_type,
      account_subtype: r.account_subtype || "other",
      amount: 0,
    };
    existing.amount += amount;
    byAccount.set(key, existing);
    if (r.account_type === "income") totalIncome += amount;
    else if (r.account_type === "expense") totalExpense += amount;
  }
  return {
    byAccount: Array.from(byAccount.values()),
    totalIncome, totalExpense,
    netIncome: totalIncome - totalExpense,
  };
}

// ── Build full comprehensive report ──────────────────────────
async function buildFullReport(asOfDate) {
  const asOf = asOfDate instanceof Date ? asOfDate : new Date(asOfDate);
  const y = asOf.getUTCFullYear();
  const m = asOf.getUTCMonth() + 1;
  const qNum = Math.ceil(m / 3);

  const src = await fetchReportSource(asOf);

  // Period windows
  const monthCurr = monthRange(y, m);
  const monthPrior = monthRange(y - 1, m);
  const qCurr = quarterThroughRange(y, m);
  const qPrior = quarterThroughRange(y - 1, m);
  const ytdCurr = ytdRange(y, m);
  const ytdPrior = ytdRange(y - 1, m);

  const aggMonth = aggregateWindow(src.rows, monthCurr.start, monthCurr.end);
  const aggMonthPY = aggregateWindow(src.rows, monthPrior.start, monthPrior.end);
  const aggQuarter = aggregateWindow(src.rows, qCurr.start, qCurr.end);
  const aggQuarterPY = aggregateWindow(src.rows, qPrior.start, qPrior.end);
  const aggYtd = aggregateWindow(src.rows, ytdCurr.start, ytdCurr.end);
  const aggYtdPY = aggregateWindow(src.rows, ytdPrior.start, ytdPrior.end);

  // KPI summary
  const kpis = {
    month: { label: `${MONTH_LABEL[m - 1]} ${y}`, range: `${monthCurr.start} to ${monthCurr.end}`,
      revenue: aggMonth.totalIncome, expenses: aggMonth.totalExpense, net: aggMonth.netIncome,
      pyRevenue: aggMonthPY.totalIncome, pyExpenses: aggMonthPY.totalExpense, pyNet: aggMonthPY.netIncome },
    quarter: { label: `Q${qNum} ${y} (through ${MONTH_LABEL[m - 1]})`, range: `${qCurr.start} to ${qCurr.end}`,
      revenue: aggQuarter.totalIncome, expenses: aggQuarter.totalExpense, net: aggQuarter.netIncome,
      pyRevenue: aggQuarterPY.totalIncome, pyExpenses: aggQuarterPY.totalExpense, pyNet: aggQuarterPY.netIncome },
    ytd: { label: `YTD ${y}`, range: `${ytdCurr.start} to ${ytdCurr.end}`,
      revenue: aggYtd.totalIncome, expenses: aggYtd.totalExpense, net: aggYtd.netIncome,
      pyRevenue: aggYtdPY.totalIncome, pyExpenses: aggYtdPY.totalExpense, pyNet: aggYtdPY.netIncome },
  };

  // Unified P&L: one row per account with 6 numeric columns
  const accountMap = new Map();
  const fold = (agg, colKey) => {
    for (const a of agg.byAccount) {
      const k = a.account_id || a.account_code;
      const cur = accountMap.get(k) || {
        code: a.account_code, name: a.account_name, type: a.account_type, subtype: a.account_subtype || "other",
        monthCurr: 0, monthPY: 0, quarterCurr: 0, quarterPY: 0, ytdCurr: 0, ytdPY: 0,
      };
      cur[colKey] = (cur[colKey] || 0) + a.amount;
      accountMap.set(k, cur);
    }
  };
  fold(aggMonth, "monthCurr"); fold(aggMonthPY, "monthPY");
  fold(aggQuarter, "quarterCurr"); fold(aggQuarterPY, "quarterPY");
  fold(aggYtd, "ytdCurr"); fold(aggYtdPY, "ytdPY");

  const accounts = Array.from(accountMap.values())
    .filter((a) => a.monthCurr || a.monthPY || a.quarterCurr || a.quarterPY || a.ytdCurr || a.ytdPY)
    .sort((a, b) => {
      if (a.type !== b.type) return a.type === "income" ? -1 : 1;
      return (a.code || "").localeCompare(b.code || "");
    });

  // SF COMP_RECAP — YTD by comp_type/category, monthly progression
  const compYtdByCat = new Map();
  const compYtdByType = new Map();
  const compMonthly = new Map();
  let compYtdTotal = 0;
  for (const c of src.compRows) {
    if (c.period_year !== y) continue;
    const amt = parseFloat(c.amount || 0);
    const catKey = `${c.comp_type || "?"} — ${c.comp_category || "?"}`;
    const typeKey = c.comp_type || "?";
    const monthKey = `${MONTH_LABEL[(c.period_month || 1) - 1]} ${c.period_year}`;
    compYtdByCat.set(catKey, (compYtdByCat.get(catKey) || 0) + amt);
    compYtdByType.set(typeKey, (compYtdByType.get(typeKey) || 0) + amt);
    compMonthly.set(monthKey, (compMonthly.get(monthKey) || 0) + amt);
    compYtdTotal += amt;
  }

  // Payroll YTD
  const ytdPayroll = src.payrollRuns
    .filter((r) => r.pay_date && r.pay_date.startsWith(String(y)))
    .reduce((acc, r) => {
      acc.gross += parseFloat(r.gross_payroll || 0);
      acc.taxes += parseFloat(r.employer_taxes || 0);
      acc.net += parseFloat(r.net_payroll || 0);
      acc.runs += 1;
      return acc;
    }, { gross: 0, taxes: 0, net: 0, runs: 0 });
  const recentPayroll = src.payrollRuns.slice(0, 10);

  // AIPP
  const aippCurrent = src.aippRows[0] || null;
  const aippPrior = src.aippRows[1] || null;

  return {
    asOfDate: asOf.toISOString().slice(0, 10),
    agencyName: src.agencyName,
    cutoverDate: src.cutover,
    periodLabels: {
      monthCurr: kpis.month.label, monthPY: `${MONTH_LABEL[m - 1]} ${y - 1}`,
      quarterCurr: `Q${qNum} ${y}`, quarterPY: `Q${qNum} ${y - 1}`,
      ytdCurr: `YTD ${y}`, ytdPY: `YTD ${y - 1}`,
      monthRange: `${monthCurr.start} to ${monthCurr.end}`,
      quarterRange: `${qCurr.start} to ${qCurr.end}`,
      ytdRange: `${ytdCurr.start} to ${ytdCurr.end}`,
    },
    kpis,
    accounts,
    compRecap: {
      currentYear: y,
      ytdByCategory: Array.from(compYtdByCat.entries()).sort((a, b) => Math.abs(b[1]) - Math.abs(a[1])),
      ytdByType: Array.from(compYtdByType.entries()).sort((a, b) => Math.abs(b[1]) - Math.abs(a[1])),
      monthlyTotals: Array.from(compMonthly.entries()),
      ytdTotal: compYtdTotal,
    },
    payroll: { ytd: ytdPayroll, recent: recentPayroll, currentYear: y },
    aipp: { current: aippCurrent, prior: aippPrior },
  };
}

// ── Printable HTML renderer ──────────────────────────────────
function generatePrintHtml(report, sections) {
  const fmtMoney = (n) => {
    const v = Number(n) || 0;
    const abs = Math.abs(v);
    const formatted = "$" + abs.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 0 });
    return v < 0 ? `(${formatted})` : formatted;
  };
  const fmtMoneyCents = (n) => {
    const v = Number(n) || 0;
    const abs = Math.abs(v);
    const formatted = "$" + abs.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    return v < 0 ? `(${formatted})` : formatted;
  };
  const fmtPct = (n) => {
    if (n === null || n === undefined || !Number.isFinite(n)) return "—";
    const sign = n > 0 ? "+" : "";
    return `${sign}${n.toFixed(1)}%`;
  };
  const pctDelta = (curr, prior) => {
    if (!Number.isFinite(prior) || prior === 0) return null;
    return ((curr - prior) / Math.abs(prior)) * 100;
  };
  const escapeHtml = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  // SECTION 1: Cover + KPI snapshot
  const renderCover = () => {
    const k = report.kpis;
    const expRatio = (rev, exp) => (rev > 0 ? (exp / rev) * 100 : null);
    const rows = [
      ["Total Revenue", k.month.revenue, k.month.pyRevenue, k.quarter.revenue, k.quarter.pyRevenue, k.ytd.revenue, k.ytd.pyRevenue],
      ["Total Expenses", k.month.expenses, k.month.pyExpenses, k.quarter.expenses, k.quarter.pyExpenses, k.ytd.expenses, k.ytd.pyExpenses],
      ["Net Income", k.month.net, k.month.pyNet, k.quarter.net, k.quarter.pyNet, k.ytd.net, k.ytd.pyNet],
    ];
    const ratios = [expRatio(k.month.revenue, k.month.expenses), expRatio(k.quarter.revenue, k.quarter.expenses), expRatio(k.ytd.revenue, k.ytd.expenses)];
    return `
      <section class="cover">
        <h2>Executive Summary</h2>
        <table class="kpi">
          <thead>
            <tr>
              <th></th>
              <th colspan="3">${escapeHtml(k.month.label)}</th>
              <th colspan="3">${escapeHtml(k.quarter.label)}</th>
              <th colspan="3">${escapeHtml(k.ytd.label)}</th>
            </tr>
            <tr class="sub">
              <th>Metric</th>
              <th class="num">Current</th><th class="num">Prior Year</th><th class="num">% Δ</th>
              <th class="num">Current</th><th class="num">Prior Year</th><th class="num">% Δ</th>
              <th class="num">Current</th><th class="num">Prior Year</th><th class="num">% Δ</th>
            </tr>
          </thead>
          <tbody>
            ${rows.map((r) => {
              const [name, mC, mP, qC, qP, yC, yP] = r;
              const mPct = pctDelta(mC, mP);
              const qPct = pctDelta(qC, qP);
              const yPct = pctDelta(yC, yP);
              const isExpense = name === "Total Expenses";
              const goodWhen = isExpense ? "neg" : "pos";
              const badWhen = isExpense ? "pos" : "neg";
              const cls = (pct) => pct === null ? "" : ((pct >= 0) === !isExpense ? "pos" : "neg");
              return `
                <tr${name === "Net Income" ? ' class="net"' : ""}>
                  <td class="acct">${escapeHtml(name)}</td>
                  <td class="num">${fmtMoney(mC)}</td><td class="num">${fmtMoney(mP)}</td><td class="num ${cls(mPct)}">${fmtPct(mPct)}</td>
                  <td class="num">${fmtMoney(qC)}</td><td class="num">${fmtMoney(qP)}</td><td class="num ${cls(qPct)}">${fmtPct(qPct)}</td>
                  <td class="num">${fmtMoney(yC)}</td><td class="num">${fmtMoney(yP)}</td><td class="num ${cls(yPct)}">${fmtPct(yPct)}</td>
                </tr>`;
            }).join("")}
            <tr class="subtle">
              <td class="acct">Expense Ratio</td>
              <td class="num" colspan="3">${ratios[0] === null ? "—" : ratios[0].toFixed(1) + "%"}</td>
              <td class="num" colspan="3">${ratios[1] === null ? "—" : ratios[1].toFixed(1) + "%"}</td>
              <td class="num" colspan="3">${ratios[2] === null ? "—" : ratios[2].toFixed(1) + "%"}</td>
            </tr>
          </tbody>
        </table>
      </section>`;
  };

  // SECTION 2: Profit & Loss — wide table
  const renderPL = () => {
    const acc = report.accounts;
    const income = acc.filter((a) => a.type === "income");
    const expense = acc.filter((a) => a.type === "expense");
    const k = report.kpis;
    const rowFor = (a) => {
      const mPct = pctDelta(a.monthCurr, a.monthPY);
      const qPct = pctDelta(a.quarterCurr, a.quarterPY);
      const yPct = pctDelta(a.ytdCurr, a.ytdPY);
      const isExpense = a.type === "expense";
      const cls = (pct) => pct === null ? "" : ((pct >= 0) === !isExpense ? "pos" : "neg");
      return `
        <tr>
          <td class="acct">${escapeHtml(a.code)} ${escapeHtml(a.name)}</td>
          <td class="num">${fmtMoney(a.monthCurr)}</td><td class="num">${fmtMoney(a.monthPY)}</td><td class="num ${cls(mPct)}">${fmtPct(mPct)}</td>
          <td class="num">${fmtMoney(a.quarterCurr)}</td><td class="num">${fmtMoney(a.quarterPY)}</td><td class="num ${cls(qPct)}">${fmtPct(qPct)}</td>
          <td class="num">${fmtMoney(a.ytdCurr)}</td><td class="num">${fmtMoney(a.ytdPY)}</td><td class="num ${cls(yPct)}">${fmtPct(yPct)}</td>
        </tr>`;
    };
    const subtotalRow = (label, currs, isExpense) => {
      const mPct = pctDelta(currs.mC, currs.mP);
      const qPct = pctDelta(currs.qC, currs.qP);
      const yPct = pctDelta(currs.yC, currs.yP);
      const cls = (pct) => pct === null ? "" : ((pct >= 0) === !isExpense ? "pos" : "neg");
      return `
        <tr class="subtotal">
          <td class="acct">${label}</td>
          <td class="num">${fmtMoney(currs.mC)}</td><td class="num">${fmtMoney(currs.mP)}</td><td class="num ${cls(mPct)}">${fmtPct(mPct)}</td>
          <td class="num">${fmtMoney(currs.qC)}</td><td class="num">${fmtMoney(currs.qP)}</td><td class="num ${cls(qPct)}">${fmtPct(qPct)}</td>
          <td class="num">${fmtMoney(currs.yC)}</td><td class="num">${fmtMoney(currs.yP)}</td><td class="num ${cls(yPct)}">${fmtPct(yPct)}</td>
        </tr>`;
    };
    return `
      <section class="pl">
        <h2>Profit &amp; Loss Statement</h2>
        <p class="hint">All three periods shown side-by-side with prior-year comparison.</p>
        <table class="pl-table">
          <thead>
            <tr>
              <th class="acct" rowspan="2">Account</th>
              <th colspan="3">${escapeHtml(report.periodLabels.monthCurr)}</th>
              <th colspan="3">${escapeHtml(report.periodLabels.quarterCurr)}</th>
              <th colspan="3">${escapeHtml(report.periodLabels.ytdCurr)}</th>
            </tr>
            <tr class="sub">
              <th class="num">Current</th><th class="num">Prior</th><th class="num">% Δ</th>
              <th class="num">Current</th><th class="num">Prior</th><th class="num">% Δ</th>
              <th class="num">Current</th><th class="num">Prior</th><th class="num">% Δ</th>
            </tr>
          </thead>
          <tbody>
            <tr class="group"><td colspan="10">REVENUE</td></tr>
            ${income.map(rowFor).join("") || '<tr><td colspan="10" class="empty">No revenue activity.</td></tr>'}
            ${subtotalRow("Total Revenue", {
              mC: k.month.revenue, mP: k.month.pyRevenue,
              qC: k.quarter.revenue, qP: k.quarter.pyRevenue,
              yC: k.ytd.revenue, yP: k.ytd.pyRevenue,
            }, false)}
            <tr class="group"><td colspan="10">OPERATING EXPENSES</td></tr>
            ${expense.map(rowFor).join("") || '<tr><td colspan="10" class="empty">No expense activity.</td></tr>'}
            ${subtotalRow("Total Expenses", {
              mC: k.month.expenses, mP: k.month.pyExpenses,
              qC: k.quarter.expenses, qP: k.quarter.pyExpenses,
              yC: k.ytd.expenses, yP: k.ytd.pyExpenses,
            }, true)}
            ${subtotalRow("NET INCOME", {
              mC: k.month.net, mP: k.month.pyNet,
              qC: k.quarter.net, qP: k.quarter.pyNet,
              yC: k.ytd.net, yP: k.ytd.pyNet,
            }, false).replace("subtotal", "net")}
          </tbody>
        </table>
      </section>`;
  };

  // SECTION 3: SF COMP_RECAP YTD
  const renderCompRecap = () => {
    const c = report.compRecap;
    const topCategories = c.ytdByCategory.slice(0, 20);
    const monthlyRows = c.monthlyTotals.map(([month, amt]) => `<tr><td class="acct">${escapeHtml(month)}</td><td class="num">${fmtMoneyCents(amt)}</td></tr>`).join("");
    const catRows = topCategories.map(([cat, amt]) => `<tr><td class="acct">${escapeHtml(cat)}</td><td class="num">${fmtMoneyCents(amt)}</td></tr>`).join("");
    const typeRows = c.ytdByType.map(([type, amt]) => `<tr><td class="acct">${escapeHtml(type)}</td><td class="num">${fmtMoneyCents(amt)}</td></tr>`).join("");
    return `
      <section class="comp">
        <h2>SF COMP_RECAP — YTD ${escapeHtml(String(c.currentYear))}</h2>
        <p class="hint">State Farm compensation activity for the calendar year. YTD total: <strong>${fmtMoneyCents(c.ytdTotal)}</strong></p>
        <div class="two-col">
          <div>
            <h3>By Compensation Type</h3>
            <table class="mini">
              <thead><tr><th class="acct">Type</th><th class="num">YTD</th></tr></thead>
              <tbody>${typeRows || '<tr><td colspan="2" class="empty">No data.</td></tr>'}</tbody>
            </table>
          </div>
          <div>
            <h3>Monthly Compensation Activity</h3>
            <table class="mini">
              <thead><tr><th class="acct">Month</th><th class="num">Activity</th></tr></thead>
              <tbody>${monthlyRows || '<tr><td colspan="2" class="empty">No data.</td></tr>'}</tbody>
            </table>
          </div>
        </div>
        <h3>Top Categories (Top 20)</h3>
        <table class="mini wide">
          <thead><tr><th class="acct">Category</th><th class="num">YTD Amount</th></tr></thead>
          <tbody>${catRows || '<tr><td colspan="2" class="empty">No data.</td></tr>'}</tbody>
        </table>
      </section>`;
  };

  // SECTION 4: Payroll YTD
  const renderPayroll = () => {
    const p = report.payroll;
    const recentRows = p.recent.map((r) => {
      const start = r.pay_period_start ? new Date(r.pay_period_start) : null;
      const end = r.pay_period_end ? new Date(r.pay_period_end) : null;
      const paid = r.pay_date ? new Date(r.pay_date) : null;
      const fmtD = (d) => d ? d.toISOString().slice(0, 10) : "—";
      return `
        <tr>
          <td class="acct">${fmtD(start)} – ${fmtD(end)}</td>
          <td class="acct">${fmtD(paid)}</td>
          <td class="num">${fmtMoneyCents(r.gross_payroll || 0)}</td>
          <td class="num">${fmtMoneyCents(r.employer_taxes || 0)}</td>
          <td class="num">${fmtMoneyCents(r.net_payroll || 0)}</td>
          <td class="acct">${escapeHtml(r.status || "")}${r.is_synthesized ? " †" : ""}</td>
        </tr>`;
    }).join("");
    return `
      <section class="payroll">
        <h2>Payroll — YTD ${escapeHtml(String(p.currentYear))}</h2>
        <table class="kpi-strip">
          <tr>
            <td><div class="kpi-lbl">YTD Gross</div><div class="kpi-val">${fmtMoneyCents(p.ytd.gross)}</div></td>
            <td><div class="kpi-lbl">YTD Employer Taxes</div><div class="kpi-val">${fmtMoneyCents(p.ytd.taxes)}</div></td>
            <td><div class="kpi-lbl">YTD Net Payroll</div><div class="kpi-val">${fmtMoneyCents(p.ytd.net)}</div></td>
            <td><div class="kpi-lbl">Pay Runs</div><div class="kpi-val">${p.ytd.runs}</div></td>
          </tr>
        </table>
        <h3>Most Recent Pay Runs</h3>
        <table class="mini wide">
          <thead>
            <tr>
              <th class="acct">Pay Period</th><th class="acct">Pay Date</th>
              <th class="num">Gross</th><th class="num">ER Taxes</th><th class="num">Net</th>
              <th class="acct">Status</th>
            </tr>
          </thead>
          <tbody>${recentRows || '<tr><td colspan="6" class="empty">No pay runs.</td></tr>'}</tbody>
        </table>
        <p class="hint">† marker = run synthesized from bank transactions; actual Paychex statement pending.</p>
      </section>`;
  };

  // SECTION 5: AIPP & ScoreBoard
  const renderAipp = () => {
    const a = report.aipp;
    if (!a.current) return `
      <section class="aipp">
        <h2>AIPP &amp; ScoreBoard</h2>
        <p class="empty">No AIPP tracking data available.</p>
      </section>`;
    const cur = a.current;
    const pri = a.prior;
    const target = parseFloat(cur.target_amount || 0);
    const earned = parseFloat(cur.earned_ytd || 0);
    const projected = parseFloat(cur.projected_full_year || 0);
    const pct = target > 0 ? (earned / target) * 100 : 0;
    const priorEarned = pri ? parseFloat(pri.earned_ytd || 0) : null;
    const priorYr = pri ? pri.program_year : null;
    return `
      <section class="aipp">
        <h2>AIPP Progress — Program Year ${escapeHtml(String(cur.program_year))}</h2>
        <table class="kpi-strip">
          <tr>
            <td><div class="kpi-lbl">Annual Target</div><div class="kpi-val">${fmtMoneyCents(target)}</div></td>
            <td><div class="kpi-lbl">Earned YTD</div><div class="kpi-val">${fmtMoneyCents(earned)}</div></td>
            <td><div class="kpi-lbl">Projected Full-Year</div><div class="kpi-val">${fmtMoneyCents(projected)}</div></td>
            <td><div class="kpi-lbl">Achievement</div><div class="kpi-val">${pct.toFixed(1)}%</div></td>
          </tr>
        </table>
        ${pri ? `<p class="hint">Prior program year (${escapeHtml(String(priorYr))}) earned: <strong>${fmtMoneyCents(priorEarned)}</strong>. AIPP pays Jan ${escapeHtml(String((cur.program_year || 0)))} on ${escapeHtml(String((cur.program_year || 0) - 1))} qualifying activity.</p>` : ""}
        ${cur.notes ? `<p class="hint">Notes: ${escapeHtml(cur.notes)}</p>` : ""}
      </section>`;
  };

  // CSS — landscape Letter, optimized for multi-column tables
  const styles = `
    @page { size: letter landscape; margin: 0.4in 0.4in 0.4in 0.4in; }
    * { box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif; color: #1B2B4B; margin: 0; padding: 12px; font-size: 10px; }
    header.report { border-bottom: 2px solid #1B2B4B; padding-bottom: 8px; margin-bottom: 12px; }
    header.report h1 { margin: 0 0 3px 0; font-size: 17px; }
    header.report .meta { font-size: 10px; color: #475569; }
    header.report .lineage { font-size: 9px; color: #64748B; margin-top: 5px; font-style: italic; line-height: 1.4; }
    section { page-break-after: always; }
    section:last-child { page-break-after: auto; }
    section h2 { font-size: 13px; margin: 0 0 4px 0; padding-bottom: 3px; border-bottom: 1px solid #CBD5E1; color: #1B2B4B; }
    section h3 { font-size: 11px; margin: 10px 0 4px 0; color: #1B2B4B; }
    section p.hint { font-size: 9px; color: #64748B; font-style: italic; margin: 0 0 8px 0; }
    section p.empty { font-size: 11px; color: #94A3B8; font-style: italic; }
    table { width: 100%; border-collapse: collapse; }
    th, td { padding: 3px 5px; text-align: left; vertical-align: top; }
    th { background: #F1F5F9; font-size: 9px; font-weight: 600; border-bottom: 1px solid #94A3B8; }
    th.num, td.num { text-align: right; font-variant-numeric: tabular-nums; }
    th.acct, td.acct { width: auto; text-align: left; }
    tr.group td { background: #1B2B4B; color: #fff; font-weight: 600; padding: 4px 6px; font-size: 9px; letter-spacing: 0.05em; }
    tr.subtotal td { border-top: 1px solid #94A3B8; background: #F8FAFC; font-weight: 600; }
    tr.subtle td { background: #F8FAFC; color: #475569; font-size: 9px; }
    tr.net td { border-top: 2px solid #1B2B4B; background: #EFF6FF; font-weight: 700; font-size: 11px; padding: 6px 5px; }
    td.empty { text-align: center; color: #94A3B8; font-style: italic; padding: 8px; }
    td.pos { color: #047857; }
    td.neg { color: #B91C1C; }
    table.kpi th[colspan] { text-align: center; background: #1B2B4B; color: #fff; font-size: 10px; padding: 5px 6px; }
    table.kpi th.sub { background: #F1F5F9; color: #1B2B4B; font-size: 9px; }
    table.kpi-strip td { width: 25%; padding: 8px 10px; background: #F8FAFC; border: 1px solid #E2E8F0; }
    table.kpi-strip .kpi-lbl { font-size: 9px; color: #64748B; }
    table.kpi-strip .kpi-val { font-size: 14px; font-weight: 700; color: #1B2B4B; margin-top: 2px; }
    table.mini th, table.mini td { font-size: 9.5px; padding: 3px 5px; }
    table.mini.wide { width: 100%; }
    .two-col { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
    table.pl-table th.acct, table.pl-table td.acct { width: 24%; }
    table.pl-table th.num, table.pl-table td.num { width: 8.4%; }
    footer.report { margin-top: 12px; padding-top: 6px; border-top: 1px solid #CBD5E1; font-size: 8px; color: #64748B; text-align: center; }
    @media print { body { padding: 0; } .no-print { display: none; } }
  `;

  const head = `
    <header class="report">
      <h1>${escapeHtml(report.agencyName)}</h1>
      <div class="meta">Full Financial Report &mdash; As of ${escapeHtml(report.asOfDate)} &middot; Cash basis &middot; All figures in USD</div>
      <p class="lineage">
        DATA LINEAGE: Periods through ${escapeHtml(report.cutoverDate)} reflect CPA-prepared monthly P&amp;L (income-tax basis).
        Periods after ${escapeHtml(report.cutoverDate)} reflect live BCC General Ledger postings (cash basis).
        The unified view blends both sources at the account level so year-over-year comparisons are apples-to-apples at the account level.
      </p>
    </header>`;

  const sel = sections || { kpi: true, pl: true, comp: true, payroll: true, aipp: true };
  const body = [
    sel.kpi     && renderCover(),
    sel.pl      && renderPL(),
    sel.comp    && renderCompRecap(),
    sel.payroll && renderPayroll(),
    sel.aipp    && renderAipp(),
  ].filter(Boolean).join("\n");
  const foot = `<footer class="report">Generated by Business Command Center &middot; ${escapeHtml(report.agencyName)} &middot; ${escapeHtml(new Date().toISOString())}</footer>`;

  return `<!DOCTYPE html><html><head><meta charset="utf-8"/><title>Full Financial Report &mdash; ${escapeHtml(report.asOfDate)}</title><style>${styles}</style></head><body>${head}${body}${foot}<script>window.addEventListener("load",function(){setTimeout(function(){window.print();},250);});</script></body></html>`;
}


export default function Financials() {
  const [section, setSection] = useState("overview");
  const [period, setPeriod] = useState("mtd");
  const [printing, setPrinting] = useState(false);
  const [printError, setPrintError] = useState(null);
  const [showPrintMenu, setShowPrintMenu] = useState(false);
  const [printSections, setPrintSections] = useState({
    kpi: true, pl: true, comp: true, payroll: true, aipp: true,
  });
  const printMenuRef = useRef(null);

  // Close print menu on outside click
  useEffect(() => {
    if (!showPrintMenu) return undefined;
    const handleDocClick = (e) => {
      if (printMenuRef.current && !printMenuRef.current.contains(e.target)) {
        setShowPrintMenu(false);
      }
    };
    document.addEventListener("mousedown", handleDocClick);
    return () => document.removeEventListener("mousedown", handleDocClick);
  }, [showPrintMenu]);
  const { data: liveData, loading } = useFinancialsData();
  if (liveData) MOCK = liveData;

  const sections = [
    { id: "overview",  label: "Overview"        },
    { id: "pl",        label: "P&L"             },
    { id: "comp",      label: "COMP_RECAP"      },
    { id: "aipp",      label: "AIPP & ScoreBoard"},
    { id: "payroll",   label: "Payroll"         },
    { id: "bank",      label: "Bank Accounts"   },
    { id: "credit",    label: "Credit & Debt"   },
    { id: "gl",        label: "General Ledger"  },
  ];

  async function executePrint(sectionsToInclude) {
    if (printing) return;
    const sel = sectionsToInclude || { kpi: true, pl: true, comp: true, payroll: true, aipp: true };
    if (!Object.values(sel).some(Boolean)) {
      setPrintError("Select at least one section to print.");
      return;
    }
    setPrinting(true);
    setPrintError(null);
    setShowPrintMenu(false);
    // Open a blank window synchronously so the popup blocker is happy.
    const win = window.open("", "_blank", "width=1100,height=900");
    if (!win) {
      setPrinting(false);
      setPrintError("Pop-up blocked. Allow pop-ups for this site to print the report.");
      return;
    }
    win.document.write('<!DOCTYPE html><html><head><title>Generating report...</title><style>body{font-family:-apple-system,BlinkMacSystemFont,sans-serif;padding:40px;color:#1B2B4B}</style></head><body><h2>Generating Financial Report...</h2><p>Pulling data from v_income_statement, comp_recap, payroll_runs, and aipp_tracking. This usually takes a few seconds.</p></body></html>');
    try {
      const report = await buildFullReport(new Date());
      const html = generatePrintHtml(report, sel);
      win.document.open();
      win.document.write(html);
      win.document.close();
    } catch (e) {
      console.error("Print report error:", e);
      setPrintError(e && e.message ? e.message : String(e));
      try {
        win.document.open();
        win.document.write('<!DOCTYPE html><html><body style="font-family:sans-serif;padding:40px;color:#B91C1C"><h2>Report generation failed</h2><pre>' + String((e && e.message) || e) + '</pre><p>Please report this in chat. The session log will have the full error.</p></body></html>');
        win.document.close();
      } catch (_) { /* noop */ }
    } finally {
      setPrinting(false);
    }
  }

  const SECTION_DEFS = [
    { key: "kpi",     label: "Executive Summary",          desc: "Revenue / Expenses / Net Income for Month, Quarter, YTD with prior-year comparison" },
    { key: "pl",      label: "Profit & Loss Statement",    desc: "Account-level P&L across all three periods with prior-year columns" },
    { key: "comp",    label: "SF COMP_RECAP YTD",          desc: "State Farm compensation by type, monthly progression, and top categories" },
    { key: "payroll", label: "Payroll YTD",                desc: "YTD gross / employer taxes / net + most recent pay runs" },
    { key: "aipp",    label: "AIPP & ScoreBoard Progress", desc: "Annual incentive target / earned / projected for the current program year" },
  ];

  const allSelected  = SECTION_DEFS.every((s) => printSections[s.key]);
  const noneSelected = SECTION_DEFS.every((s) => !printSections[s.key]);

  function toggleSection(key) {
    setPrintSections((prev) => ({ ...prev, [key]: !prev[key] }));
  }
  function selectAll()  { setPrintSections({ kpi: true,  pl: true,  comp: true,  payroll: true,  aipp: true  }); }
  function selectNone() { setPrintSections({ kpi: false, pl: false, comp: false, payroll: false, aipp: false }); }

  return (
    <div>
      {/* Module Header */}
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", marginBottom: 16 }}>
        <div>
          <div style={{ fontSize: 20, fontWeight: 700, color: T.slate900, letterSpacing: "-0.02em" }}>Financials</div>
          <div style={{ fontSize: 12, color: T.slate500, marginTop: 3 }}>
            Cash basis · Calendar year · All figures in USD
          </div>
          {printError && (
            <div style={{ fontSize: 11, color: T.red, marginTop: 4 }}>Print error: {printError}</div>
          )}
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <div style={{ position: "relative" }} ref={printMenuRef}>
            <button
              onClick={() => setShowPrintMenu((v) => !v)}
              disabled={printing}
              title="Open the print menu to choose sections, or print the full report in one click"
              style={{
                padding: "8px 14px", fontSize: 12, fontWeight: 600,
                color: T.white, background: printing ? T.slate500 : T.navy,
                border: "none", borderRadius: 7, cursor: printing ? "wait" : "pointer",
                boxShadow: "0 1px 3px rgba(0,0,0,0.08)",
                transition: "all 0.12s",
              }}
            >
              {printing ? "Building report..." : "🖨️  Print Report \u25BE"}
            </button>
            {showPrintMenu && (
              <div style={{
                position: "absolute", right: 0, top: "calc(100% + 6px)",
                background: T.white, border: `1px solid ${T.slate200 || "#E2E8F0"}`,
                borderRadius: 10, padding: 14, minWidth: 360,
                boxShadow: "0 10px 30px rgba(15,23,42,0.18)",
                zIndex: 100,
              }}>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
                  <div style={{ fontWeight: 700, fontSize: 13, color: T.slate900 }}>Print Financial Report</div>
                  <button
                    onClick={() => setShowPrintMenu(false)}
                    style={{ background: "transparent", border: "none", color: T.slate500, cursor: "pointer", fontSize: 16, padding: 0, lineHeight: 1 }}
                    title="Close"
                  >×</button>
                </div>
                <div style={{ fontSize: 11, color: T.slate500, marginBottom: 10 }}>
                  Choose which sections to include. All sections are selected by default.
                </div>
                <div style={{ display: "flex", flexDirection: "column", gap: 6, marginBottom: 10 }}>
                  {SECTION_DEFS.map((s) => (
                    <label key={s.key} style={{ display: "flex", alignItems: "flex-start", gap: 8, padding: "6px 8px", borderRadius: 6, cursor: "pointer", background: printSections[s.key] ? T.blueLt : "transparent" }}>
                      <input
                        type="checkbox"
                        checked={!!printSections[s.key]}
                        onChange={() => toggleSection(s.key)}
                        style={{ marginTop: 2 }}
                      />
                      <span style={{ flex: 1 }}>
                        <span style={{ display: "block", fontSize: 12, fontWeight: 600, color: T.slate900 }}>{s.label}</span>
                        <span style={{ display: "block", fontSize: 10, color: T.slate500, marginTop: 1 }}>{s.desc}</span>
                      </span>
                    </label>
                  ))}
                </div>
                <div style={{ display: "flex", gap: 6, justifyContent: "space-between", alignItems: "center", borderTop: `1px solid ${T.slate100}`, paddingTop: 10 }}>
                  <div style={{ display: "flex", gap: 6 }}>
                    <button
                      onClick={selectAll}
                      disabled={allSelected}
                      style={{ padding: "5px 10px", fontSize: 11, color: T.blue, background: "transparent", border: `1px solid ${T.slate200 || "#E2E8F0"}`, borderRadius: 5, cursor: allSelected ? "default" : "pointer", opacity: allSelected ? 0.5 : 1 }}
                    >All</button>
                    <button
                      onClick={selectNone}
                      disabled={noneSelected}
                      style={{ padding: "5px 10px", fontSize: 11, color: T.slate500, background: "transparent", border: `1px solid ${T.slate200 || "#E2E8F0"}`, borderRadius: 5, cursor: noneSelected ? "default" : "pointer", opacity: noneSelected ? 0.5 : 1 }}
                    >None</button>
                  </div>
                  <div style={{ display: "flex", gap: 6 }}>
                    <button
                      onClick={() => setShowPrintMenu(false)}
                      style={{ padding: "6px 12px", fontSize: 11, color: T.slate500, background: T.white, border: `1px solid ${T.slate200 || "#E2E8F0"}`, borderRadius: 5, cursor: "pointer" }}
                    >Cancel</button>
                    <button
                      onClick={() => executePrint(printSections)}
                      disabled={noneSelected || printing}
                      style={{ padding: "6px 14px", fontSize: 11, fontWeight: 600, color: T.white, background: (noneSelected || printing) ? T.slate500 : T.navy, border: "none", borderRadius: 5, cursor: (noneSelected || printing) ? "default" : "pointer" }}
                    >Print Selected</button>
                  </div>
                </div>
              </div>
            )}
          </div>
          <AskBtn context="I am reviewing my agency financials. Help me get a complete picture of my financial health, identify any concerns, and suggest what I should focus on." />
        </div>
      </div>

      {/* Section Navigation */}
      <div style={{
        display: "flex", gap: 2, flexWrap: "wrap",
        background: T.slate100, borderRadius: 10,
        padding: 4, marginBottom: 18,
      }}>
        {sections.map(s => (
          <button key={s.id} onClick={() => setSection(s.id)} style={{
            padding: "7px 14px", fontSize: 12,
            fontWeight: section === s.id ? 600 : 400,
            color: section === s.id ? T.slate900 : T.slate500,
            background: section === s.id ? T.white : "transparent",
            border: "none", borderRadius: 7, cursor: "pointer",
            transition: "all 0.12s",
            boxShadow: section === s.id ? "0 1px 3px rgba(0,0,0,0.08)" : "none",
          }}>{s.label}</button>
        ))}
      </div>

      {/* Section Content */}
      {section === "overview" && <OverviewSection period={period} setPeriod={setPeriod} data={MOCK} />}
      {section === "pl"       && <PLSection data={MOCK} />}
      {section === "comp"     && <CompRecapSection data={MOCK} />}
      {section === "aipp"     && <AIPPSection data={MOCK} />}
      {section === "payroll"  && <PayrollSection data={MOCK} />}
      {section === "bank"     && <BankSection data={MOCK} />}
      {section === "credit"   && <CreditSection data={MOCK} />}
      {section === "gl"       && <GLSection data={MOCK} />}
    </div>
  );
}

