# Initial Email Template rollout

This runbook prepares the Initial Email Template mode for deployment. It does not authorise a production migration, deploy, email send, or data change.

## Production entry-point map

| Entry point | Mode snapshot | Generation path | Persistence path |
| --- | --- | --- | --- |
| Automatically discovered leads | Once at daily-pipeline start | Researcher (contact discovery only in Template mode) → Writer → `routeInitialEmail` | Router creates one pending Initial Email |
| CSV, new stage, Template | Once before the import loop | `createLead` → `routeInitialEmail` immediately | Router creates one pending Initial Email |
| CSV, new stage, AI Personalised | Once before the import loop and stored per lead | Existing Writer later loads the captured mode → router | Router creates one pending Initial Email |
| Manual Add Lead | Once per request | `createLead` → router | Router creates one pending Initial Email |
| Single Generate Draft | Once per request | Router | Router creates or returns the existing pending Initial Email |
| Bulk research/generation | Once before the loop | Researcher → Writer → router | Router creates one pending Initial Email |
| Regenerate Initial Emails | Captured when confirmation opens and submitted with the batch | Router regeneration | Router updates only the selected pending Initial Email |
| Retry/recovery research | Once per request | Researcher → Writer → router | Router creates one pending Initial Email |
| Manual resend with no draft | Once after send eligibility is locked | Router `content_only` | Resend route inserts the delivered/recovery row with router provenance |
| Bulk Send with no draft | Once before the loop | Router, then reload | Bulk Send updates the router-created pending row in place |
| Existing staged import | Captured import mode | Router `content_only`, followed by legacy sequence generation | Existing historical backfill inserts sent rows; only the Initial Email receives provenance |

`/api/test-email` and developer preview scripts are intentionally outside this map because they do not create or replace production email rows.

## Deployment checklist

1. Take a database backup using the normal Supabase backup procedure and record the restore point. Confirm no migration or deploy is already running.
2. Run these read-only prechecks. Resolve any returned duplicate rows through the normal reviewed operational process before migration; migration 037 deliberately aborts rather than altering those rows or omitting its unique index.

   ```sql
   SELECT lower(btrim(name)) AS normalised_name, count(*)
   FROM categories
   GROUP BY lower(btrim(name))
   HAVING count(*) > 1;

   SELECT lead_id, count(*)
   FROM emails
   WHERE type = 'initial_pitch' AND status = 'pending_send'
   GROUP BY lead_id
   HAVING count(*) > 1;

   SELECT key, value FROM settings WHERE key = 'initial_email_mode';
   ```

3. Apply migrations in numeric order through `037_category_email_template_storage.sql`. Migration 037 is additive: it creates category-linked template storage, adds nullable `generation_source`, adds guarded settings/email constraints and indexes, seeds only missing follow-up/Reactivation template values for existing category IDs, and does not update leads or existing emails.
4. Deploy the application while `initial_email_mode` is absent or `ai_personalised`. Absence intentionally defaults to `ai_personalised`.
5. Generate one existing AI Personalised Initial Email. Confirm the normal subject/body format, `pending_send`, lead `email_ready`, and `generation_source = 'ai'`.
6. In Category Settings, add and preview an Initial Email template for every existing active category. Confirm all five sequence stages remain stored and visible. Leave incomplete categories inactive.
7. Confirm Settings reports no incomplete active categories. Do not enable Template mode while blockers remain.
8. Record a UTC timestamp immediately before the Template smoke tests, then switch Initial Email Mode to `Template`.
9. Add one manual lead in a category with a valid Initial Email template. Confirm deterministic rendered wording, `pending_send`, `email_ready`, and `generation_source = 'template'`.
10. Import one new-stage CSV lead. Confirm the same Template outcome and that the HTTP request made no AI generation request.
11. Explicitly regenerate one unsent Initial Email. Confirm its content changes only after regeneration and its `generation_source` becomes `template`.
12. Run a small automatic batch. Confirm all leads use the captured Template mode even if Settings is viewed or changed during the run.
13. Verify provenance and uniqueness with read-only queries:

    ```sql
    SELECT e.id, e.lead_id, e.type, e.status, e.generation_source, e.created_at
    FROM emails e
    WHERE e.created_at >= '<template-test-start-utc>'
    ORDER BY e.created_at;

    SELECT lead_id, count(*)
    FROM emails
    WHERE type = 'initial_pitch' AND status = 'pending_send'
    GROUP BY lead_id
    HAVING count(*) > 1;
    ```

14. Confirm zero Initial Email personalisation and Writer AI calls during the Template window. Existing contact-discovery AI may appear only for leads that lacked a valid business email after non-AI website/mailto discovery. Compare request logs against the exact test lead timestamps and IDs in application activity logs, and classify each request as either contact discovery or Initial Email personalisation/Writer activity. The latter must remain zero.

    ```sql
    SELECT workflow, provider, model, status, created_at
    FROM ai_request_logs
    WHERE created_at >= '<template-test-start-utc>'
    ORDER BY created_at;
    ```

15. Confirm sent Initial Emails, follow-ups, and Reactivation rows were untouched. Compare their counts and latest timestamps with the pre-deployment snapshot; Template smoke tests should add or regenerate only the explicitly selected unsent Initial Emails.
16. Roll back immediately if needed by switching Initial Email Mode to `AI Personalised`. This is the operational rollback; do not reverse migrations or delete template/provenance data.

## Post-check expectations

- Template mode makes zero AI personalisation and AI Writer calls.
- Existing contact-discovery processing may still run when required to obtain the business email: public website/mailto discovery runs first, followed by the established AI-assisted email finder only when needed.
- Template rendering and validation are application code and never use an AI Writer, registry, model, or provider.
- Follow-ups and Reactivation remain unlabelled by `generation_source` and retain their legacy wording and behavior.
- Sending an existing draft changes delivery fields only and preserves its existing `generation_source`.
