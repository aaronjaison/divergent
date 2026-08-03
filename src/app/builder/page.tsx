import { BuilderForm } from "@/components/BuilderForm";
import { PageHeader } from "@/components/PageHeader";

export const metadata = {
  title: "Build by style — Divergent",
};

export default function BuilderPage() {
  return (
    <div className="max-w-3xl">
      <PageHeader
        eyebrow="Build by style"
        title="Describe the sound, not the artists."
        hue="var(--hue-style)"
      >
        Every playlist caps how often one artist can appear, so you end up with
        a genre rather than a greatest-hits reel.
      </PageHeader>

      <div className="mt-10">
        <BuilderForm />
      </div>
    </div>
  );
}
