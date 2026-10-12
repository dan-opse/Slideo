import { NextRequest, NextResponse } from "next/server";
import JSZip from "jszip";
import { guard } from "@/lib/guard";
import { assertApproval, audit, get, StudioError } from "@/lib/store";
import { renderAll } from "@/lib/render";
import type { Post } from "@/lib/schema";
import { logUnexpected } from "@/lib/log";
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const denied = guard(req);
  if (denied) return denied;
  let id: string | undefined;
  try {
    ({ id } = await params);
    const post = get<Post>("post", id);
    // The client names the revision it displayed; a newer approval made in
    // another window must never be exported in its place.
    const expected = req.nextUrl.searchParams.get("revision");
    if (!expected || !/^\d+$/.test(expected))
      throw new StudioError("Reload the studio, then download again.", 400);
    if (Number(expected) !== post.revision)
      throw new StudioError(
        "This slideshow changed in another window. Reload to review the current version before downloading.",
        409,
      );
    const approved = assertApproval(post);
    const { buffers, hashes } = await renderAll(id, post.revision);
    if (JSON.stringify(hashes) !== JSON.stringify(approved))
      throw new StudioError(
        "Rendered files changed. Review and approve again.",
        409,
      );
    const current = get<Post>("post", id);
    assertApproval(current);
    if (current.revision !== post.revision)
      throw new StudioError("Post changed during export.", 409);
    const slide = req.nextUrl.searchParams.get("slide");
    if (slide !== null) {
      const i = /^\d+$/.test(slide) ? Number(slide) : NaN;
      if (!Number.isInteger(i) || !buffers[i])
        throw new StudioError("Unknown slide", 404);
      return new NextResponse(new Uint8Array(buffers[i]), {
        headers: {
          "Content-Type": "image/jpeg",
          "Content-Disposition": `attachment; filename="slide-${String(i + 1).padStart(2, "0")}.jpg"`,
          "Cache-Control": "no-store",
        },
      });
    }
    const zip = new JSZip();
    buffers.forEach((b, i) =>
      zip.file(`slide-${String(i + 1).padStart(2, "0")}.jpg`, b),
    );
    zip.file("caption.txt", post.caption);
    zip.file(
      "manifest.json",
      JSON.stringify(
        {
          postId: id,
          revision: post.revision,
          title: post.title,
          account: post.account,
          plannedAt: post.plannedAt,
          notes: post.notes,
          delivery: "manual-export",
          hashes,
        },
        null,
        2,
      ),
    );
    zip.file(
      "README.txt",
      "Upload slide images in numerical order. Paste caption.txt and review music and disclosure settings in TikTok. Downloading this package does not publish it. Record the post URL in the studio after publishing.",
    );
    audit("export.downloaded", id);
    return new NextResponse(
      new Uint8Array(await zip.generateAsync({ type: "nodebuffer" })),
      {
        headers: {
          "Content-Type": "application/zip",
          "Content-Disposition": `attachment; filename="slideshow-${id.slice(0, 8)}-v${post.revision}.zip"`,
          "Cache-Control": "no-store",
        },
      },
    );
  } catch (e) {
    if (e instanceof StudioError)
      return NextResponse.json({ error: e.message }, { status: e.status });
    logUnexpected("Export", e, {
      post: id,
      revision: req.nextUrl.searchParams.get("revision") ?? undefined,
    });
    return NextResponse.json(
      { error: "The export could not be created. Try again." },
      { status: 500 },
    );
  }
}
