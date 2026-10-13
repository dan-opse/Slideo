import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { authorize, hosted } from "@/lib/auth";
import { readLimited } from "@/lib/body";
import { files, UPLOAD_BYTES } from "@/lib/files";
import { fileKey, StudioError, withAccount } from "@/lib/store";

// The local studio's stand-in for a signed storage upload URL. Hosted
// studios upload to Supabase Storage directly and never use this route.
export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  if (hosted()) return new NextResponse("Not found", { status: 404 });
  const who = await authorize(req);
  if (who instanceof NextResponse) return who;
  try {
    const id = z.uuid().parse((await params).id);
    const bytes = await readLimited(
      req,
      UPLOAD_BYTES,
      "Upload limit is 20 MB.",
    );
    return await withAccount(who, async () => {
      await files().write(
        fileKey("uploads", id),
        Buffer.from(bytes),
        "application/octet-stream",
      );
      return NextResponse.json({ ok: true });
    });
  } catch (e) {
    if (e instanceof StudioError)
      return NextResponse.json({ error: e.message }, { status: e.status });
    return NextResponse.json({ error: "Upload failed." }, { status: 400 });
  }
}
