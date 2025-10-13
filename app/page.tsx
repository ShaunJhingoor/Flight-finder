"use client";
import { useState } from "react";
import AirportAutocomplete from "./components/AirportAutocomplete";
type Result = {
  price: number;
  duration: string;
  stops: number;
  route: string;
  carriers: string[];
  deep_links?: {
    google_flights?: string;
    kayak?: string;
    skyscanner?: string;
  };
};

export default function FlightsPage() {
  const [loading, setLoading] = useState(false);
  const [results, setResults] = useState<Result[]>([]);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    setResults([]);
    const form = new FormData(e.currentTarget);
    const payload = Object.fromEntries(form.entries());

    try {
      const res = await fetch("/api/flights", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Search failed");
      console.log(json.results);
      setResults(json.results || []);
    } catch (err: any) {
      setError(err.message || "Something went wrong");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen min-w-screen  bg-[url('./assets/bgImage.png')] bg-cover bg-center bg-no-repeat text-white flex items-center justify-center">
      <main className="max-w-4xl w-full mx-auto p-6 space-y-6">
        <h1 className="text-2xl font-semibold text-center">
          Find Flights (Amadeus)
        </h1>

        <form onSubmit={onSubmit} className="grid grid-cols-2 gap-5">
          <AirportAutocomplete nameCode="from" label="From" required />
          <AirportAutocomplete nameCode="to" label="To" required />

          <label className="text-sm">
            <span className="block mb-1">Depart</span>
            <input
              type="date"
              name="depart"
              required
              className="border p-2 rounded w-full"
            />
          </label>
          <label className="text-sm">
            <span className="block mb-1">Return (optional)</span>
            <input
              type="date"
              name="return"
              className="border p-2 rounded w-full"
            />
          </label>

          <label className="text-sm">
            <span className="block mb-1">Adults</span>
            <input
              type="number"
              name="adults"
              min={1}
              defaultValue={1}
              className="border p-2 rounded w-full"
            />
          </label>

          <label className="text-sm">
            <span className="block mb-1">Cabin</span>
            <select
              name="cabin"
              defaultValue="M"
              className="border p-2 rounded w-full"
            >
              <option value="M">Economy</option>
              <option value="W">Premium Economy</option>
              <option value="C">Business</option>
              <option value="F">First</option>
            </select>
          </label>

          <button
            type="submit"
            className="col-span-2 bg-[#1c3a53] text-white rounded p-2 disabled:opacity-60"
            disabled={loading}
          >
            {loading ? "Searching..." : "Search"}
          </button>
        </form>

        {error && <p className="text-red-600">{error}</p>}

        {results.length > 0 && (
          <section className="space-y-4">
            {results.map((r, i) => (
              <div key={i} className="border rounded p-3">
                <div className="flex items-center justify-between">
                  <div className="font-medium">
                    ${r.price} • {r.stops} stop{r.stops === 1 ? "" : "s"} •{" "}
                    {r.duration}
                  </div>

                  {r?.deep_links && (
                    <button
                      className="underline"
                      onClick={() => {
                        const url =
                          r.deep_links?.skyscanner ||
                          r.deep_links?.kayak ||
                          r.deep_links?.google_flights;
                        if (url) window.open(url, "_blank");
                      }}
                    >
                      Select
                    </button>
                  )}
                </div>
                <div className="text-sm opacity-85">{r.route}</div>
                <div className="text-xs opacity-60">
                  {r.carriers.join(", ")}
                </div>
              </div>
            ))}
          </section>
        )}
      </main>
    </div>
  );
}
