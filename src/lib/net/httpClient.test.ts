import { afterEach, describe, expect, it, vi } from "vitest";
import { providerFetch, RequestAbortedError } from "./httpClient";

/**
 * Only the abandonment path is covered here. The rest of providerFetch —
 * backoff, Retry-After, the 503-as-rate-signal rule — is exercised against the
 * real services by the provider tests, where a wrong assumption about a status
 * code would actually show up.
 */

afterEach(() => {
  vi.restoreAllMocks();
});

describe("providerFetch abandonment", () => {
  it("does not dispatch a request the caller has already given up on", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const controller = new AbortController();
    controller.abort();

    await expect(
      providerFetch("musicbrainz", "https://example.invalid/x", {
        signal: controller.signal,
      }),
    ).rejects.toBeInstanceOf(RequestAbortedError);

    // The point of the whole mechanism: the queue slot is returned without a
    // wire call, so the search the person is still waiting for moves up.
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("does not retry once the caller has given up mid-flight", async () => {
    const controller = new AbortController();
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      // Abandoned while the first attempt was on the wire, which then fails.
      controller.abort();
      throw new Error("socket hang up");
    });

    await expect(
      providerFetch("deezer", "https://example.invalid/x", {
        signal: controller.signal,
        attempts: 3,
      }),
    ).rejects.toBeInstanceOf(RequestAbortedError);

    // A retry is a fresh slot in the queue; an abandoned call must not take one.
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("saves the round trip of every search typed past", async () => {
    /**
     * The claim the feature rests on, measured rather than assumed — and the
     * first version of this test is why the claim is worded as it is. It
     * asserted that an abandoned job frees its place in the queue, and the
     * measurement said otherwise: the limiter paces on job STARTS, so a job
     * that does nothing still costs its full gap. What abandoning saves is the
     * response, which for MusicBrainz is the part that takes between 0.2 and 20
     * seconds. Stubbed here at 400ms so the two runs differ only in that.
     *
     * End-to-end timing against the real service cannot show this at all: its
     * variance on identical queries is larger than the effect being measured.
     */
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 400));
      return new Response("{}", { status: 200 });
    });

    // Five searches typed past, then the one that is wanted.
    const run = async (provider: "lastfm" | "soundcharts", abandon: boolean) => {
      const started = Date.now();
      const earlier = Array.from({ length: 5 }, (_, i) => {
        const controller = new AbortController();
        const call = providerFetch(provider, `https://example.invalid/${i}`, {
          signal: abandon ? controller.signal : undefined,
        }).catch(() => null);
        if (abandon) controller.abort();
        return call;
      });
      const wanted = providerFetch(provider, "https://example.invalid/wanted");
      await Promise.all([...earlier, wanted]);
      return Date.now() - started;
    };

    // Separate providers so the two runs cannot queue behind each other.
    const served = await run("lastfm", false);
    const abandoned = await run("soundcharts", true);

    // Serving all six is six round trips deep; abandoning five leaves one.
    expect(served).toBeGreaterThan(2_000);
    expect(abandoned).toBeLessThan(served * 0.75);
  });

  it("still retries a normal failure when nobody has given up", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValueOnce(new Error("socket hang up"))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: true }), { status: 200 }),
      );

    await expect(
      providerFetch("deezer", "https://example.invalid/x", { attempts: 3 }),
    ).resolves.toEqual({ ok: true });
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });
});
