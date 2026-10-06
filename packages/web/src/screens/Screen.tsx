import type { ReactNode } from "react";

export function Screen({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <section className="screen" aria-label={title}>
      <h1 className="screen-title">{title}</h1>
      {children}
    </section>
  );
}
