export interface LifecycleLead {
  id: string
  business_name: string
  email: string
  stage: string
  days_since_initial: number | null
  next_action: string
  next_action_date: string | null
  filter_key: 'fu1' | 'fu2' | 'reactivation' | 'dead' | 'none'
  is_overdue: boolean
}
