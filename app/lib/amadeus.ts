import fetch from "node-fetch";

const IS_LIVE = (process.env.AMADEUS_ENV || "").toLowerCase() === "live";
const BASE = IS_LIVE
  ? "https://api.amadeus.com"
  : "https://test.api.amadeus.com";

const AUTH_URL = `${BASE}/v1/security/oauth2/token`;
const OFFERS_URL = `${BASE}/v2/shopping/flight-offers`;
const LOCATIONS_URL = `${BASE}/v1/reference-data/locations`;

let cachedToken: { access_token: string; expires_at: number } | null = null;

function must(name: string) {
  const v = process.env[name];
  if (!v || !v.trim()) throw new Error(`Missing env ${name}`);
  return v.trim();
}

async function fetchNewToken() {
  const res = await fetch(AUTH_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: must("AMADEUS_KEY"),
      client_secret: must("AMADEUS_SECRET"),
    }),
  });
  const text = await res.text();
  if (!res.ok) {
    let reason = text;
    try {
      const j = JSON.parse(text);
      reason = j.error_description || j.error || text;
    } catch {}
    throw new Error(`Amadeus auth failed: ${res.status} ${reason}`);
  }
  const j = JSON.parse(text) as { access_token: string; expires_in: number };
  const exp = Math.floor(Date.now() / 1000) + (j.expires_in ?? 1500);
  return { token: j.access_token, exp };
}

export async function getAmadeusToken(): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  if (!cachedToken || cachedToken.expires_at - 30 <= now) {
    const { token, exp } = await fetchNewToken();
    cachedToken = { access_token: token, expires_at: exp };
  }
  return cachedToken.access_token;
}

async function authedFetch(url: string | URL) {
  const token = await getAmadeusToken();
  let res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
  });
  if (res.status === 401) {
    const { token: t2, exp } = await fetchNewToken();
    cachedToken = { access_token: t2, expires_at: exp };
    res = await fetch(url, {
      headers: { Authorization: `Bearer ${t2}`, Accept: "application/json" },
    });
  }
  return res;
}

export async function searchLocations(query: string, max = 8) {
  const q = String(query || "").trim();
  if (q.length < 2) return [];

  const url = new URL(LOCATIONS_URL);
  url.searchParams.set("keyword", q);
  url.searchParams.set("subType", "AIRPORT");
  url.searchParams.set("page[limit]", String(max));

  const res = await authedFetch(url);
  const text = await res.text();
  if (!res.ok)
    throw new Error(`Locations search failed: ${res.status} ${text}`);

  const json = JSON.parse(text) as any;
  return (json?.data ?? []).map((d: any) => ({
    type: d.subType,
    code: d.iataCode,
    name: d.name,
    city: d.address?.cityName || d.name,
    country: d.address?.countryName || "",
  }));
}

export async function searchFlightOffers(args: {
  origin: string;
  destination: string;
  departDate: string;
  returnDate?: string;
  adults?: number;
  cabin?: "ECONOMY" | "PREMIUM_ECONOMY" | "BUSINESS" | "FIRST";
  currency?: string;
  max?: number;
  signal?: AbortSignal;
}) {
  const token = await getAmadeusToken();
  const params = new URLSearchParams({
    originLocationCode: args.origin,
    destinationLocationCode: args.destination,
    departureDate: args.departDate,
    adults: String(args.adults ?? 1),
    travelClass: args.cabin ?? "ECONOMY",
    currencyCode: args.currency ?? "USD",
    max: String(args.max ?? 30),
  });
  if (args.returnDate) params.set("returnDate", args.returnDate);

  const res = await fetch(`${OFFERS_URL}?${params}`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: args.signal,
  });
  if (!res.ok)
    throw new Error(`Offers search failed: ${res.status} ${await res.text()}`);
  const data = (await res.json()) as any;
  console.log(data);
  return (data?.data ?? []) as any[];
}
