import { useState, useEffect, useRef } from "react";
import { supabase, AGENCY_ID } from "../lib/supabase.js";

// ============================================================
// BCC PERSISTENT MEMORY MODULE v2.0
// Business Command Center — Tyler Insurance and Financial Services LLC
// Built by Imaginary Farms LLC · imaginary-farms.com
//
// v2.0 (2026-06-18): Wired to live persistent_memory table.
//   Mock data removed. Live read + write + soft delete.
//   Adds full category coverage (15 real DB categories), with
//   session_note + rebecca_handoff_flag collapsed by default
//   (audit trail kept available, primary brain stays focused).
//
// PURPOSE:
// The agency brain. Every entry here is passed to Claude as
// context at the start of each conversation.
//
// DATA: Reads/writes public.persistent_memory in Supabase.
//   Soft delete sets is_active=false. New rows insert with
//   added_by='owner_manual', source='web_app_edit'.
// ============================================================


// ─── Design Tokens ────────────────────────────────────────────
const T = {
  navy:    "#1B2B4B",
  blue:    "#2D7DD2",
  blueLt:  "#EFF6FF",
  indigo:  "#4F46E5",
  indigoLt:"#EEF2FF",
  green:   "#10B981",
  greenLt: "#D1FAE5",
  emerald: "#059669",
  emeraldLt:"#ECFDF5",
  amber:   "#F59E0B",
  amberLt: "#FEF3C7",
  orange:  "#EA580C",
  orangeLt:"#FFF7ED",
  red:     "#EF4444",
  redLt:   "#FEE2E2",
  purple:  "#7C3AED",
  purpleLt:"#EDE9FE",
  pink:    "#DB2777",
  pinkLt:  "#FCE7F3",
  teal:    "#0D9488",
  tealLt:  "#CCFBF1",
  cyan:    "#0891B2",
  cyanLt:  "#ECFEFF",
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
// `collapsed: true` means the section starts hidden in the "All
// Memories" view (audit-trail buckets). They still appear in the
// sidebar with full counts and open normally when clicked into.
const CATEGORIES = [
  { id: "agency_profile",      label: "Agency Profile",       icon: "🏢", color: T.blue,    colorLt: T.blueLt,    description: "Entity details, licensing, contacts" },
  { id: "business_context",    label: "Business Context",     icon: "📊", color: T.indigo,  colorLt: T.indigoLt,  description: "Current business state and posture" },
  { id: "goals",               label: "Goals & Priorities",   icon: "🎯", color: T.amber,   colorLt: T.amberLt,   description: "Targets, priorities, milestones" },
  { id: "financial_context",   label: "Financial Context",    icon: "💰", color: T.green,   colorLt: T.greenLt,   description: "Accounting setup, CPA, comp structure" },
  { id: "aipp_intelligence",   label: "AIPP Intelligence",    icon: "📈", color: T.emerald, colorLt: T.emeraldLt, description: "AIPP formulas, ScoreBoard L&H multiplier, comp_recap query patterns" },
  { id: "sf_compensation",     label: "SF Compensation",      icon: "💵", color: T.teal,    colorLt: T.tealLt,    description: "1099, federal totals, year-end packets" },
  { id: "key_contacts",        label: "Key Contacts",         icon: "🤝", color: T.cyan,    colorLt: T.cyanLt,    description: "CPA, SF field, install partner, vendors" },
  { id: "accounting_rules",    label: "Accounting Rules",     icon: "📒", color: T.slate700,colorLt: T.slate100,  description: "Cash basis, PFA, equity, income map" },
  { id: "business_rules",      label: "Business Rules",       icon: "⚙️", color: T.navy,    colorLt: T.slate100,  description: "Standing rules — GL writers, BENEFITS wash, mapping" },
  { id: "compliance_rules",    label: "Compliance Rules",     icon: "🛡️", color: T.red,     colorLt: T.redLt,     description: "AA05 word rules, prohibited topics, social checklist" },
  { id: "operational_rules",   label: "Operational Rules",    icon: "🔧", color: T.orange,  colorLt: T.orangeLt,  description: "GL cutover, role clarification, hard-learned patterns" },
  { id: "communication_prefs", label: "Communication Prefs",  icon: "💬", color: T.pink,    colorLt: T.pinkLt,    description: "Tone, channels, timezone, response style" },
  { id: "technical_state",     label: "Technical State",      icon: "🔬", color: T.purple,  colorLt: T.purpleLt,  description: "Edge Function versions, schema notes, migrations" },
  { id: "session_note",        label: "Session Notes",        icon: "📝", color: T.slate500,colorLt: T.slate100,  description: "Chronological handoff log between Claude sessions", collapsed: true },
  { id: "rebecca_handoff_flag",label: "Archived Flags",       icon: "🗄️", color: T.slate400,colorLt: T.slate100,  description: "Archived install-era flags (retained for audit)", collapsed: true },
];

const CATEGORY_BY_ID = Object.fromEntries(CATEGORIES.map(c => [c.id, c]));

// Fallback config for any category that exists in the DB but isn't
// listed above. Keeps the UI from dropping rows silently.
const UNKNOWN_CATEGORY = {
  id: "unknown", label: "Other", icon: "•", color: T.slate500, colorLt: T.slate100,
  description: "Uncategorized entries", collapsed: true,
};

// ─── Shared Components ────────────────────────────────────────
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

// ─── Memory Card ──────────────────────────────────────────────
const MemoryCard = ({ item, categoryConfig, onEdit }) => {
  const [expanded, setExpanded] = useState(false);
  const content = item.content || "";
  const lines = content.split("\n").filter(Boolean);
  const preview = lines.slice(0, 3).join("\n");
  const hasMore = lines.length > 3;
  const sourceDisplay = (item.source || "manual").replace(/_/g, " ");
  const addedByDisplay = item.added_by || "system";
  const updatedDisplay = item.updated_at ? new Date(item.updated_at).toISOString().slice(0,10) : null;

  return (
    <div style={{
      background: T.white,
      border: `1px solid ${T.slate200}`,
      borderRadius: 12,
      overflow: "hidden",
      borderLeft: `4px solid ${categoryConfig.color}`,
    }}>
      <div style={{ padding: "12px 14px", display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 8 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: T.slate800, marginBottom: 2 }}>
            {item.title || "(untitled)"}
          </div>
          <div style={{ fontSize: 10, color: T.slate400 }}>
            Added by {addedByDisplay} · {sourceDisplay}{updatedDisplay ? ` \u00b7 updated ${updatedDisplay}` : ""}
          </div>
        </div>
        <div style={{ display: "flex", gap: 6, flexShrink: 0 }}>
          <AskBtn size="small" context={`Memory context — ${item.title}:\n\n${item.content}\n\nHelp me review and update this information if needed.`} />
          <button
            onClick={() => onEdit(item)}
            style={{
              padding: "5px 10px", fontSize: 10, fontWeight: 600,
              color: T.slate600, background: T.slate100,
              border: `1px solid ${T.slate200}`,
              borderRadius: 6, cursor: "pointer",
            }}
          >Edit</button>
        </div>
      </div>

      <div style={{ padding: "0 14px 12px", fontSize: 12, color: T.slate700, lineHeight: 1.7, whiteSpace: "pre-line", wordBreak: "break-word" }}>
        {expanded ? content : preview}
        {hasMore && (
          <button
            onClick={() => setExpanded(e => !e)}
            style={{
              display: "block", marginTop: 6,
              fontSize: 11, color: T.blue,
              background: "none", border: "none",
              cursor: "pointer", padding: 0, fontWeight: 500,
            }}
          >
            {expanded ? "Show less \u2191" : `Show more (${lines.length - 3} more lines) \u2193`}
          </button>
        )}
      </div>
    </div>
  );
};

// ─── Edit Modal ───────────────────────────────────────────────
const EditModal = ({ item, categories, onSave, onCancel, onDelete, saving }) => {
  // NOTE: useState(item?.X) captures the prop value at first mount only. When the
  // modal stays mounted and item changes (e.g. switching from Edit row A to Edit
  // row B without unmounting), local state stays stuck on row A. Sync on item.id
  // changes. Same fix shape as Settings BCCConfiguration (commit f361d977) and
  // Settings FieldRow (commit 7e8aa8fc). Operational rule: af0b0215.
  const [title, setTitle] = useState(item?.title || "");
  const [content, setContent] = useState(item?.content || "");
  const [category, setCategory] = useState(item?.category || "business_rules");
  useEffect(() => {
    setTitle(item?.title || "");
    setContent(item?.content || "");
    setCategory(item?.category || "business_rules");
  }, [item?.id]);
  const isNew = !item?.id;

  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(15,23,42,0.5)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000, padding: 20 }}>
      <div style={{ background: T.white, borderRadius: 16, width: "100%", maxWidth: 640, boxShadow: "0 20px 60px rgba(0,0,0,0.2)", overflow: "hidden", maxHeight: "90vh", display: "flex", flexDirection: "column" }}>
        <div style={{ padding: "16px 20px", borderBottom: `1px solid ${T.slate200}`, display: "flex", justifyContent: "space-between", alignItems: "center", flexShrink: 0 }}>
          <div style={{ fontSize: 14, fontWeight: 700, color: T.slate900 }}>
            {isNew ? "Add Memory" : "Edit Memory"}
          </div>
          <button onClick={onCancel} style={{ background: "none", border: "none", fontSize: 18, color: T.slate400, cursor: "pointer", lineHeight: 1 }}>×</button>
        </div>

        <div style={{ padding: "20px", overflow: "auto" }}>
          <div style={{ marginBottom: 14 }}>
            <label style={{ fontSize: 11, fontWeight: 600, color: T.slate600, display: "block", marginBottom: 6 }}>CATEGORY</label>
            <select
              value={category}
              onChange={e => setCategory(e.target.value)}
              style={{ width: "100%", padding: "8px 10px", fontSize: 12, color: T.slate800, background: T.white, border: `1px solid ${T.slate200}`, borderRadius: 8, outline: "none" }}
            >
              {(categories || []).map(c => (
                <option key={c.id} value={c.id}>{c.icon} {c.label}</option>
              ))}
            </select>
          </div>

          <div style={{ marginBottom: 14 }}>
            <label style={{ fontSize: 11, fontWeight: 600, color: T.slate600, display: "block", marginBottom: 6 }}>TITLE</label>
            <input
              value={title}
              onChange={e => setTitle(e.target.value)}
              placeholder="Short descriptive title..."
              style={{ width: "100%", padding: "8px 10px", fontSize: 12, color: T.slate800, border: `1px solid ${T.slate200}`, borderRadius: 8, outline: "none", boxSizing: "border-box" }}
            />
          </div>

          <div style={{ marginBottom: 6 }}>
            <label style={{ fontSize: 11, fontWeight: 600, color: T.slate600, display: "block", marginBottom: 6 }}>CONTENT</label>
            <textarea
              value={content}
              onChange={e => setContent(e.target.value)}
              placeholder="Enter the information Claude should remember..."
              rows={10}
              style={{ width: "100%", padding: "10px", fontSize: 12, color: T.slate800, border: `1px solid ${T.slate200}`, borderRadius: 8, outline: "none", resize: "vertical", lineHeight: 1.6, fontFamily: "inherit", boxSizing: "border-box" }}
            />
          </div>
          <div style={{ fontSize: 10, color: T.slate400, marginBottom: 16 }}>
            Claude reads this in every conversation. Be specific and complete.
          </div>
        </div>

        <div style={{ padding: "12px 20px", borderTop: `1px solid ${T.slate200}`, display: "flex", justifyContent: "space-between", alignItems: "center", flexShrink: 0 }}>
          <div>
            {!isNew && (
              <button
                onClick={() => onDelete(item.id)}
                disabled={saving}
                style={{ padding: "7px 14px", fontSize: 11, fontWeight: 600, color: T.red, background: T.redLt, border: "none", borderRadius: 7, cursor: saving ? "not-allowed" : "pointer", opacity: saving ? 0.5 : 1 }}
              >Delete</button>
            )}
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <button
              onClick={onCancel}
              disabled={saving}
              style={{ padding: "7px 14px", fontSize: 11, fontWeight: 600, color: T.slate600, background: T.slate100, border: "none", borderRadius: 7, cursor: saving ? "not-allowed" : "pointer" }}
            >Cancel</button>
            <button
              onClick={() => onSave({ ...item, title, content, category })}
              disabled={!title.trim() || !content.trim() || saving}
              style={{ padding: "7px 16px", fontSize: 11, fontWeight: 600, color: T.white, background: T.navy, border: "none", borderRadius: 7, cursor: "pointer", opacity: (!title.trim() || !content.trim() || saving) ? 0.5 : 1 }}
            >{saving ? "Saving\u2026" : "Save Memory"}</button>
          </div>
        </div>
      </div>
    </div>
  );
};

