// lib/llmAgent.ts
import OpenAI from "openai";

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY! });

/**
 * 1) Parse a natural-language query into structured params.
 * Returns: { origin, destination, depart, ret?, adults, cabin }
 */
export async function llmParseQuery(query: string) {
  const system = `You are a flight planner. Extract a minimal JSON spec.
Return ONLY JSON. Fields:
- origin: 3-letter IATA if possible (e.g., JFK), else a city group like NYC
- destination: 3-letter IATA or group (LON, TYO)
- depart: YYYY-MM-DD
- ret: YYYY-MM-DD or null
- adults: integer >=1 (default 1)
- cabin: ECONOMY | PREMIUM_ECONOMY | BUSINESS | FIRST (default ECONOMY)`;

  const user = `Query: "${query}"\nToday (ISO): ${new Date()
    .toISOString()
    .slice(0, 10)}`;

  const res = await client.chat.completions.create({
    model: "gpt-4o-mini",
    temperature: 0.2,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
  });

  const raw = res.choices[0].message?.content?.trim() || "{}";
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function safeParseCombos(raw: string): Array<{
  origin: string;
  destination: string;
  depart: string;
  ret?: string | null;
}> {
  try {
    // Preferred: { "combos": [...] }
    const obj = JSON.parse(raw);
    if (Array.isArray(obj)) return obj; // if model returns array directly
    if (obj && Array.isArray(obj.combos)) return obj.combos;
  } catch {
    /* fall through to regex */
  }

  // Strip code fences if present
  const cleaned = raw
    .replace(/```(?:json)?/gi, "")
    .replace(/```/g, "")
    .trim();

  // Try to find the first [...] block
  const m = cleaned.match(/\[[\s\S]*\]/);
  if (m) {
    try {
      const arr = JSON.parse(m[0]);
      if (Array.isArray(arr)) return arr;
    } catch {}
  }

  // Try to find {"combos":[...]}
  const m2 = cleaned.match(/\{\s*"combos"\s*:\s*\[[\s\S]*\]\s*\}/);
  if (m2) {
    try {
      const obj2 = JSON.parse(m2[0]);
      if (Array.isArray(obj2?.combos)) return obj2.combos;
    } catch {}
  }

  return [];
}

export async function llmExpandCombos(input: {
  origin: string;
  destination: string;
  depart: string;
  ret?: string;
}) {
  const system = `
  You are a flight search strategist.
  Return ONLY a JSON object: { "combos": [ { "origin": "...", "destination": "...", "depart": "YYYY-MM-DD", "ret": "YYYY-MM-DD or null" }, ... ] }
  Rules:
  - Propose up to 12 combos.
  - Nearby airports only (NYC=JFK/LGA/EWR; RIC=DCA/IAD/ORF; LAX=BUR/LGB/SNA/ONT; SFO=SJC/OAK; LON=LHR/LGW/LCY; TYO=NRT/HND).
  - Shift dates within ±2 days of base depart/ret.
  - Do NOT include past dates; do NOT set ret < depart.
  - No prose, no extra keys.`;

  const user = `Base:
  origin=${input.origin}
  destination=${input.destination}
  depart=${input.depart}
  ret=${input.ret ?? "null"}
  today=${new Date().toISOString().slice(0, 10)}
  Return strictly: { "combos": [ ... ] }`;

  const res = await client.chat.completions.create({
    model: "gpt-4o-mini",
    temperature: 0.3,
    response_format: { type: "json_object" }, // <-- force valid JSON object
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
  });

  const raw = res.choices[0].message?.content ?? `{"combos":[]}`;
  // If the model *still* returns an array, safeParseCombos will handle it.
  const combos = safeParseCombos(raw);

  // Normalize + validate
  const today = new Date(
    new Date().toISOString().slice(0, 10) + "T00:00:00Z"
  ).getTime();
  const cleaned = combos
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
    .slice(0, 12);

  return cleaned;
}
