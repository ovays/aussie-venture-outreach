import type { DeliveryFailureRecord } from '@/lib/delivery-failure-report'

export function selectableLeadIds(rows: Pick<DeliveryFailureRecord, 'lead_id'>[]): string[] {
  return [...new Set(rows.flatMap((row) => row.lead_id ? [row.lead_id] : []))]
}

export function setLeadSelected(selected: Set<string>, leadId: string, checked: boolean): Set<string> {
  const next = new Set(selected)
  if (checked) next.add(leadId)
  else next.delete(leadId)
  return next
}

export function setPageSelected(
  selected: Set<string>,
  rows: Pick<DeliveryFailureRecord, 'lead_id'>[],
  checked: boolean,
): Set<string> {
  const next = new Set(selected)
  for (const leadId of selectableLeadIds(rows)) {
    if (checked) next.add(leadId)
    else next.delete(leadId)
  }
  return next
}