// ─── Category Sidebar ─────────────────────────────────────────
const CategorySidebar = ({ categories, activeCategory, counts, onChange }) => (
  <div style={{ width: 220, flexShrink: 0, display: "flex", flexDirection: "column", gap: 4 }}>
    <button
      onClick={() => onChange("all")}
      style={{
        display: "flex", alignItems: "center", justifyContent: "space-between",
        padding: "9px 12px", borderRadius: 8, cursor: "pointer",
        background: activeCategory === "all" ? T.navy : "transparent",
        border: `1px solid ${activeCategory === "all" ? T.navy : T.slate200}`,
        fontSize: 12, fontWeight: activeCategory === "all" ? 600 : 400,
        color: activeCategory === "all" ? T.white : T.slate600,
        textAlign: "left",
      }}
    >
      <span>All Memories</span>
      <span style={{ fontSize: 10, fontWeight: 700, background: activeCategory === "all" ? "rgba(255,255,255,0.2)" : T.slate200, color: activeCategory === "all" ? T.white : T.slate600, borderRadius: 10, padding: "1px 7px" }}>{counts.all}</span>
    </button>

    {(categories || []).map(cat => {
      const active = activeCategory === cat.id;
      const cnt = counts[cat.id] || 0;
      if (!cnt) return null;
      return (
        <button
          key={cat.id}
          onClick={() => onChange(cat.id)}
          style={{
            display: "flex", alignItems: "center", justifyContent: "space-between",
            padding: "9px 12px", borderRadius: 8, cursor: "pointer",
            background: active ? cat.colorLt : "transparent",
            border: `1px solid ${active ? cat.color : T.slate200}`,
            fontSize: 12, fontWeight: active ? 600 : 400,
            color: active ? cat.color : T.slate600,
            textAlign: "left",
          }}
        >
          <span style={{ display: "flex", alignItems: "center", gap: 7, minWidth: 0 }}>
            <span style={{ fontSize: 14 }}>{cat.icon}</span>
            <span style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{cat.label}</span>
          </span>
          <span style={{ fontSize: 10, fontWeight: 600, background: active ? cat.color : T.slate100, color: active ? T.white : T.slate500, borderRadius: 10, padding: "1px 7px", flexShrink: 0 }}>{cnt}</span>
        </button>
      );
    })}
  </div>
);

