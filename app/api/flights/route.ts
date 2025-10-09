// app/api/flights/route.ts — FAST, TRUE AGENT (planning-only), TOKEN-SAFE
// ------------------------------------------------------------------
// Agent does: parse NL + propose small combos (tiny JSON).
// Code does: all Amadeus I/O locally, with parallelism, timeouts, and early-exit.
// ------------------------------------------------------------------

import { NextResponse } from "next/server";
import OpenAI from "openai";
import fetch from "node-fetch";

// ---------- RUNTIME ----------
export const runtime = "nodejs";

// ---------- OPENAI (tiny calls only) ----------
const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY! });

// ---------- AMADEUS CONFIG ----------
const IS_LIVE = (process.env.AMADEUS_ENV || "").toLowerCase() === "live";
const BASE = IS_LIVE
  ? "https://api.amadeus.com"
  : "https://test.api.amadeus.com";
const AUTH_URL = `${BASE}/v1/security/oauth2/token`;
const OFFERS_URL = `${BASE}/v2/shopping/flight-offers`;

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

async function getAmadeusToken(): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  if (!cachedToken || cachedToken.expires_at - 30 <= now) {
    const { token, exp } = await fetchNewToken();
    cachedToken = { access_token: token, expires_at: exp };
  }
  return cachedToken.access_token;
}

// ---------- UTILS ----------
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
async function withRetry<T>(
  fn: (signal?: AbortSignal) => Promise<T>,
  opts: { attempts?: number; timeoutMs?: number } = {}
) {
  const { attempts = 2, timeoutMs = 8000 } = opts;
  let last: any;
  for (let i = 0; i < attempts; i++) {
    try {
      return await withTimeout(fn, timeoutMs);
    } catch (e) {
      last = e;
    }
  }
  throw last;
}
async function firstSuccessful<T>(
  tasks: Array<() => Promise<T>>
): Promise<T | null> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (v: T | null) => {
      if (!settled) {
        settled = true;
        resolve(v);
      }
    };
    for (const t of tasks)
      t()
        .then((v) => finish(v))
        .catch(() => {});
    // If all reject, nothing calls finish; add a guard timeout if you want
    setTimeout(() => finish(null), 12000);
  });
}

// ---------- AMADEUS SEARCH ----------
async function searchFlightOffers(args: {
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
    // @ts-ignore
    signal: args.signal,
  });
  if (!res.ok)
    throw new Error(`Offers search failed: ${res.status} ${await res.text()}`);
  const data = (await res.json()) as any;
  return (data?.data ?? []) as any[];
}

function simplifyAndRank(offers: any[]) {
  const results = offers.map((o) => {
    const it = o.itineraries?.[0];
    const segs = it?.segments ?? [];
    return {
      price: Number(o.price?.grandTotal || 0),
      duration: isoToReadableDuration(it?.duration),
      stops: Math.max(0, segs.length - 1),
      route: segs
        .map(
          (s: any) =>
            `${s.departure?.iataCode}→${s.arrival?.iataCode} (${s.carrierCode}${
              s.number ?? ""
            })`
        )
        .join(" · "),
      carriers: Array.from(new Set(segs.map((s: any) => s.carrierCode))).sort(),
      deep_link: null,
      _raw: { id: o.id },
    };
  });
  results.sort((a: any, b: any) =>
    a.price !== b.price ? a.price - b.price : a.stops - b.stops
  );
  return results.slice(0, 12);
}

// ---------- TOOLS (tiny JSON only) ----------
const tools: OpenAI.Chat.Completions.ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "parse_query",
      description: "Parse NL flight request to structured params",
      parameters: {
        type: "object",
        properties: { query: { type: "string" } },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "expand_combos",
      description: "Nearby airports & ±2-day combos (<=8), tiny JSON only",
      parameters: {
        type: "object",
        properties: {
          origin: { type: "string" },
          destination: { type: "string" },
          depart: { type: "string" },
          ret: { type: ["string", "null"] },
        },
        required: ["origin", "destination", "depart"],
      },
    },
  },
];

type FnToolCall = {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
};
function isFnToolCall(x: any): x is FnToolCall {
  return (
    x &&
    x.type === "function" &&
    x.function &&
    typeof x.function.name === "string"
  );
}
function safeJson<T = any>(s: string): T {
  try {
    return JSON.parse(s) as T;
  } catch {
    return {} as T;
  }
}

