# Hostinger webhook fixtures

`hostinger-webhook-payloads.json` keeps the route-level cases used by
`test:hostinger-webhook` in one place.

The real-event fixture follows Hostinger's current public delivery example:
top-level `event`, a mailbox address string in `mailbox`, and a nested `message`
with string `from`, `subject`, and `thread_id`. Hostinger's webhook guide also
states that deliveries contain a timestamp, which the fixture includes so the
event has a stable per-message receipt key when UID and Message-ID are omitted.

Sources checked 2026-09-02:

- https://www.hostinger.com/au/mail-api
- https://www.hostinger.com/support/how-to-use-agentic-mail-in-hostinger/
- https://raw.githubusercontent.com/hostinger/mail-api/main/openapi.json

The OpenAPI document is the API source of truth for webhook management and
Bearer-secret behavior, but it does not currently publish a webhook delivery
body schema. The explicit `test: true` marker is therefore a conservative local
representation: only explicitly marked test requests receive the special test
acknowledgement.
