// app/api/flights/route.ts — token-safe agent (no large tool payloads in messages)

import { NextResponse } from "next/server";
import OpenAI from "openai";
import fetch from "node-fetch";

// -------------------- OPENAI --------------------
const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY! });

// -------------------- AMADEUS -------------------
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

// -------------------- UTILS --------------------
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

// -------------------- AMADEUS CALL --------------------
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

// -------------------- TOOLS (TINY RESPONSES) --------------------
const tools: OpenAI.Chat.Completions.ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "parse_query",
      description: "Parse NL flight request into structured params",
      parameters: {
        type: "object",
        properties: { query: { type: "string" } },
        required: ["query"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "expand_combos",
      description: "Propose up to 8 nearby-airport ±2-day combos",
      parameters: {
        type: "object",
        properties: {
          origin: { type: "string" },
          destination: { type: "string" },
          depart: { type: "string" },
          ret: { type: ["string", "null"] },
        },
        required: ["origin", "destination", "depart"],
        additionalProperties: false,
      },
    },
  },
];

// Keep large data OFF the message stream: store it here by tool_call_id.
const toolStore = new Map<string, any>();

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
function safeJson(s: string) {
  try {
    return JSON.parse(s);
  } catch {
    return {};
  }
}

// -------------------- TOOL EXECUTORS --------------------
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
  const raw = res.choices[0].message?.content?.trim() || "{}";
  try {
    return JSON.parse(raw);
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
  const system =
    `Only JSON: { "combos": [ { "origin":"...","destination":"...","depart":"YYYY-MM-DD","ret":"YYYY-MM-DD|null" } ] }\n` +
    `Max 8; Nearby(NYC=JFK/LGA/EWR; RIC=DCA/IAD/ORF; LAX=BUR/LGB/SNA/ONT; SFO=SJC/OAK; LON=LHR/LGW/LCY; TYO=NRT/HND); ±2 days; no past; ret>=depart.`;
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
        !isNaN(new Date(c.depart + "T00:00:00Z").getTime()) &&
        new Date(c.depart + "T00:00:00Z").getTime() >= today &&
        (!c.ret ||
          new Date(c.ret + "T00:00:00Z").getTime() >=
            new Date(c.depart + "T00:00:00Z").getTime())
    )
    .slice(0, 8);
}

// -------------------- AGENT LOOP (SHORT) --------------------
const AGENT_SYSTEM = `You are FlightAgent. Call tools, keep outputs tiny. Never echo large arrays. Finish as soon as you have results. Return JSON only.`;

async function agent(
  goalMessage: string,
  seedParams?: Partial<{
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
    { role: "user", content: goalMessage },
  ];
  if (seedParams && Object.keys(seedParams).length) {
    messages.push({
      role: "user",
      content: `Seed: ${JSON.stringify(seedParams)}`,
    });
  }

  const MAX_STEPS = 3;
  let state: any = { used: {}, expandedByLLM: false, results: [] };

  for (let step = 0; step < MAX_STEPS; step++) {
    const resp = await client.chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0,
      max_tokens: 200,
      tools,
      tool_choice: "auto",
      messages,
    });

    const msg = resp.choices[0].message!;
    const calls = (msg.tool_calls ?? []) as any[];

    if (calls.length) {
      // Store the assistant message stub (no big content)
      messages.push({
        role: "assistant",
        content: msg.content || "",
        tool_calls: calls as any,
      } as any);

      for (const c of calls) {
        if (!isFnToolCall(c)) continue;
        const { name, arguments: argsStr } = c.function;
        const args = safeJson(argsStr);

        try {
          if (name === "parse_query") {
            const out = await exec_parse_query(args);
            toolStore.set(c.id, out);
            messages.push({
              role: "tool",
              tool_call_id: c.id,
              content: JSON.stringify({ ok: true }),
            } as any);
          } else if (name === "expand_combos") {
            state.expandedByLLM = true;
            const out = await exec_expand_combos(args);
            toolStore.set(c.id, { combos: out });
            messages.push({
              role: "tool",
              tool_call_id: c.id,
              content: JSON.stringify({ ok: true, n: out.length }),
            } as any);
          } else {
            // Unknown tool name; ACK tiny
            messages.push({
              role: "tool",
              tool_call_id: c.id,
              content: JSON.stringify({ ok: false, error: "unknown_tool" }),
            } as any);
          }
        } catch (e: any) {
          messages.push({
            role: "tool",
            tool_call_id: c.id,
            content: JSON.stringify({
              ok: false,
              error: String(e?.message || e),
            }),
          } as any);
        }
      }

      // Keep iterating; model will read tiny tool ACKs and decide next call
      continue;
    }

    // If model emits final JSON early, try to parse and return
    if (msg.content) {
      try {
        return JSON.parse(msg.content);
      } catch {}
      // If we already computed results elsewhere, return them
      if (state.results?.length)
        return {
          results: state.results,
          used: state.used,
          expandedByLLM: state.expandedByLLM,
        };
      // Otherwise nudge once
      messages.push({
        role: "user",
        content: "Please provide final JSON, or call a tool.",
      });
    }
  }

  return {
    results: state.results ?? [],
    used: state.used ?? {},
    expandedByLLM: state.expandedByLLM,
    note: "Reached max steps.",
  };
}

// -------------------- HTTP HANDLER --------------------
export const runtime = "nodejs";

export async function POST(req: Request) {
  try {
    const body = await req.json();

    // Prefer structured path; LLM only if needed for parsing or combos.
    let origin: string,
      destination: string,
      depart: string,
      ret: string | undefined,
      adults: number,
      cabin: "ECONOMY" | "PREMIUM_ECONOMY" | "BUSINESS" | "FIRST";

    if (body.query) {
      // Let the tiny tool parse it:
      const parsed = await exec_parse_query({ query: String(body.query) });
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

    // Primary search
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
          max: 50,
          signal,
        }),
      { attempts: 2, timeoutMs: 10000 }
    );

    let used: any = {
      origin,
      destination,
      departDate: depart,
      returnDate: ret,
    };
    let expandedByLLM = false;

    if (!offers?.length) {
      // Ask LLM for small combo suggestions (tiny JSON), then try them locally.
      expandedByLLM = true;
      const combos = await exec_expand_combos({
        origin,
        destination,
        depart,
        ret: ret ?? null,
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
      const ordered = combos.sort((a, b) => score(a) - score(b)).slice(0, 8);

      for (const c of ordered) {
        const rr = ensureReturnAfterDepart(c.depart, c.ret ?? undefined);
        try {
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
            { attempts: 1, timeoutMs: 8000 }
          );
          if (next?.length) {
            offers = next;
            used = {
              origin: String(c.origin).toUpperCase(),
              destination: String(c.destination).toUpperCase(),
              departDate: String(c.depart),
              returnDate: rr,
            };
            break;
          }
        } catch {
          /* try next combo */
        }
      }

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
            4000
          );
          if (econ?.length) {
            offers = econ;
            used = { ...used, note: "No business found; showing economy." };
          }
        } catch {}
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

    const results = simplifyAndRank(offers);

    return NextResponse.json({ results, used, expandedByLLM });
  } catch (e: any) {
    return NextResponse.json(
      { error: String(e.message || e) },
      { status: 500 }
    );
  }
}
