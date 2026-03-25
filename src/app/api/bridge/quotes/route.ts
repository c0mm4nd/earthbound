import { NextRequest, NextResponse } from "next/server";
import { fetchStargateApiJson } from "@/lib/layerzero";

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { response, data } = await fetchStargateApiJson("/quotes", {
      method: "POST",
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const message =
        (typeof data?.message === "string" && data.message) ||
        (typeof data?.error === "string" && data.error) ||
        (typeof data?.error?.message === "string" && data.error.message) ||
        "Failed to request bridge quote.";

      return NextResponse.json({ error: message }, { status: response.status });
    }

    return NextResponse.json(data, { status: response.status });
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : "Failed to request bridge quote.",
      },
      { status: 500 },
    );
  }
}
