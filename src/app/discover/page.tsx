import { DiscoverForm } from "@/components/DiscoverForm";

export const metadata = {
  title: "Discover similar artists — Divergent",
};

export default function DiscoverPage() {
  return (
    <div className="max-w-3xl">
      <h1 className="text-3xl font-semibold tracking-tight">
        Discover similar artists
      </h1>
      <p className="mt-3 max-w-2xl text-muted text-pretty">
        Name an artist you already love and get a playlist of everyone else who
        sounds like them — one track each, so a single listen introduces you to
        dozens of artists at once. The artist you named is left out on purpose.
      </p>

      <div className="mt-8">
        <DiscoverForm />
      </div>
    </div>
  );
}