// ─── Main Module ──────────────────────────────────────────────
export default function PersistentMemory() {
  const [memories,       setMemories]       = useState([]);
  const [loading,        setLoading]        = useState(true);
  const [errorMsg,       setErrorMsg]       = useState(null);
  const [saving,         setSaving]         = useState(false);
  const [activeCategory, setActiveCategory] = useState("all");
  const [editingItem,    setEditingItem]    = useState(null);
  const [showNewModal,   setShowNewModal]   = useState(false);
  const [searchQuery,    setSearchQuery]    = useState("");
  // collapsed audit-trail sections open/close (only relevant in "all" view)
  const [expandedAudit,  setExpandedAudit]  = useState({});

  // ── Load ──
  const loadMemories = async () => {
    setLoading(true); setErrorMsg(null);
    try {
      const { data, error } = await supabase
        .from("persistent_memory")
        .select("id, agency_id, category, title, content, is_active, added_by, source, created_at, updated_at")
        .eq("agency_id", AGENCY_ID)
        .neq("is_active", false)
        .order("category", { ascending: true })
        .order("updated_at", { ascending: false });
      if (error) throw error;
      setMemories(Array.isArray(data) ? data : []);
    } catch (e) {
      setErrorMsg(e?.message || "Failed to load memories.");
      setMemories([]);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { loadMemories(); }, []);

  // ── Derived ──
  const activeMemories = (memories || []).filter(m => m?.is_active !== false);

  const counts = {
    all: activeMemories.length,
    ...Object.fromEntries(
      CATEGORIES.map(c => [c.id, activeMemories.filter(m => m.category === c.id).length])
    ),
  };

  const filtered = activeMemories.filter(m => {
    if (activeCategory !== "all" && m.category !== activeCategory) return false;
    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      const t = (m.title || "").toLowerCase();
      const c = (m.content || "").toLowerCase();
      return t.includes(q) || c.includes(q);
    }
    return true;
  });

  // ── Save / Delete ──
  const handleSave = async (item) => {
    setSaving(true); setErrorMsg(null);
    try {
      if (item.id) {
        const { error } = await supabase
          .from("persistent_memory")
          .update({
            title: item.title,
            content: item.content,
            category: item.category,
            updated_at: new Date().toISOString(),
          })
          .eq("id", item.id);
        if (error) throw error;
      } else {
        const { error } = await supabase
          .from("persistent_memory")
          .insert({
            agency_id: AGENCY_ID,
            category: item.category,
            title: item.title,
            content: item.content,
            added_by: "owner_manual",
            source: "web_app_edit",
            is_active: true,
          });
        if (error) throw error;
      }
      setEditingItem(null);
      setShowNewModal(false);
      await loadMemories();
    } catch (e) {
      setErrorMsg(e?.message || "Save failed.");
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (id) => {
    if (!id) return;
    setSaving(true); setErrorMsg(null);
    try {
      const { error } = await supabase
        .from("persistent_memory")
        .update({ is_active: false, updated_at: new Date().toISOString() })
        .eq("id", id);
      if (error) throw error;
      setEditingItem(null);
      await loadMemories();
    } catch (e) {
      setErrorMsg(e?.message || "Delete failed.");
    } finally {
      setSaving(false);
    }
  };

  // ── Context for Ask Claude (all-memory) ──
  const allContext = activeMemories
    .map(m => `[${m.category} \u00b7 ${m.title}]\n${m.content}`)
    .join("\n\n---\n\n");

  // ── Render ──
  return (
    <div>
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", marginBottom: 16, gap: 12, flexWrap: "wrap" }}>
        <div>
          <div style={{ fontSize: 20, fontWeight: 700, color: T.slate900, letterSpacing: "-0.02em" }}>
            Persistent Memory
          </div>
          <div style={{ fontSize: 12, color: T.slate500, marginTop: 3 }}>
            {loading ? "Loading\u2026" : `${counts.all} memory ${counts.all === 1 ? "entry" : "entries"} \u00b7 Claude reads all of these in every conversation`}
          </div>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <AskBtn
            context={`Here is my complete agency memory context \u2014 everything I want you to know about my business:\n\n${allContext}\n\nPlease review this and tell me: (1) Is anything missing? (2) Is anything outdated? (3) Are there any inconsistencies you notice?`}
          />
          <button
            onClick={() => setShowNewModal(true)}
            style={{ display: "flex", alignItems: "center", gap: 6, background: T.navy, color: T.white, border: "none", borderRadius: 8, padding: "8px 16px", fontSize: 12, fontWeight: 600, cursor: "pointer" }}
          >+ Add Memory</button>
        </div>
      </div>

      {/* Info Banner */}
      <div style={{ background: T.blueLt, border: `1px solid ${T.blue}20`, borderLeft: `4px solid ${T.blue}`, borderRadius: 10, padding: "12px 16px", marginBottom: 16, display: "flex", alignItems: "flex-start", gap: 12 }}>
        <span style={{ fontSize: 20, flexShrink: 0 }}>💡</span>
        <div>
          <div style={{ fontSize: 12, fontWeight: 600, color: T.navy, marginBottom: 3 }}>
            How Claude uses this memory
          </div>
          <div style={{ fontSize: 11, color: T.slate600, lineHeight: 1.6 }}>
            Every entry here is passed to Claude as context at the start of each conversation. Claude uses it to give you answers that are specific to your agency — not generic advice. The more complete and accurate this memory is, the more useful your Claude becomes. You and Claude can both add, edit, and update these entries at any time.
          </div>
        </div>
      </div>

      {errorMsg && (
        <div style={{ background: T.redLt, border: `1px solid ${T.red}40`, borderLeft: `4px solid ${T.red}`, borderRadius: 10, padding: "10px 14px", marginBottom: 16, fontSize: 12, color: "#991B1B" }}>
          {errorMsg}
        </div>
      )}

      {/* Search */}
      <div style={{ marginBottom: 16 }}>
        <input
          value={searchQuery}
          onChange={e => setSearchQuery(e.target.value)}
          placeholder="Search memories..."
          style={{ width: "100%", padding: "9px 14px", fontSize: 12, color: T.slate800, border: `1px solid ${T.slate200}`, borderRadius: 9, outline: "none", boxSizing: "border-box", background: T.white }}
        />
      </div>

      {/* Body */}
      <div style={{ display: "flex", gap: 16, alignItems: "flex-start" }}>
        <CategorySidebar
          categories={CATEGORIES}
          activeCategory={activeCategory}
          counts={counts}
          onChange={setActiveCategory}
        />

        <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 20, minWidth: 0 }}>
          {loading && (
            <div style={{ textAlign: "center", padding: "40px 20px", color: T.slate400, fontSize: 13 }}>
              Loading memories…
            </div>
          )}

          {!loading && filtered.length === 0 && (
            <div style={{ textAlign: "center", padding: "40px 20px", color: T.slate400, fontSize: 13 }}>
              {searchQuery ? `No memories match "${searchQuery}"` : "No memories in this category yet."}
            </div>
          )}

          {!loading && activeCategory === "all" && filtered.length > 0 && CATEGORIES.map(cat => {
            const items = filtered.filter(m => m.category === cat.id);
            if (!items.length) return null;
            const isAudit = !!cat.collapsed;
            // If user is actively searching, force audit sections open so results show.
            const isOpen = isAudit
              ? (searchQuery ? true : !!expandedAudit[cat.id])
              : true;
            return (
              <div key={cat.id}>
                <div
                  onClick={isAudit ? () => setExpandedAudit(s => ({ ...s, [cat.id]: !s[cat.id] })) : undefined}
                  style={{
                    display: "flex", alignItems: "center", gap: 8, marginBottom: 10,
                    cursor: isAudit ? "pointer" : "default",
                    userSelect: "none",
                  }}
                >
                  <span style={{ fontSize: 16 }}>{cat.icon}</span>
                  <span style={{ fontSize: 13, fontWeight: 700, color: T.slate700 }}>{cat.label}</span>
                  <div style={{ flex: 1, height: 1, background: T.slate200, marginLeft: 4 }} />
                  <span style={{ fontSize: 11, color: T.slate400 }}>
                    {items.length} {items.length === 1 ? "entry" : "entries"}
                  </span>
                  {isAudit && (
                    <span style={{
                      fontSize: 10, fontWeight: 600, color: T.slate500,
                      background: T.slate100, border: `1px solid ${T.slate200}`,
                      borderRadius: 6, padding: "2px 8px",
                    }}>
                      {isOpen ? "Hide \u2191" : "Show \u2193"}
                    </span>
                  )}
                </div>
                {isOpen && (
                  <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                    {items.map(item => (
                      <MemoryCard
                        key={item.id}
                        item={item}
                        categoryConfig={cat}
                        onEdit={setEditingItem}
                      />
                    ))}
                  </div>
                )}
                {isAudit && !isOpen && (
                  <div style={{ fontSize: 11, color: T.slate400, fontStyle: "italic", paddingLeft: 24 }}>
                    {cat.description} — click header to expand.
                  </div>
                )}
              </div>
            );
          })}

          {!loading && activeCategory !== "all" && filtered.length > 0 && (() => {
            const cat = CATEGORY_BY_ID[activeCategory] || UNKNOWN_CATEGORY;
            return (
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {filtered.map(item => (
                  <MemoryCard
                    key={item.id}
                    item={item}
                    categoryConfig={cat}
                    onEdit={setEditingItem}
                  />
                ))}
              </div>
            );
          })()}
        </div>
      </div>

      {/* Edit Modal */}
      {(editingItem || showNewModal) && (
        <EditModal
          item={editingItem}
          categories={CATEGORIES}
          saving={saving}
          onSave={handleSave}
          onCancel={() => { if (!saving) { setEditingItem(null); setShowNewModal(false); } }}
          onDelete={handleDelete}
        />
      )}
    </div>
  );
}
