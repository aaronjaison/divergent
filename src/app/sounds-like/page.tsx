import { SoundsLikeForm } from "@/components/SoundsLikeForm";

export const metadata = {
  title: "Music like this — Divergent",
};

export default function SoundsLikePage() {
  return (
    <div className="max-w-3xl">
      <h1 className="text-3xl font-semibold tracking-tight">
        Find music like this
      </h1>
      <p className="mt-3 max-w-2xl text-muted text-pretty">
        Name the songs or albums you have in mind and get a playlist of other
        artists who fit them. The more you name, the better this works: with one
        song we can only see a genre, but with several we can see what they have
        in common — and that is the thing worth matching.
      </p>

      <div className="mt-8">
        <SoundsLikeForm />
      </div>
    </div>
  );
}
