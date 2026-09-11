import { NextRequest, NextResponse } from "next/server";
import { guard } from "@/lib/guard";
import { renderSlide } from "@/lib/render";
export async function GET(
  req: NextRequest,
  {
    params,
  }: { params: Promise<{ post: string; revision: string; slide: string }> },
) {
  const denied = guard(req);
  if (denied) return denied;
  try {
    const p = await params;
    const data = await renderSlide(p.post, Number(p.revision), Number(p.slide));
    return new NextResponse(data, {
      headers: {
        "Content-Type": "image/jpeg",
        "Cache-Control": "private, max-age=31536000, immutable",
      },
    });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Render failed" },
      { status: 422 },
    );
  }
}
