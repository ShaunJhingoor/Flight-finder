import { NextResponse } from "next/server";
import { searchLocations } from "../../lib/amadeus";

export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url);
    const q = (searchParams.get("q") || "").trim();
    if (!q) return NextResponse.json({ results: [] });
    const results = await searchLocations(q, 8);
    return NextResponse.json({ results });
  } catch (e: any) {
    return NextResponse.json({ error: e.message || "Error" }, { status: 500 });
  }
}
