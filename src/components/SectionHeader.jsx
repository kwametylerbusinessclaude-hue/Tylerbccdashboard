// SectionHeader — top-of-page block for a module with icon + title + subtitle.
// Minimal implementation authored 2026-07-01 to unblock the retrofit build
// after PlaybookGuide.jsx + SystemMap.jsx landed importing a shared component
// that didn't exist in this fork. Interface matches how SystemMap uses it.
//
// Usage:
//   <SectionHeader title="..." subtitle="..." icon={LucideIconComponent} />

export default function SectionHeader({ title, subtitle, icon: Icon }) {
  return (
    <div className="flex items-start gap-3 mb-1">
      {Icon ? (
        <div className="flex-shrink-0 w-9 h-9 rounded-lg bg-if-accent-soft flex items-center justify-center text-if-accent">
          <Icon size={18} />
        </div>
      ) : null}
      <div className="min-w-0 flex-1">
        <h2 className="text-lg font-semibold text-if-text leading-tight">{title}</h2>
        {subtitle ? (
          <p className="text-xs text-if-muted mt-0.5 leading-snug">{subtitle}</p>
        ) : null}
      </div>
    </div>
  );
}
