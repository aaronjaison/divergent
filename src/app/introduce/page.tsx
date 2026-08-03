import { IntroduceForm } from "@/components/IntroduceForm";
import { PageHeader } from "@/components/PageHeader";

export const metadata = {
  title: "Introduce me to an artist — Divergent",
};

export default function IntroducePage() {
  return (
    <div className="max-w-3xl">
      <PageHeader
        eyebrow="Introduce me"
        title="Meet someone properly."
        hue="var(--hue-artist)"
      >
        Pick an artist you have been meaning to listen to. You will get a
        playlist built for how you want to meet them — not just whatever the
        algorithm plays most.
      </PageHeader>

      <div className="mt-10">
        <IntroduceForm />
      </div>
    </div>
  );
}
