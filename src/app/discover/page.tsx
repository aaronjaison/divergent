import { DiscoverForm } from "@/components/DiscoverForm";
import { PageHeader } from "@/components/PageHeader";

export const metadata = {
  title: "Discover similar artists — Divergent",
};

export default function DiscoverPage() {
  return (
    <div className="max-w-3xl">
      <PageHeader
        eyebrow="Similar artists"
        title="Everyone else who sounds like them."
        hue="var(--hue-similar)"
      >
        Name an artist you already love and get one track each from the people
        who share their sound, so a single listen introduces you to dozens of
        artists at once. The artist you named is left out on purpose.
      </PageHeader>

      <div className="mt-10">
        <DiscoverForm />
      </div>
    </div>
  );
}
