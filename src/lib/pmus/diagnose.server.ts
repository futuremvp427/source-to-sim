/**
 * Read-only authentication diagnostics. Reports safe metadata only: never the
 * key ID, the secret, decoded bytes, a signature, or auth headers.
 */

import { ALLOWED_OPERATIONS, getBalances, getPositions } from "./capabilities.server";
import { normalizeSecretValue } from "./credentials.server";
import { safeErrorMessage } from "./redact";
import { signRequest } from "./signer.server";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type PmusAuthDiagnosis = {
  keyIdIsUuid: boolean;
  secretBase64Decodes: boolean;
  decodedSecretByteLength: number | null;
  normalizationApplied: boolean;
  signedRequests: { method: string; path: string; timestampDigits: number; signatureBase64Length: number; signatureByteLength: number }[];
  balances: { ok: boolean; status: number | null; error: string | null };
  positions: { ok: boolean; status: number | null; error: string | null } | null;
  classification: "OK" | "CREDENTIALS_NOT_ACCEPTED" | "NOT_CONFIGURED" | "OTHER";
};

function decodedLength(secret: string): number | null {
  try {
    return atob(secret).length;
  } catch {
    return null;
  }
}

export async function diagnosePmusAuth(): Promise<PmusAuthDiagnosis> {
  const rawKeyId = process.env["POLYMARKET_KEY_ID"] ?? "";
  const rawSecret = process.env["POLYMARKET_SECRET_KEY"] ?? "";
  const keyId = normalizeSecretValue(rawKeyId);
  const secret = normalizeSecretValue(rawSecret);
  const decoded = secret ? decodedLength(secret) : null;

  const signedRequests: PmusAuthDiagnosis["signedRequests"] = [];
  if (secret && decoded !== null && decoded >= 32) {
    for (const op of Object.values(ALLOWED_OPERATIONS)) {
      const timestamp = String(Date.now());
      const signature = await signRequest(secret, timestamp, op.method, op.path);
      signedRequests.push({
        method: op.method,
        path: op.path,
        timestampDigits: timestamp.length,
        signatureBase64Length: signature.length,
        signatureByteLength: atob(signature).length,
      });
    }
  }

  if (!keyId || !secret) {
    return {
      keyIdIsUuid: UUID_RE.test(keyId),
      secretBase64Decodes: decoded !== null,
      decodedSecretByteLength: decoded,
      normalizationApplied: keyId !== rawKeyId || secret !== rawSecret,
      signedRequests,
      balances: { ok: false, status: null, error: "Credentials are not configured." },
      positions: null,
      classification: "NOT_CONFIGURED",
    };
  }

  const balances = await getBalances();
  const positions = balances.ok ? await getPositions() : null;

  return {
    keyIdIsUuid: UUID_RE.test(keyId),
    secretBase64Decodes: decoded !== null,
    decodedSecretByteLength: decoded,
    normalizationApplied: keyId !== rawKeyId || secret !== rawSecret,
    signedRequests,
    balances: {
      ok: balances.ok,
      status: balances.ok ? 200 : balances.status,
      error: balances.ok ? null : safeErrorMessage(balances.error),
    },
    positions: positions
      ? {
          ok: positions.ok,
          status: positions.ok ? 200 : positions.status,
          error: positions.ok ? null : safeErrorMessage(positions.error),
        }
      : null,
    classification: balances.ok ? "OK" : balances.status === 401 ? "CREDENTIALS_NOT_ACCEPTED" : "OTHER",
  };
}
