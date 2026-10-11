/**
 * Best-effort `call_logs` row for a rejected request returned before dispatch.
 *
 * Admission rejections (413/503/499) and handler rejections decided before
 * dispatch (validation, key policy, guardrails, hooks) return without a trace
 * unless logged. The rejection response is returned untouched — the reason is
 * read from a `clone()` and every failure is swallowed, so logging can never
 * turn a rejection into a second failure. Fire-and-forget on purpose:
 * awaiting disk I/O here would hold the rejection path.
 */
import { saveCallLog } from "@/lib/usageDb";
import { cloneLogPayload } from "@/lib/logPayloads";
import { redactVideoTranscriptFieldsForLog } from "@/lib/guardrails/videoBridgeSnapshotRedaction";

export interface AdmissionRejectionLogEntry {
  path: string;
  model: string;
  requestBody: unknown;
  apiKeyId: string | null;
  apiKeyName: string | null;
  correlationId: string | null;
}

const FALLBACK_REASON = "unknown: admission_rejected";

export async function extractAdmissionRejectionReason(response: Response): Promise<string> {
  try {
    const rejectionBody = await response.clone().json();
    const code = rejectionBody?.error?.code;
    const message = rejectionBody?.error?.message;
    if (code || message) return `${code ?? "unknown"}: ${message ?? "admission_rejected"}`;
  } catch {}
  return FALLBACK_REASON;
}

export async function logAdmissionRejection(
  rejection: Response,
  entry: AdmissionRejectionLogEntry
): Promise<void> {
  try {
    const admissionError = await extractAdmissionRejectionReason(rejection);
    await saveCallLog({
      method: "POST",
      path: entry.path,
      status: rejection.status,
      model: entry.model,
      requestedModel: entry.model,
      provider: "-",
      duration: 0,
      error: admissionError,
      requestBody: cloneLogPayload(redactVideoTranscriptFieldsForLog(entry.requestBody)) ?? null,
      apiKeyId: entry.apiKeyId,
      apiKeyName: entry.apiKeyName,
      correlationId: entry.correlationId,
      sessionTag: null,
    });
  } catch {}
}

export function logHandlerRejection(
  rejection: Response,
  entry: AdmissionRejectionLogEntry
): Response {
  void logAdmissionRejection(rejection, entry);
  return rejection;
}

// Matches OpenAI's own `previous_response_not_found` contract (missing
// or expired server-side state) so a client with the matching retry
// behavior -- resend the full request, same turn -- recovers exactly
// as it would against the real OpenAI backend.
export function previousResponseNotFoundRejection(entry: AdmissionRejectionLogEntry): Response {
  return logHandlerRejection(
    new Response(
      JSON.stringify({
        error: {
          message: "Previous response not found.",
          type: "invalid_request_error",
          code: "previous_response_not_found",
        },
      }),
      { status: 400, headers: { "Content-Type": "application/json" } }
    ),
    entry
  );
}
