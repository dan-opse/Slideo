import { NextRequest, NextResponse } from "next/server";
import { authorize } from "@/lib/auth";
import { files } from "@/lib/files";
import { fileKey, get, withAccount } from "@/lib/store";
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const who = await authorize(req);
  if (who instanceof NextResponse) return who;
  try {
    const { id } = await params;
    return await withAccount(who, async () => {
      await get("asset", id);
      const key = fileKey("assets", `${id}.jpg`);
      // Hosted images come straight from storage through a short-lived link.
      const link = await files().signedUrl(key);
      if (link)
        return NextResponse.redirect(link, {
          headers: { "Cache-Control": "private, max-age=1800" },
        });
      const data = await files().read(key);
      if (!data) return new NextResponse("Not found", { status: 404 });
      return new NextResponse(new Uint8Array(data), {
        headers: {
          "Content-Type": "image/jpeg",
          "Cache-Control": "private, max-age=86400",
        },
      });
    });
  } catch {
    return new NextResponse("Not found", { status: 404 });
  }
}
