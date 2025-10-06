import { NextResponse } from "next/server";
import { searchFlightOffers } from "../../lib/amadeus";
import { llmParseQuery, llmExpandCombos } from "../../lib/llmagent";
import { runWithLimit } from "../../utils/concurrency";

export const runtime = "nodejs";

function isoToReadableDuration(iso?: string) {
  if (!iso?.startsWith("PT")) return "";
  const h = /PT(\d+)H/.exec(iso)?.[1];
  const m = /(\d+)M/.exec(iso)?.[1];
  return `${h ? `${h}h` : ""}${h && m ? " " : ""}${m ? `${m}m` : ""}` || iso;
}

function ensureReturnAfterDepart(dep?: string, ret?: string) {
  if (!dep || !ret) return ret;
  return new Date(ret) >= new Date(dep) ? ret : undefined;
}

async function withTimeout<T>(
  fn: (signal?: AbortSignal) => Promise<T>,
  ms = 3500
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await fn(controller.signal);
  } finally {
    clearTimeout(timer);
  }
}

export async function POST(req: Request) {
  try {
    const body = await req.json();

    let origin: string,
      destination: string,
      depart: string,
      ret: string | undefined,
      adults: number,
      cabin: "ECONOMY" | "PREMIUM_ECONOMY" | "BUSINESS" | "FIRST";

    if (body.query) {
      const parsed = await llmParseQuery(String(body.query));
      origin = String(parsed.origin || "").toUpperCase();
      destination = String(parsed.destination || "").toUpperCase();
      depart = String(parsed.depart || "");
      ret = parsed.ret ? String(parsed.ret) : undefined;
      adults = Math.max(1, Number(parsed.adults || 1));
      cabin =
        (String(parsed.cabin || "ECONOMY").toUpperCase() as any) || "ECONOMY";
    } else {
      origin = String(body.from || "").toUpperCase();
      destination = String(body.to || "").toUpperCase();
      depart = String(body.depart || "");
      ret = body.return ? String(body.return) : undefined;
      adults = Math.max(1, Number(body.adults || 1));
      const cabinMap: Record<string, any> = {
        M: "ECONOMY",
        W: "PREMIUM_ECONOMY",
        C: "BUSINESS",
        F: "FIRST",
      };
      cabin = (cabinMap[String(body.cabin || "M")] || "ECONOMY") as any;
    }

    ret = ensureReturnAfterDepart(depart, ret);

    if (!origin || !destination || !depart) {
      return NextResponse.json(
        { error: "Missing origin/destination/depart." },
        { status: 400 }
      );
    }

    let offers = await withTimeout(
      (signal) =>
        searchFlightOffers({
          origin,
          destination,
          departDate: depart,
          returnDate: ret,
          adults,
          cabin,
          currency: "USD",
          max: 50,
          signal,
        }),
      5000
    );

    let used: any = {
      origin,
      destination,
      departDate: depart,
      returnDate: ret,
    };
    let expandedByLLM = false;

    if (!offers?.length) {
      expandedByLLM = true;
      const combos = await llmExpandCombos({
        origin,
        destination,
        depart,
        ret,
      });

      const score = (c: any) => {
        let s = 0;
        if (c.origin === origin) s -= 2;
        if (c.destination === destination) s -= 2;
        const d0 = new Date(depart).getTime();
        const d1 = new Date(c.depart).getTime();
        s += Math.abs(d1 - d0) / (1000 * 60 * 60 * 24);
        return s;
      };
      const ordered = combos.sort((a, b) => score(a) - score(b)).slice(0, 12);

      const found = await runWithLimit(ordered, 4, async (c) => {
        const rr = ensureReturnAfterDepart(c.depart, c.ret ?? undefined);
        try {
          const next = await withTimeout(
            (signal) =>
              searchFlightOffers({
                origin: String(c.origin).toUpperCase(),
                destination: String(c.destination).toUpperCase(),
                departDate: String(c.depart),
                returnDate: rr,
                adults,
                cabin,
                currency: "USD",
                max: 30,

                signal,
              }),
            3500
          );
          if (next?.length) {
            return {
              offers: next,
              used: {
                origin: String(c.origin).toUpperCase(),
                destination: String(c.destination).toUpperCase(),
                departDate: String(c.depart),
                returnDate: rr,
              },
            };
          }
        } catch {
          // ignore; try next combo
        }
        return null;
      });

      if (found) {
        offers = found.offers;
        used = found.used;
      } else {
        if (cabin === "BUSINESS") {
          try {
            const econ = await withTimeout(
              (signal) =>
                searchFlightOffers({
                  origin,
                  destination,
                  departDate: depart,
                  returnDate: ret,
                  adults,
                  cabin: "ECONOMY",
                  currency: "USD",
                  max: 20,

                  signal,
                }),
              4000
            );
            if (econ?.length) {
              offers = econ;
              used = { ...used, note: "No business found; showing economy." };
            }
          } catch (e) {
            console.error(`Failed Buisness and Econemy: ${e}`);
          }
        }
      }
    }

    if (!offers?.length) {
      return NextResponse.json({
        results: [],
        used,
        note: expandedByLLM
          ? "No offers found even after expanding via AI. Try broader dates or airports."
          : "No offers found. We can try AI-based expansion if you enable it.",
        expandedByLLM,
      });
    }

    const results = offers.map((o: any) => {
      const it = o.itineraries?.[0];
      const segs = it?.segments ?? [];
      return {
        price: Number(o.price?.grandTotal || 0),
        duration: isoToReadableDuration(it?.duration),
        stops: Math.max(0, segs.length - 1),
        route: segs
          .map(
            (s: any) =>
              `${s.departure?.iataCode}→${s.arrival?.iataCode} (${
                s.carrierCode
              }${s.number ?? ""})`
          )
          .join(" · "),
        carriers: Array.from(
          new Set(segs.map((s: any) => s.carrierCode))
        ).sort(),
        deep_link: null,
        _raw: { id: o.id },
      };
    });

    results.sort((a: any, b: any) =>
      a.price !== b.price ? a.price - b.price : a.stops - b.stops
    );

    return NextResponse.json({
      results: results.slice(0, 12),
      used,
      expandedByLLM,
    });
  } catch (e: any) {
    return NextResponse.json(
      { error: String(e.message || e) },
      { status: 500 }
    );
  }
}
