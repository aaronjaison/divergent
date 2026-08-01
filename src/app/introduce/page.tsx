import { IntroduceForm } from "@/components/IntroduceForm";

export const metadata = {
  title: "Introduce me to an artist — Divergent",
};

export default function IntroducePage() {
  return (
    <div className="max-w-3xl">
      <h1 className="text-3xl font-semibold tracking-tight">
        Introduce me to an artist
      </h1>
      <p className="mt-3 max-w-2xl text-muted text-pretty">
        Pick someone you have been meaning to listen to properly. You will get a
        playlist built for how you want to meet them — not just whatever the
        algorithm plays most.
      </p>

      <div className="mt-8">
        <IntroduceForm />
      </div>
    </div>
  );
}
