export interface V1DataCompatibilityCheck {
  fact: string
  source: string
  disposition: 'SUPPORTED' | 'SUPPORTED_WITH_MANUAL_REVIEW'
  note: string
}

/** Static schema-contract report only. Prompt 13 never queries V1 production. */
export const V1_DATA_COMPATIBILITY_REPORT: readonly V1DataCompatibilityCheck[] = [
  { fact: 'lead statuses', source: 'leads.status', disposition: 'SUPPORTED', note: 'All ten canonical V1 statuses are accepted; unknown values fail the individual evaluation.' },
  { fact: 'nullable category', source: 'leads.category_id/category_name', disposition: 'SUPPORTED_WITH_MANUAL_REVIEW', note: 'No backfill or NOT NULL constraint; template comparisons without a known category stop for manual review.' },
  { fact: 'email stages', source: 'emails.type/status/sent_at/replied_at', disposition: 'SUPPORTED', note: 'Pending, sent, uncertain-sync, and missing stages are derived from bounded rows.' },
  { fact: 'follow-up stages', source: 'emails follow_up_1/2/3', disposition: 'SUPPORTED', note: 'Sequential sent state and due timing are derived without executing follow-up code.' },
  { fact: 'reactivation', source: 'leads.reactivation_sent_at and settings', disposition: 'SUPPORTED', note: 'Sent timestamp, enabled flag, delay, and dead-after delay are available.' },
  { fact: 'suppression', source: 'lead suppression fields', disposition: 'SUPPORTED', note: 'Address list and lead-level suppression facts are loaded read-only.' },
  { fact: 'recipient ownership', source: 'recipient_outreach_ownership', disposition: 'SUPPORTED', note: 'Bounded ownership rows identify another owner without claiming a recipient.' },
  { fact: 'duplicates', source: 'open lead_data_quality_flags', disposition: 'SUPPORTED', note: 'Open duplicate_lead flags produce STOP without consolidation or mutation.' },
  { fact: 'mode snapshots', source: 'activity_log initial_email_mode_snapshot', disposition: 'SUPPORTED', note: 'Latest bounded per-lead snapshot wins over the current setting.' },
  { fact: 'category templates', source: 'category_email_templates', disposition: 'SUPPORTED_WITH_MANUAL_REVIEW', note: 'Known category templates are checked; missing/invalid templates require review.' },
  { fact: 'settings', source: 'settings', disposition: 'SUPPORTED', note: 'Only the eight Decision Context keys are read.' },
  { fact: 'manual cases', source: 'leads.source/status', disposition: 'SUPPORTED_WITH_MANUAL_REVIEW', note: 'Manual source and closed_manual are deterministic stops; no automatic override is inferred.' },
  { fact: 'reply classifications', source: 'reply/status projection', disposition: 'SUPPORTED_WITH_MANUAL_REVIEW', note: 'Existing received replies hand off safely; detailed future Reply Agent classification is not inferred from message bodies.' },
] as const
