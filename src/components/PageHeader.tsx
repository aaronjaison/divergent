/**
 * The heading block every mode page shares.
 *
 * `hue` is the mode's own colour from SiteNav, repeated here so the page you
 * land on visibly belongs to the link you clicked.
 */
export function PageHeader({
  eyebrow,
  title,
  hue,
  children,
}: {
  eyebrow: string;
  title: string;
  hue: string;
  children: React.ReactNode;
}) {
  return (
    <header>
      <p className="flex items-center gap-2.5 text-xs uppercase tracking-[0.2em] text-muted">
        <span className="size-1.5 rounded-full" style={{ background: hue }} />
        {eyebrow}
      </p>
      <h1 className="font-display mt-4 text-4xl text-balance sm:text-5xl">
        {title}
      </h1>
      <p className="mt-4 max-w-2xl text-muted text-pretty">{children}</p>
    </header>
  );
}
