// FilterPill — clickable pill for filter chips (category filters, status chips, etc.)
// Minimal implementation authored 2026-07-01 to unblock the retrofit build.
// Interface matches SystemMap usage: <FilterPill active={bool} onClick={fn}>{children}</FilterPill>.

export default function FilterPill({ active = false, onClick, children, disabled = false }) {
  const base = "inline-flex items-center px-2.5 py-1 rounded-full text-xs font-medium transition border";
  const activeCls = "bg-if-accent text-white border-if-accent";
  const idleCls = "bg-white text-if-muted border-if-border hover:border-if-accent hover:text-if-text";
  const disabledCls = "opacity-50 cursor-not-allowed";
  return (
    <button
      type="button"
      onClick={disabled ? undefined : onClick}
      className={`${base} ${active ? activeCls : idleCls} ${disabled ? disabledCls : ""}`}
      disabled={disabled}
    >
      {children}
    </button>
  );
}
