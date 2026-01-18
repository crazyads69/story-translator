import { isIP } from "node:net";

function isPrivateIPv4(ip: string): boolean {
  const parts = ip.split(".").map((p) => Number(p));
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) return false;
  const [a, b] = parts;
  if (a === 10) return true;
  if (a === 127) return true;
  if (a === 0) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b !== undefined && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  return false;
}

/**
 * Coarse SSRF guard for enrichment fetching.
 *
 * - allow only http/https
 * - block localhost and private IPv4 literals
 *
 * This is not a complete SSRF solution (DNS rebinding, IPv6, proxies).
 * For high-assurance environments, resolve DNS and enforce allowlists.
 */
export function isSafePublicHttpUrl(raw: string): boolean {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return false;
  const host = u.hostname.toLowerCase();
  if (host === "localhost") return false;
  if (isIP(host) === 4 && isPrivateIPv4(host)) return false;
  return true;
}

