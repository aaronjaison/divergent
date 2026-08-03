import { PageHeader } from "@/components/PageHeader";
import { SoundsLikeForm } from "@/components/SoundsLikeForm";

export const metadata = {
  title: "Music like this — Divergent",
};

export default function SoundsLikePage() {
  return (
    <div className="max-w-3xl">
      <PageHeader
        eyebrow="Music like this"
        title="Name what you have in mind."
        hue="var(--hue-match)"
      >
        Give us the songs or albums you are thinking of and get a playlist of
        other artists who fit them. The more you name, the better this works:
        one song only shows us a genre, but several show us what they have in
        common — and that is the thing worth matching.
      </PageHeader>

      <div className="mt-10">
        <SoundsLikeForm />
      </div>
    </div>
  );
}
