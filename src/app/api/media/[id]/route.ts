import { NextRequest, NextResponse } from "next/server";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { guard } from "@/lib/guard";
import { dataDir, get } from "@/lib/store";
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const denied = guard(req);
  if (denied) return denied;
  try {
    const { id } = await params;
    get("asset", id);
    const data = await readFile(path.join(dataDir, "assets", `${id}.jpg`));
    return new NextResponse(data, {
      headers: {
        "Content-Type": "image/jpeg",
        "Cache-Control": "private, max-age=86400",
      },
    });
  } catch {
    return new NextResponse("Not found", { status: 404 });
  }
}
