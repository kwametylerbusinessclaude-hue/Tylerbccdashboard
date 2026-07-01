// ConfirmDeleteButton — two-click delete pattern with 4-second auto-reset.
// Inline-styled.

import { useEffect, useRef, useState } from 'react';
import { Trash2 } from 'lucide-react';

const CONFIRM_WINDOW_MS = 4000;

const BASE = {
  display: "inline-flex", alignItems: "center", gap: 4,
  padding: "5px 10px",
  borderRadius: 6,
  fontSize: 12, fontWeight: 500,
  cursor: "pointer",
  transition: "background 0.15s, border-color 0.15s, color 0.15s",
  border: "1px solid transparent",
  whiteSpace: "nowrap",
};
const IDLE = { ...BASE, color: "#64748B", background: "#FFFFFF", borderColor: "#E2E8F0" };
const ARMED = { ...BASE, color: "#FFFFFF", background: "#EF4444", borderColor: "#EF4444" };
const DISABLED = { opacity: 0.5, cursor: "not-allowed" };

export default function ConfirmDeleteButton({
  onConfirm,
  label = "Delete",
  confirmLabel = "Click again to confirm",
  disabled = false,
}) {
  const [armed, setArmed] = useState(false);
  const timerRef = useRef(null);

  useEffect(() => () => { if (timerRef.current) clearTimeout(timerRef.current); }, []);

  const handleClick = async () => {
    if (disabled) return;
    if (!armed) {
      setArmed(true);
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => setArmed(false), CONFIRM_WINDOW_MS);
      return;
    }
    if (timerRef.current) clearTimeout(timerRef.current);
    setArmed(false);
    try {
      await onConfirm?.();
    } catch (e) {
      console.error("ConfirmDeleteButton onConfirm threw:", e);
    }
  };

  const style = { ...(armed ? ARMED : IDLE), ...(disabled ? DISABLED : {}) };

  return (
    <button
      type="button"
      onClick={handleClick}
      disabled={disabled}
      style={style}
      title={armed ? confirmLabel : label}
    >
      <Trash2 size={13} />
      {armed ? confirmLabel : label}
    </button>
  );
}
