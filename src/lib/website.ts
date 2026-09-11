import { BlockList, isIP } from "node:net";
import { lookup as dnsLookup } from "node:dns/promises";
import { load } from "cheerio";
import { StudioError } from "./store";

const MAX_REDIRECTS = 3;
const MAX_BYTES = 1024 * 1024;
const MAX_TEXT = 40_000;
const FETCH_TIMEOUT_MS = 10_000;

const blocked = new BlockList();
[
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
].forEach(([address, prefix]) =>
  blocked.addSubnet(String(address), Number(prefix), "ipv4"),
);
[
  ["::", 128],
  ["::1", 128],
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8],
  ["2001:db8::", 32],
].forEach(([address, prefix]) =>
  blocked.addSubnet(String(address), Number(prefix), "ipv6"),
);

export type LookupAddress = { address: string; family: number };
type Lookup = (hostname: string) => Promise<LookupAddress[]>;

const defaultLookup: Lookup = (hostname) =>
  dnsLookup(hostname, { all: true, verbatim: true });

function isBlockedAddress(address: string) {
  const mapped = address.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i)?.[1];
  if (mapped) return blocked.check(mapped, "ipv4");
  const family = isIP(address);
  return family === 0 || blocked.check(address, family === 4 ? "ipv4" : "ipv6");
}

export async function assertPublicWebsiteUrl(
  value: string,
  lookup: Lookup = defaultLookup,
) {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new StudioError("Enter a valid HTTPS website URL.");
  }
  if (url.protocol !== "https:")
    throw new StudioError("Website analysis accepts public HTTPS URLs only.");
  if (url.username || url.password || (url.port && url.port !== "443"))
    throw new StudioError("That website URL is not allowed.");

  const hostname = url.hostname.toLowerCase().replace(/\.$/, "");
  if (
    !hostname ||
    isIP(hostname) ||
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".local") ||
    hostname === "metadata.google.internal"
  )
    throw new StudioError("That website address is not public.");

  let addresses: LookupAddress[];
  try {
    addresses = await lookup(hostname);
  } catch {
    throw new StudioError("The website hostname could not be resolved.", 422);
  }
  if (
    !addresses.length ||
    addresses.some((item) => isBlockedAddress(item.address))
  )
    throw new StudioError("That website resolves to a non-public address.");
  return url;
}

async function readLimitedBody(response: Response) {
  const declared = Number(response.headers.get("content-length") || 0);
  if (declared > MAX_BYTES)
    throw new StudioError("The website page is larger than 1 MB.", 413);
  if (!response.body) return "";

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BYTES) {
      await reader.cancel();
      throw new StudioError("The website page is larger than 1 MB.", 413);
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

export type WebsiteSource = {
  url: string;
  title: string;
  content: string;
};

export async function readWebsite(
  value: string,
  options: { fetchImpl?: typeof fetch; lookup?: Lookup } = {},
): Promise<WebsiteSource> {
  const fetchImpl = options.fetchImpl || fetch;
  const lookup = options.lookup || defaultLookup;
  let current = await assertPublicWebsiteUrl(value, lookup);
  const signal = AbortSignal.timeout(FETCH_TIMEOUT_MS);

  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
    let response: Response;
    try {
      response = await fetchImpl(current, {
        redirect: "manual",
        headers: {
          accept: "text/html,application/xhtml+xml",
          "user-agent": "FieldworkWebsiteReader/1.0",
        },
        signal,
      });
    } catch (error) {
      if (error instanceof StudioError) throw error;
      throw new StudioError(
        "The website did not respond within 10 seconds.",
        504,
      );
    }

    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get("location");
      if (!location)
        throw new StudioError("The website returned an invalid redirect.", 422);
      if (redirects === MAX_REDIRECTS)
        throw new StudioError("The website redirected too many times.", 422);
      current = await assertPublicWebsiteUrl(
        new URL(location, current).href,
        lookup,
      );
      continue;
    }
    if (!response.ok)
      throw new StudioError(
        `The website returned HTTP ${response.status}.`,
        422,
      );

    const contentType =
      response.headers.get("content-type")?.toLowerCase() || "";
    if (
      !contentType.includes("text/html") &&
      !contentType.includes("application/xhtml+xml")
    )
      throw new StudioError("Website analysis only supports HTML pages.", 415);

    const html = await readLimitedBody(response);
    const $ = load(html);
    $(
      "script,style,noscript,svg,canvas,iframe,nav,footer,form,dialog",
    ).remove();
    const clean = (text: string) => text.replace(/\s+/g, " ").trim();
    const title = clean($("title").first().text()) || current.hostname;
    const description = clean(
      $('meta[name="description"]').attr("content") ||
        $('meta[property="og:description"]').attr("content") ||
        "",
    );
    const headings = $("h1,h2,h3")
      .map((_, element) => clean($(element).text()))
      .get()
      .filter(Boolean)
      .slice(0, 40);
    const primary = $("main,article,[role=main]").first();
    const body = clean((primary.length ? primary : $("body")).text());
    const content = [title, description, ...headings, body]
      .filter(Boolean)
      .join("\n")
      .slice(0, MAX_TEXT);
    if (!content)
      throw new StudioError("No readable website content was found.", 422);
    return { url: current.href, title: title.slice(0, 300), content };
  }
  throw new StudioError("The website redirected too many times.", 422);
}
