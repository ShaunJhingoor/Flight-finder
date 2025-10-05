import fetch from "node-fetch";

const AUTH_URL = "https://test.api.amadeus.com/v1/security/oauth2/token";
const OFFERS_URL = "https://test.api.amadeus.com/v2/shopping/flight-offers";
const LOCATIONS_URL =
  "https://test.api.amadeus.com/v1/reference-data/locations";

let cachedToken: { access_token: string; expires_at: number } | null = null;

async function getAmadeusToken(): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  if (cachedToken && cachedToken.expires_at - 30 > now)
    return cachedToken.access_token;

  const res = await fetch(AUTH_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: process.env.AMADEUS_KEY || "",
      client_secret: process.env.AMADEUS_SECRET || "",
    }),
  });
  if (!res.ok)
    throw new Error(`Amadeus auth failed: ${res.status} ${await res.text()}`);
  const json = (await res.json()) as {
    access_token: string;
    expires_in: number;
  };
  cachedToken = {
    access_token: json.access_token,
    expires_at: Math.floor(Date.now() / 1000) + (json.expires_in ?? 1500),
  };
  return cachedToken.access_token;
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
  });
  if (!res.ok)
    throw new Error(`Offers search failed: ${res.status} ${await res.text()}`);
  const data = (await res.json()) as any;
  return (data?.data ?? []) as any[];
}

export async function searchLocations(query: string, max = 8) {
  const token = await getAmadeusToken();
  const url = new URL(LOCATIONS_URL);
  url.searchParams.set("keyword", query);
  url.searchParams.set("subType", "AIRPORT");
  url.searchParams.set("page[limit]", String(max));

  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok)
    throw new Error(
      `Locations search failed: ${res.status} ${await res.text()}`
    );
  const json = (await res.json()) as any;

  return (json?.data ?? []).map((d: any) => ({
    type: d.subType,
    code: d.iataCode,
    name: d.name,
    city: d.address?.cityName || d.name,
    country: d.address?.countryName,
  }));
}
