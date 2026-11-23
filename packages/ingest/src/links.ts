/**
 * External links (plan §4.3): the only ingestion path with outgoing traffic. The page is
 * downloaded TO the server and stored as L0 like any upload.
 *
 * - SSRF: the host must resolve only to public addresses (no LAN, loopback, link-local or
 *   cloud metadata): "import this link" must not become a way to read internal services.
 * - The egress guard opens the host for this download only; redirects are followed by hand,
 *   each hop checked again, at most 5.
 * - Limits: 20 MB, 30 s, http/https only.
 */
import { lookup } from "node:dns/promises";
import { isNonPublicAddress, type EgressGuard } from "@cb/shared";

export class LinkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LinkError";
  }
}

export interface FetchedLink {
  url: string;
  data: Buffer;
  contentType: string;
  name: string;
}

const MAX_BYTES = 20 * 1024 * 1024;

export async function fetchLink(rawUrl: string, guard: EgressGuard | undefined, o: { timeoutMs?: number; allowPrivate?: boolean } = {}): Promise<FetchedLink> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new LinkError("Indirizzo non valido.");
  }
  const deadline = AbortSignal.timeout(o.timeoutMs ?? 30_000);
  for (let hop = 0; hop < 6; hop++) {
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new LinkError("Sono ammessi solo link http e https.");
    if (url.username || url.password) throw new LinkError("I link con credenziali non sono ammessi.");
    const host = url.hostname.replace(/^\[|\]$/g, "");
    if (!o.allowPrivate) {
      const addrs = await lookup(host, { all: true }).catch(() => {
        throw new LinkError(`Il nome "${host}" non si risolve.`);
      });
      if (addrs.some((a) => isNonPublicAddress(a.address))) throw new LinkError("Il link punta a un indirizzo della rete interna: non è ammesso.");
    }
    const doFetch = () =>
      fetch(url, { redirect: "manual", signal: deadline, headers: { "user-agent": "HiveVault/0.1 (+link import)", accept: "text/html,application/pdf,*/*;q=0.5" } });
    // the check above is a fast, clear answer; the guard checks again the address the connection uses
    const res = guard ? await guard.allowFor([host], doFetch, { publicOnly: !o.allowPrivate }) : await doFetch();
    if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
      url = new URL(res.headers.get("location")!, url);
      continue;
    }
    if (!res.ok) throw new LinkError(`Il sito ha risposto ${res.status}.`);
    const declared = Number(res.headers.get("content-length") ?? 0);
    if (declared > MAX_BYTES) throw new LinkError("Il contenuto supera 20 MB.");
    const parts: Buffer[] = [];
    let size = 0;
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      size += chunk.length;
      if (size > MAX_BYTES) throw new LinkError("Il contenuto supera 20 MB.");
      parts.push(Buffer.from(chunk));
    }
    const contentType = res.headers.get("content-type") ?? "application/octet-stream";
    const last = decodeURIComponent(url.pathname.split("/").filter(Boolean).pop() ?? "") || url.hostname;
    const name = /\.[a-z0-9]{2,5}$/i.test(last) ? last : `${last}.${contentType.includes("pdf") ? "pdf" : "html"}`;
    return { url: url.toString(), data: Buffer.concat(parts), contentType, name };
  }
  throw new LinkError("Troppi reindirizzamenti.");
}