async function exec_parse_query(args: { query: string }) {
  const system = `Only JSON: { origin, destination, depart:YYYY-MM-DD, ret:YYYY-MM-DD|null, adults, cabin }`;
  const res = await client.chat.completions.create({
    model: "gpt-4o-mini",
    temperature: 0,
    max_tokens: 120,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: system },
      { role: "user", content: `Query: "${args.query}"` },
    ],
  });
  try {
    return JSON.parse(res.choices[0].message?.content ?? "{}");
  } catch {
    return {};
  }
}

async function exec_expand_combos(args: {
  origin: string;
  destination: string;
  depart: string;
  ret?: string | null;
}) {
  const system = `Only JSON: { "combos": [ { "origin":"...","destination":"...","depart":"YYYY-MM-DD","ret":"YYYY-MM-DD|null" } ] }
Max 8; NYC=JFK/LGA/EWR; RIC=DCA/IAD/ORF; LAX=BUR/LGB/SNA/ONT; SFO=SJC/OAK; LON=LHR/LGW/LCY; TYO=NRT/HND; ±2 days; no past; ret>=depart.`;
  const user = `origin=${args.origin} destination=${args.destination} depart=${
    args.depart
  } ret=${args.ret ?? "null"} today=${new Date().toISOString().slice(0, 10)}`;
  const res = await client.chat.completions.create({
    model: "gpt-4o-mini",
    temperature: 0,
    max_tokens: 180,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
  });
  const text = res.choices[0].message?.content ?? `{"combos":[]}`;
  let combos: any[] = [];
  try {
    const parsed = JSON.parse(text);
    combos = Array.isArray(parsed) ? parsed : parsed.combos || [];
  } catch {}
  const today = new Date(
    new Date().toISOString().slice(0, 10) + "T00:00:00Z"
  ).getTime();
  return (combos || [])
    .map((c) => ({
      origin: String(c.origin || "")
        .toUpperCase()
        .trim(),
      destination: String(c.destination || "")
        .toUpperCase()
        .trim(),
      depart: String(c.depart || "").slice(0, 10),
      ret: c.ret ? String(c.ret).slice(0, 10) : null,
    }))
    .filter(
      (c) =>
        c.origin &&
        c.destination &&
        c.depart &&
        !isNaN(Date.parse(c.depart)) &&
        new Date(c.depart + "T00:00:00Z").getTime() >= today &&
        (!c.ret ||
          new Date(c.ret + "T00:00:00Z").getTime() >=
            new Date(c.depart + "T00:00:00Z").getTime())
    )
    .slice(0, 8);
}

// ---------- AGENT (single hop; planning-only) ----------
const AGENT_SYSTEM = `You are FlightAgent. Use tools to (1) parse the query then (2) optionally propose small combos. Do NOT fetch offers yourself. Return JSON only.`;

async function agent(
  goal: string,
  seed?: Partial<{
    origin: string;
    destination: string;
    depart: string;
    ret?: string | null;
    adults: number;
    cabin: string;
  }>
) {
  const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
    { role: "system", content: AGENT_SYSTEM },
    { role: "user", content: goal },
  ];
  if (seed && Object.keys(seed).length)
    messages.push({ role: "user", content: `Seed: ${JSON.stringify(seed)}` });

  const resp = await client.chat.completions.create({
    model: "gpt-4o-mini",
    temperature: 0,
    max_tokens: 200,
    tools,
    tool_choice: "auto",
    messages,
  });

  let params: any = { ...seed };
  let combos: any[] = [];
  const msg = resp.choices[0].message!;
  const calls = (msg.tool_calls ?? []) as any[];

  for (const c of calls) {
    if (!isFnToolCall(c)) continue;
    const { name, arguments: argsStr } = c.function;
    const args = safeJson(argsStr);
    if (name === "parse_query")
      params = { ...params, ...(await exec_parse_query(args)) };
    if (name === "expand_combos") combos = await exec_expand_combos(args);
  }
  return { params, combos };
}

