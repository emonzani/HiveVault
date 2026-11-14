import type { PrincipalRow } from "@cb/auth";

/** Public view of a principal (no internal fields beyond what the console shows). */
export function principalView(p: PrincipalRow) {
  return {
    id: p.id,
    kind: p.kind,
    name: p.name,
    displayName: p.displayName,
    email: p.email,
    role: p.role,
    scopes: p.scopes,
    clearance: p.clearance,
    status: p.status,
    expiresAt: p.expiresAt,
    allowedIps: p.allowedIps,
    ratePerMin: p.ratePerMin,
    createdAt: p.createdAt,
    lastSeenAt: p.lastSeenAt,
    userId: p.userId,
  };
}
