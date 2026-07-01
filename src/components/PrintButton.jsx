// PrintButton — triggers browser print for the current view.
// Minimal implementation authored 2026-07-01 to unblock the retrofit build.
// Interface matches SystemMap usage: <PrintButton title="..." />.
//
// The `title` prop is currently used only to set document.title briefly
// before print (so the printed page bears a useful heading). Callers that
// want more control (section picker, hidden print CSS, etc.) can layer on
// top of this later. The existing Financials.jsx "Print Full Report" flow
// remains unaffected — it builds its own document window instead.

import { Printer } from 'lucide-react';

export default function PrintButton({ title, label = "Print" }) {
  const handleClick = () => {
    if (typeof window === 'undefined') return;
    const prev = document.title;
    if (title) document.title = title;
    try {
      window.print();
    } finally {
      // Restore original tab title after the print dialog closes.
      // Timeout because some browsers block synchronous restore right after print().
      setTimeout(() => { document.title = prev; }, 500);
    }
  };
  return (
    <button
      type="button"
      onClick={handleClick}
      className="if-button-ghost text-xs inline-flex items-center gap-1"
      title={title || "Print"}
    >
      <Printer size={14} /> {label}
    </button>
  );
}