// ---------- HTTP HANDLER ----------
export async function POST(req: Request) {
  try {
    const body = await req.json();

    // Seed from structured input if present
    const seed =
      body.from || body.to || body.depart
        ? {
            origin: String(body.from || "").toUpperCase(),
            destination: String(body.to || "").toUpperCase(),
            depart: String(body.depart || ""),
            ret: body.return ? String(body.return) : undefined,
            adults: Math.max(1, Number(body.adults || 1)),
            cabin:
              (
                {
                  M: "ECONOMY",
                  W: "PREMIUM_ECONOMY",
                  C: "BUSINESS",
                  F: "FIRST",
                } as any
              )[String(body.cabin || "M")] || "ECONOMY",
          }
        : undefined;

    const goal = body.query
      ? `Find flights for: ${String(body.query)}`
      : `Find flights for structured params`;

    // 1) Agent planning (one LLM call)
    const { params, combos } = await agent(goal, seed);

    // 2) Resolve final inputs
    const origin = String(params.origin || seed?.origin || "").toUpperCase();
    const destination = String(
      params.destination || seed?.destination || ""
    ).toUpperCase();
    const depart = String(params.depart || seed?.depart || "");
    const ret = ensureReturnAfterDepart(depart, params.ret ?? seed?.ret);
    const adults = Math.max(1, Number(params.adults || seed?.adults || 1));
    const cabin = String(
      params.cabin || seed?.cabin || "ECONOMY"
    ).toUpperCase() as any;

    if (!origin || !destination || !depart) {
      return NextResponse.json(
        { error: "Missing origin/destination/depart." },
        { status: 400 }
      );
    }

    // 3) Primary Amadeus search (retry + timeout)
    let offers = await withRetry(
      (signal) =>
        searchFlightOffers({
          origin,
          destination,
          departDate: depart,
          returnDate: ret,
          adults,
          cabin,
          currency: "USD",
          max: 40,
          signal,
        }),
      { attempts: 2, timeoutMs: 9000 }
    );

    let used: any = {
      origin,
      destination,
      departDate: depart,
      returnDate: ret,
    };
    let expandedByLLM = false;

    // 4) If none, try agent-proposed combos — run in PARALLEL (limit=4) with EARLY EXIT
    if (!offers?.length && combos?.length) {
      expandedByLLM = true;
      const d0 = new Date(depart).getTime();
      const ordered = [...combos]
        .sort((a: any, b: any) => {
          const score = (c: any) =>
            (c.origin === origin ? -2 : 0) +
            (c.destination === destination ? -2 : 0) +
            Math.abs(new Date(c.depart).getTime() - d0) / (1000 * 60 * 60 * 24);
          return score(a) - score(b);
        })
        .slice(0, 12);

      const tasks = ordered.map((c: any) => async () => {
        const rr = ensureReturnAfterDepart(c.depart, c.ret ?? undefined);
        const next = await withRetry(
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
          { attempts: 1, timeoutMs: 7000 }
        );
        if (next?.length)
          return {
            offers: next,
            used: {
              origin: c.origin,
              destination: c.destination,
              departDate: c.depart,
              returnDate: rr,
            },
          };
        throw new Error("no-offers");
      });

      // chunk into groups of 4 and early-exit as soon as any find results
      for (let i = 0; i < tasks.length && !offers?.length; i += 4) {
        const batch = tasks.slice(i, i + 4);
        const found = await firstSuccessful(batch);
        if (found) {
          offers = (found as any).offers;
          used = (found as any).used;
          break;
        }
      }
    }

    // 5) Business fallback → quick ECONOMY search
    if (!offers?.length && cabin === "BUSINESS") {
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
          3500
        );
        if (econ?.length) {
          offers = econ;
          used = { ...used, note: "No business found; showing economy." };
        }
      } catch {}
    }

    // 6) Return
    if (!offers?.length) {
      return NextResponse.json({
        results: [],
        used,
        expandedByLLM,
        note: expandedByLLM
          ? "No offers found after AI expansion."
          : "No offers found.",
      });
    }

    const results = simplifyAndRank(offers);
    return NextResponse.json({ results, used, expandedByLLM });
  } catch (e: any) {
    return NextResponse.json(
      { error: String(e.message || e) },
      { status: 500 }
    );
  }
}
