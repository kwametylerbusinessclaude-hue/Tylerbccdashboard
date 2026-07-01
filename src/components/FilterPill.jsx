// FilterPill — clickable pill button, inline-styled. Used for category filter
// chips in SystemMap.jsx.

const BASE = {
  display: "inline-flex", alignItems: "center", gap: 4,
  padding: "5px 12px",
  borderRadius: 999,
  fontSize: 12, fontWeight: 500,
  cursor: "pointer",
  transition: "background 0.15s, border-color 0.15s, color 0.15s",
  border: "1px solid #E2E8F0",
};

const ACTIVE = {
  background: "#2D7DD2", color: "#FFFFFF", borderColor: "#2D7DD2",
};
const IDLE = {
  background: "#FFFFFF", color: "#64748B",
};
const DISABLED = { opacity: 0.5, cursor: "not-allowed" };

export default function FilterPill({ active = false, onClick, children, disabled = false }) {
  const style = { ...BASE, ...(active ? ACTIVE : IDLE), ...(disabled ? DISABLED : {}) };
  return (
    <button
      type="button"
      onClick={disabled ? undefined : onClick}
      style={style}
      disabled={disabled}
    >
      {children}
    </button>
  );
}
