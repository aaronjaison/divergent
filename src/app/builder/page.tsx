import { BuilderForm } from "@/components/BuilderForm";

export const metadata = {
  title: "Build by style — Divergent",
};

export default function BuilderPage() {
  return (
    <div className="max-w-3xl">
      <h1 className="text-3xl font-semibold tracking-tight">Build by style</h1>
      <p className="mt-3 max-w-2xl text-muted text-pretty">
        Describe the sound rather than the artists. Every playlist caps how
        often one artist can appear, so you end up with a genre, not a
        greatest-hits reel.
      </p>

      <div className="mt-8">
        <BuilderForm />
      </div>
    </div>
  );
}
