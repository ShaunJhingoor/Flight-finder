// app/api/flights/route.ts
import { NextResponse } from "next/server";
import { searchFlightOffers } from "../../lib/amadeus";

async function tryCombos(base: {
  origin: string;
  destination: string;
  departDate: string;
  returnDate?: string;
  adults: number;
  cabin: "ECONOMY" | "PREMIUM_ECONOMY" | "BUSINESS" | "FIRST";
}) {
  const origins = [base.origin, ...(base.origin === "JFK" ? ["NYC"] : [])]; // add city group
  const dests = [
    base.destination,
    ...(base.destination === "RIC" ? ["ORF", "DCA", "IAD"] : []),
  ];

  // build ±2 day windows
  const flex = (iso: string) => {
    const d = new Date(iso + "T00:00:00");
    const dates: string[] = [];
    for (let i = -2; i <= 2; i++) {
      const x = new Date(d);
      x.setDate(x.getDate() + i);
      dates.push(x.toISOString().slice(0, 10));
    }
    return dates;
  };
  const depDates = flex(base.departDate);
  const retDates = base.returnDate ? flex(base.returnDate) : [undefined];

  for (const o of origins) {
    for (const t of dests) {
      for (const dd of depDates) {
        for (const rr of retDates) {
          const offers = await searchFlightOffers({
            origin: o,
            destination: t,
            departDate: dd,
            returnDate: rr,
            adults: base.adults,
            cabin: base.cabin,
            currency: "USD",
            max: 200,
          });
          if (offers?.length) {
            return {
              offers,
              used: {
                origin: o,
                destination: t,
                departDate: dd,
                returnDate: rr,
              },
            };
          }
        }
      }
    }
  }
  return { offers: [], used: null };
}

// optional: pretty duration
function isoToReadableDuration(iso?: string) {
  if (!iso?.startsWith("PT")) return "";
  const h = /PT(\d+)H/.exec(iso)?.[1];
  const m = /(\d+)M/.exec(iso)?.[1];
  const HH = h ? `${h}h` : "";
  const MM = m ? `${m}m` : "";
  return `${HH}${HH && MM ? " " : ""}${MM}` || iso;
}

export async function POST(req: Request) {
  try {
    const body = await req.json();

    const origin = String(body.from || "")
      .trim()
      .toUpperCase();
    const destination = String(body.to || "")
      .trim()
      .toUpperCase();
    const depart = String(body.depart);
    const ret = body.return ? String(body.return) : undefined;
    const adults = Math.max(1, Number(body.adults || 1));
    const cabinMap: Record<
      string,
      "ECONOMY" | "PREMIUM_ECONOMY" | "BUSINESS" | "FIRST"
    > = {
      M: "ECONOMY",
      W: "PREMIUM_ECONOMY",
      C: "BUSINESS",
      F: "FIRST",
    };
    const cabin = cabinMap[String(body.cabin || "M")] ?? "ECONOMY";

    const IATA = /^[A-Z]{3}$/;
    if (!IATA.test(origin) || !IATA.test(destination)) {
      return NextResponse.json(
        {
          error:
            "Please select valid airports from the dropdown (3-letter IATA codes).",
        },
        { status: 400 }
      );
    }
    if (!depart) {
      return NextResponse.json(
        { error: "Departure date is required." },
        { status: 400 }
      );
    }

    const offers = await searchFlightOffers({
      origin,
      destination,
      departDate: depart,
      returnDate: ret,
      adults,
      cabin,
      currency: "USD",
      max: 50,
    });

    const results = (offers || []).map((o: any) => {
      const price = Number(o.price?.grandTotal || 0);

      const outItin = o.itineraries?.[0];
      const segs = outItin?.segments ?? [];
      const carriers = Array.from(
        new Set(segs.map((s: any) => s.carrierCode))
      ).sort();
      const route = segs
        .map(
          (s: any) =>
            `${s.departure?.iataCode}→${s.arrival?.iataCode} (${s.carrierCode}${
              s.number ?? ""
            })`
        )
        .join(" · ");
      const stops = Math.max(0, segs.length - 1);
      const duration = isoToReadableDuration(outItin?.duration);

      return {
        price,
        duration,
        stops,
        route,
        carriers,
        deep_link: null,
        _raw: { id: o.id },
      };
    });

    results.sort((a: any, b: any) =>
      a.price !== b.price ? a.price - b.price : a.stops - b.stops
    );

    return NextResponse.json({ results: results.slice(0, 12) });
  } catch (e: any) {
    return NextResponse.json(
      { error: e.message || "Unexpected error" },
      { status: 500 }
    );
  }
}
