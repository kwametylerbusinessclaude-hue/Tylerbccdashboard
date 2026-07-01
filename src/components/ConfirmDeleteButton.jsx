// ConfirmDeleteButton — two-click delete pattern. First click primes
// the button (visually changes to red + swaps label to a confirm string);
// second click within the timeout window fires onConfirm(). Any click
// outside the timeout resets. Auto-resets after 4 seconds.
//
// Minimal implementation authored 2026-07-01 to unblock the retrofit build.
// Interface matches SystemMap usage:
//   <ConfirmDeleteButton
//     onConfirm={handleDelete}
//     label="Delete page"
//     confirmLabel="Click again to permanently delete"
//     disabled={saving}
//   />

import { useEffect, useRef, useState } from 'react';
import { Trash2 } from 'lucide-react';

const CONFIRM_WINDOW_MS = 4000;

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
    // Armed — fire and reset.
    if (timerRef.current) clearTimeout(timerRef.current);
    setArmed(false);
    try {
      await onConfirm?.();
    } catch (e) {
      // Callers own their own error handling; log for the developer console.
      console.error("ConfirmDeleteButton onConfirm threw:", e);
    }
  };

  const base = "text-xs inline-flex items-center gap-1 rounded-md px-2.5 py-1.5 border transition";
  const idleCls = "border-if-border text-if-muted hover:text-red-600 hover:border-red-300 bg-white";
  const armedCls = "border-red-500 text-white bg-red-600 hover:bg-red-700";
  const disabledCls = "opacity-50 cursor-not-allowed";

  return (
    <button
      type="button"
      onClick={handleClick}
      disabled={disabled}
      className={`${base} ${armed ? armedCls : idleCls} ${disabled ? disabledCls : ""}`}
      title={armed ? confirmLabel : label}
    >
      <Trash2 size={14} />
      {armed ? confirmLabel : label}
    </button>
  );
}
