import { NextRequest, NextResponse } from "next/server";
import { authorize } from "@/lib/auth";
import { renderSlide } from "@/lib/render";
import { StudioError, withAccount } from "@/lib/store";
import { logUnexpected } from "@/lib/log";
export const maxDuration = 60;
export async function GET(
  req: NextRequest,
  {
    params,
  }: { params: Promise<{ post: string; revision: string; slide: string }> },
) {
  const who = await authorize(req);
  if (who instanceof NextResponse) return who;
  let p: { post: string; revision: string; slide: string } | undefined;
  try {
    p = await params;
    const post = p.post,
      revision = Number(p.revision),
      slide = Number(p.slide);
    if (!Number.isInteger(revision) || !Number.isInteger(slide))
      throw new StudioError("Slide not found", 404);
    const data = await withAccount(who, () =>
      renderSlide(post, revision, slide),
    );
    return new NextResponse(new Uint8Array(data), {
      headers: {
        "Content-Type": "image/jpeg",
        "Cache-Control": "private, max-age=31536000, immutable",
      },
    });
  } catch (e) {
    // Only deliberate, user-facing errors are echoed; anything else may
    // contain server paths.
    if (e instanceof StudioError)
      return NextResponse.json({ error: e.message }, { status: e.status });
    logUnexpected("Render", e, {
      post: p?.post,
      revision: p?.revision,
      slide: p?.slide,
    });
    return NextResponse.json(
      { error: "This slide could not be rendered." },
      { status: 500 },
    );
  }
}
