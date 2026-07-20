import { Webhook, WebhookVerificationError } from 'svix'
import type { WebhookEventPayload } from 'resend'

// Resend delivers webhooks signed via Svix (https://resend.com/docs/dashboard/webhooks/verify-webhooks-requests).
// Verification requires all three svix-id/svix-timestamp/svix-signature
// headers, HMAC-SHA256 over "{svix-id}.{svix-timestamp}.{body}" with the
// base64-decoded secret, and a base64 (not hex) signature comparison against
// one of the space-separated "v1,<sig>" values in svix-signature. The `svix`
// package (a thin wrapper Resend's own SDK depends on) implements this
// correctly — do not hand-roll this check again.
//
// Pulled out of the route module (rather than exported alongside POST) so it
// stays a plain testable function — Next.js route files may only export HTTP
// method handlers and route config.
export function verifyResendWebhook(
  body: string,
  headers: { get(name: string): string | null },
  secret: string | undefined
): WebhookEventPayload {
  if (!secret) {
    throw new WebhookVerificationError('RESEND_WEBHOOK_SECRET is not set')
  }

  const wh = new Webhook(secret)
  return wh.verify(body, {
    'svix-id':        headers.get('svix-id') ?? '',
    'svix-timestamp': headers.get('svix-timestamp') ?? '',
    'svix-signature': headers.get('svix-signature') ?? '',
  }) as WebhookEventPayload
}
