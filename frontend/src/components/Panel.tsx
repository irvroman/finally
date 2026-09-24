export function Panel({
  title,
  aside,
  children,
  className = "",
  bodyClassName = "",
  testId,
}: {
  title: React.ReactNode;
  aside?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
  bodyClassName?: string;
  testId?: string;
}) {
  return (
    <section
      data-testid={testId}
      className={`flex min-h-0 min-w-0 flex-col border border-line bg-panel ${className}`}
    >
      <header className="flex h-8 shrink-0 items-center justify-between gap-2 border-b border-line px-3">
        <h2 className="truncate text-[12px] font-semibold tracking-wide text-muted">{title}</h2>
        {aside}
      </header>
      <div className={`min-h-0 flex-1 ${bodyClassName}`}>{children}</div>
    </section>
  );
}
