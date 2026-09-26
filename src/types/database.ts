export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  graphql_public: {
    Tables: {
      [_ in never]: never
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      graphql: {
        Args: {
          extensions?: Json
          operationName?: string
          query?: string
          variables?: Json
        }
        Returns: Json
      }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
  public: {
    Tables: {
      activity_log: {
        Row: {
          created_at: string | null
          description: string
          event_type: string
          id: string
          lead_id: string | null
          metadata: Json | null
          workspace_id: string
        }
        Insert: {
          created_at?: string | null
          description: string
          event_type: string
          id?: string
          lead_id?: string | null
          metadata?: Json | null
          workspace_id: string
        }
        Update: {
          created_at?: string | null
          description?: string
          event_type?: string
          id?: string
          lead_id?: string | null
          metadata?: Json | null
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "activity_log_lead_id_fkey"
            columns: ["lead_id"]
            isOneToOne: false
            referencedRelation: "leads"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "activity_log_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      ai_models: {
        Row: {
          created_at: string
          display_name: string
          enabled: boolean
          id: string
          model_key: string
          provider_id: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          display_name: string
          enabled?: boolean
          id?: string
          model_key: string
          provider_id: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          display_name?: string
          enabled?: boolean
          id?: string
          model_key?: string
          provider_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "ai_models_provider_id_fkey"
            columns: ["provider_id"]
            isOneToOne: false
            referencedRelation: "ai_providers"
            referencedColumns: ["id"]
          },
        ]
      }
      ai_providers: {
        Row: {
          created_at: string
          display_name: string
          enabled: boolean
          id: string
          provider_key: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          display_name: string
          enabled?: boolean
          id?: string
          provider_key: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          display_name?: string
          enabled?: boolean
          id?: string
          provider_key?: string
          updated_at?: string
        }
        Relationships: []
      }
      ai_request_logs: {
        Row: {
          created_at: string
          duration_ms: number
          error_message: string | null
          estimated_cost_usd: number | null
          finished_at: string
          id: string
          input_tokens: number | null
          metadata: Json
          model: string | null
          output_tokens: number | null
          provider: string | null
          provider_request_id: string | null
          request_source: string
          retry_count: number
          started_at: string
          status: string
          total_tokens: number | null
          workflow: string
          workflow_run_id: string | null
          workflow_step_id: string | null
          workspace_id: string
        }
        Insert: {
          created_at?: string
          duration_ms: number
          error_message?: string | null
          estimated_cost_usd?: number | null
          finished_at: string
          id?: string
          input_tokens?: number | null
          metadata?: Json
          model?: string | null
          output_tokens?: number | null
          provider?: string | null
          provider_request_id?: string | null
          request_source?: string
          retry_count?: number
          started_at: string
          status: string
          total_tokens?: number | null
          workflow: string
          workflow_run_id?: string | null
          workflow_step_id?: string | null
          workspace_id: string
        }
        Update: {
          created_at?: string
          duration_ms?: number
          error_message?: string | null
          estimated_cost_usd?: number | null
          finished_at?: string
          id?: string
          input_tokens?: number | null
          metadata?: Json
          model?: string | null
          output_tokens?: number | null
          provider?: string | null
          provider_request_id?: string | null
          request_source?: string
          retry_count?: number
          started_at?: string
          status?: string
          total_tokens?: number | null
          workflow?: string
          workflow_run_id?: string | null
          workflow_step_id?: string | null
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "ai_request_logs_workflow_run_id_fkey"
            columns: ["workflow_run_id"]
            isOneToOne: false
            referencedRelation: "workflow_runs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ai_request_logs_workflow_step_id_fkey"
            columns: ["workflow_step_id"]
            isOneToOne: false
            referencedRelation: "workflow_steps"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ai_request_logs_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      ai_workflow_configurations: {
        Row: {
          created_at: string
          enabled: boolean
          id: string
          model_id: string
          updated_at: string
          workflow_key: string
        }
        Insert: {
          created_at?: string
          enabled?: boolean
          id?: string
          model_id: string
          updated_at?: string
          workflow_key: string
        }
        Update: {
          created_at?: string
          enabled?: boolean
          id?: string
          model_id?: string
          updated_at?: string
          workflow_key?: string
        }
        Relationships: [
          {
            foreignKeyName: "ai_workflow_configurations_model_id_fkey"
            columns: ["model_id"]
            isOneToOne: false
            referencedRelation: "ai_models"
            referencedColumns: ["id"]
          },
        ]
      }
      categories: {
        Row: {
          cities: string | null
          city_content_types: Json | null
          content_type: string | null
          created_at: string | null
          custom_cities: string[] | null
          custom_policy_instructions: string | null
          dm_template: string | null
          exclude_alcohol_focused: boolean
          exclude_gambling: boolean
          exclude_pork: boolean
          exclude_religious_institutions: boolean
          exclude_shisha: boolean
          halal_filter: boolean | null
          id: string
          name: string
          pitch_template: string | null
          search_keywords: string[] | null
          status: string | null
          updated_at: string | null
          use_priority_suburbs: boolean
          workspace_id: string
        }
        Insert: {
          cities?: string | null
          city_content_types?: Json | null
          content_type?: string | null
          created_at?: string | null
          custom_cities?: string[] | null
          custom_policy_instructions?: string | null
          dm_template?: string | null
          exclude_alcohol_focused?: boolean
          exclude_gambling?: boolean
          exclude_pork?: boolean
          exclude_religious_institutions?: boolean
          exclude_shisha?: boolean
          halal_filter?: boolean | null
          id?: string
          name: string
          pitch_template?: string | null
          search_keywords?: string[] | null
          status?: string | null
          updated_at?: string | null
          use_priority_suburbs?: boolean
          workspace_id: string
        }
        Update: {
          cities?: string | null
          city_content_types?: Json | null
          content_type?: string | null
          created_at?: string | null
          custom_cities?: string[] | null
          custom_policy_instructions?: string | null
          dm_template?: string | null
          exclude_alcohol_focused?: boolean
          exclude_gambling?: boolean
          exclude_pork?: boolean
          exclude_religious_institutions?: boolean
          exclude_shisha?: boolean
          halal_filter?: boolean | null
          id?: string
          name?: string
          pitch_template?: string | null
          search_keywords?: string[] | null
          status?: string | null
          updated_at?: string | null
          use_priority_suburbs?: boolean
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "categories_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      category_email_templates: {
        Row: {
          body_template: string | null
          category_id: string
          created_at: string
          id: string
          subject_template: string | null
          template_type: string
          updated_at: string
          workspace_id: string
        }
        Insert: {
          body_template?: string | null
          category_id: string
          created_at?: string
          id?: string
          subject_template?: string | null
          template_type: string
          updated_at?: string
          workspace_id: string
        }
        Update: {
          body_template?: string | null
          category_id?: string
          created_at?: string
          id?: string
          subject_template?: string | null
          template_type?: string
          updated_at?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "category_email_templates_category_id_fkey"
            columns: ["category_id"]
            isOneToOne: false
            referencedRelation: "categories"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "category_email_templates_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      category_suburb_priorities: {
        Row: {
          category_id: string
          city_suburb_id: string
          created_at: string
          id: string
          priority: number
          updated_at: string
          workspace_id: string
        }
        Insert: {
          category_id: string
          city_suburb_id: string
          created_at?: string
          id?: string
          priority: number
          updated_at?: string
          workspace_id: string
        }
        Update: {
          category_id?: string
          city_suburb_id?: string
          created_at?: string
          id?: string
          priority?: number
          updated_at?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "category_suburb_priorities_category_id_fkey"
            columns: ["category_id"]
            isOneToOne: false
            referencedRelation: "categories"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "category_suburb_priorities_city_suburb_id_fkey"
            columns: ["city_suburb_id"]
            isOneToOne: false
            referencedRelation: "city_suburbs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "category_suburb_priorities_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      category_suburb_search_state: {
        Row: {
          category_id: string
          city_suburb_id: string
          created_at: string
          exhausted_at: string | null
          id: string
          last_searched_at: string | null
          updated_at: string
          workspace_id: string
        }
        Insert: {
          category_id: string
          city_suburb_id: string
          created_at?: string
          exhausted_at?: string | null
          id?: string
          last_searched_at?: string | null
          updated_at?: string
          workspace_id: string
        }
        Update: {
          category_id?: string
          city_suburb_id?: string
          created_at?: string
          exhausted_at?: string | null
          id?: string
          last_searched_at?: string | null
          updated_at?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "category_suburb_search_state_category_id_fkey"
            columns: ["category_id"]
            isOneToOne: false
            referencedRelation: "categories"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "category_suburb_search_state_city_suburb_id_fkey"
            columns: ["city_suburb_id"]
            isOneToOne: false
            referencedRelation: "city_suburbs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "category_suburb_search_state_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      city_suburbs: {
        Row: {
          active: boolean | null
          city: string
          created_at: string | null
          id: string
          last_used_at: string | null
          priority: number
          suburb: string
          workspace_id: string
        }
        Insert: {
          active?: boolean | null
          city: string
          created_at?: string | null
          id?: string
          last_used_at?: string | null
          priority?: number
          suburb: string
          workspace_id: string
        }
        Update: {
          active?: boolean | null
          city?: string
          created_at?: string | null
          id?: string
          last_used_at?: string | null
          priority?: number
          suburb?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "city_suburbs_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      dead_letter_queue: {
        Row: {
          created_at: string | null
          error: string | null
          id: string
          operation: string
          payload: Json
          resolved: boolean
          resolved_at: string | null
          workspace_id: string
        }
        Insert: {
          created_at?: string | null
          error?: string | null
          id?: string
          operation: string
          payload?: Json
          resolved?: boolean
          resolved_at?: string | null
          workspace_id: string
        }
        Update: {
          created_at?: string | null
          error?: string | null
          id?: string
          operation?: string
          payload?: Json
          resolved?: boolean
          resolved_at?: string | null
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "dead_letter_queue_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      deals: {
        Row: {
          closed_at: string | null
          content_created: boolean | null
          content_created_at: string | null
          created_at: string | null
          deal_type: string
          deal_value: number
          id: string
          lead_id: string | null
          notes: string | null
          payment_received: boolean | null
          payment_received_at: string | null
          workspace_id: string
        }
        Insert: {
          closed_at?: string | null
          content_created?: boolean | null
          content_created_at?: string | null
          created_at?: string | null
          deal_type: string
          deal_value: number
          id?: string
          lead_id?: string | null
          notes?: string | null
          payment_received?: boolean | null
          payment_received_at?: string | null
          workspace_id: string
        }
        Update: {
          closed_at?: string | null
          content_created?: boolean | null
          content_created_at?: string | null
          created_at?: string | null
          deal_type?: string
          deal_value?: number
          id?: string
          lead_id?: string | null
          notes?: string | null
          payment_received?: boolean | null
          payment_received_at?: string | null
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "deals_lead_id_fkey"
            columns: ["lead_id"]
            isOneToOne: false
            referencedRelation: "leads"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "deals_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      discovery_run_metrics: {
        Row: {
          businesses_processed: number
          cost_guard_hit: boolean
          db_duplicate_skips: number
          dedupe_index_skips: number
          dm_leads_queued: number
          dm_target: number
          duplicate_rate_pct: number | null
          early_duplicate_skips: number
          efficiency_pct: number | null
          email_extraction_rate_pct: number | null
          email_leads_saved: number
          email_target: number
          estimated_cost_usd: number | null
          exit_reason: string | null
          halal_confidence_recorded: number
          id: string
          invalid_emails_removed: number
          irrelevant_skips: number
          keyword_filtered_skips: number
          lowest_qualification_queries: Json | null
          no_website_skips: number
          outscraper_calls: number
          outscraper_results_fetched: number
          qualification_rate_pct: number | null
          qualified_candidates: number
          queries_executed: number
          run_at: string
          run_id: string
          runtime_ms: number | null
          safety_limit_hit: boolean
          safety_limit_reason: string | null
          social_only_skips: number
          top_yield_queries: Json | null
          total_leads_saved: number
          total_results_fetched: number
          total_target: number
          website_coverage_pct: number | null
          website_no_email_skips: number
          workspace_id: string
          worst_duplicate_queries: Json | null
          worst_suburb_overlap_queries: Json | null
        }
        Insert: {
          businesses_processed?: number
          cost_guard_hit?: boolean
          db_duplicate_skips?: number
          dedupe_index_skips?: number
          dm_leads_queued?: number
          dm_target?: number
          duplicate_rate_pct?: number | null
          early_duplicate_skips?: number
          efficiency_pct?: number | null
          email_extraction_rate_pct?: number | null
          email_leads_saved?: number
          email_target?: number
          estimated_cost_usd?: number | null
          exit_reason?: string | null
          halal_confidence_recorded?: number
          id?: string
          invalid_emails_removed?: number
          irrelevant_skips?: number
          keyword_filtered_skips?: number
          lowest_qualification_queries?: Json | null
          no_website_skips?: number
          outscraper_calls?: number
          outscraper_results_fetched?: number
          qualification_rate_pct?: number | null
          qualified_candidates?: number
          queries_executed?: number
          run_at?: string
          run_id: string
          runtime_ms?: number | null
          safety_limit_hit?: boolean
          safety_limit_reason?: string | null
          social_only_skips?: number
          top_yield_queries?: Json | null
          total_leads_saved?: number
          total_results_fetched?: number
          total_target?: number
          website_coverage_pct?: number | null
          website_no_email_skips?: number
          workspace_id: string
          worst_duplicate_queries?: Json | null
          worst_suburb_overlap_queries?: Json | null
        }
        Update: {
          businesses_processed?: number
          cost_guard_hit?: boolean
          db_duplicate_skips?: number
          dedupe_index_skips?: number
          dm_leads_queued?: number
          dm_target?: number
          duplicate_rate_pct?: number | null
          early_duplicate_skips?: number
          efficiency_pct?: number | null
          email_extraction_rate_pct?: number | null
          email_leads_saved?: number
          email_target?: number
          estimated_cost_usd?: number | null
          exit_reason?: string | null
          halal_confidence_recorded?: number
          id?: string
          invalid_emails_removed?: number
          irrelevant_skips?: number
          keyword_filtered_skips?: number
          lowest_qualification_queries?: Json | null
          no_website_skips?: number
          outscraper_calls?: number
          outscraper_results_fetched?: number
          qualification_rate_pct?: number | null
          qualified_candidates?: number
          queries_executed?: number
          run_at?: string
          run_id?: string
          runtime_ms?: number | null
          safety_limit_hit?: boolean
          safety_limit_reason?: string | null
          social_only_skips?: number
          top_yield_queries?: Json | null
          total_leads_saved?: number
          total_results_fetched?: number
          total_target?: number
          website_coverage_pct?: number | null
          website_no_email_skips?: number
          workspace_id?: string
          worst_duplicate_queries?: Json | null
          worst_suburb_overlap_queries?: Json | null
        }
        Relationships: [
          {
            foreignKeyName: "discovery_run_metrics_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      distributed_locks: {
        Row: {
          lock_key: string
          locked_at: string
          owner_token: string | null
          workspace_id: string
        }
        Insert: {
          lock_key: string
          locked_at?: string
          owner_token?: string | null
          workspace_id: string
        }
        Update: {
          lock_key?: string
          locked_at?: string
          owner_token?: string | null
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "distributed_locks_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      dm_queue: {
        Row: {
          created_at: string | null
          handle: string
          id: string
          lead_id: string | null
          message_text: string
          platform: string
          profile_url: string | null
          sent_at: string | null
          status: string | null
          workspace_id: string
        }
        Insert: {
          created_at?: string | null
          handle: string
          id?: string
          lead_id?: string | null
          message_text: string
          platform: string
          profile_url?: string | null
          sent_at?: string | null
          status?: string | null
          workspace_id: string
        }
        Update: {
          created_at?: string | null
          handle?: string
          id?: string
          lead_id?: string | null
          message_text?: string
          platform?: string
          profile_url?: string | null
          sent_at?: string | null
          status?: string | null
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "dm_queue_lead_id_fkey"
            columns: ["lead_id"]
            isOneToOne: false
            referencedRelation: "leads"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "dm_queue_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      emails: {
        Row: {
          body_html: string
          body_text: string
          claimed_at: string | null
          created_at: string | null
          edited_at: string | null
          edited_by_user: boolean | null
          generation_source: string | null
          id: string
          lead_id: string | null
          message_id: string | null
          opened_at: string | null
          replied_at: string | null
          resend_id: string | null
          send_envelope: Json
          sent_at: string | null
          status: string | null
          subject: string
          type: string
          workspace_id: string
        }
        Insert: {
          body_html: string
          body_text: string
          claimed_at?: string | null
          created_at?: string | null
          edited_at?: string | null
          edited_by_user?: boolean | null
          generation_source?: string | null
          id?: string
          lead_id?: string | null
          message_id?: string | null
          opened_at?: string | null
          replied_at?: string | null
          resend_id?: string | null
          send_envelope?: Json
          sent_at?: string | null
          status?: string | null
          subject: string
          type: string
          workspace_id: string
        }
        Update: {
          body_html?: string
          body_text?: string
          claimed_at?: string | null
          created_at?: string | null
          edited_at?: string | null
          edited_by_user?: boolean | null
          generation_source?: string | null
          id?: string
          lead_id?: string | null
          message_id?: string | null
          opened_at?: string | null
          replied_at?: string | null
          resend_id?: string | null
          send_envelope?: Json
          sent_at?: string | null
          status?: string | null
          subject?: string
          type?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "emails_lead_id_fkey"
            columns: ["lead_id"]
            isOneToOne: false
            referencedRelation: "leads"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "emails_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      exhausted_queries: {
        Row: {
          category: string
          city: string
          exhausted_at: string | null
          expires_at: string | null
          query: string
          workspace_id: string
        }
        Insert: {
          category: string
          city: string
          exhausted_at?: string | null
          expires_at?: string | null
          query: string
          workspace_id: string
        }
        Update: {
          category?: string
          city?: string
          exhausted_at?: string | null
          expires_at?: string | null
          query?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "exhausted_queries_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      follow_ups: {
        Row: {
          created_at: string | null
          email_id: string | null
          follow_up_number: number
          id: string
          lead_id: string | null
          scheduled_at: string
          sent_at: string | null
          status: string | null
          workspace_id: string
        }
        Insert: {
          created_at?: string | null
          email_id?: string | null
          follow_up_number: number
          id?: string
          lead_id?: string | null
          scheduled_at: string
          sent_at?: string | null
          status?: string | null
          workspace_id: string
        }
        Update: {
          created_at?: string | null
          email_id?: string | null
          follow_up_number?: number
          id?: string
          lead_id?: string | null
          scheduled_at?: string
          sent_at?: string | null
          status?: string | null
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "follow_ups_email_id_fkey"
            columns: ["email_id"]
            isOneToOne: false
            referencedRelation: "emails"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "follow_ups_lead_id_fkey"
            columns: ["lead_id"]
            isOneToOne: false
            referencedRelation: "leads"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "follow_ups_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      mailbox_connections: {
        Row: {
          access_token_encrypted: string | null
          capabilities: Json
          created_at: string
          created_by: string | null
          display_name: string | null
          email_address: string
          id: string
          is_default_sender: boolean
          last_connected_at: string | null
          last_error_at: string | null
          last_error_code: string | null
          last_refreshed_at: string | null
          last_sync_at: string | null
          provider: string
          provider_account_id: string | null
          refresh_token_encrypted: string | null
          scopes: string[]
          status: string
          token_expires_at: string | null
          updated_at: string
          workspace_id: string
        }
        Insert: {
          access_token_encrypted?: string | null
          capabilities?: Json
          created_at?: string
          created_by?: string | null
          display_name?: string | null
          email_address: string
          id?: string
          is_default_sender?: boolean
          last_connected_at?: string | null
          last_error_at?: string | null
          last_error_code?: string | null
          last_refreshed_at?: string | null
          last_sync_at?: string | null
          provider: string
          provider_account_id?: string | null
          refresh_token_encrypted?: string | null
          scopes?: string[]
          status?: string
          token_expires_at?: string | null
          updated_at?: string
          workspace_id: string
        }
        Update: {
          access_token_encrypted?: string | null
          capabilities?: Json
          created_at?: string
          created_by?: string | null
          display_name?: string | null
          email_address?: string
          id?: string
          is_default_sender?: boolean
          last_connected_at?: string | null
          last_error_at?: string | null
          last_error_code?: string | null
          last_refreshed_at?: string | null
          last_sync_at?: string | null
          provider?: string
          provider_account_id?: string | null
          refresh_token_encrypted?: string | null
          scopes?: string[]
          status?: string
          token_expires_at?: string | null
          updated_at?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "mailbox_connections_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "mailbox_connections_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      inbound_receipts: {
        Row: {
          attempts: number
          created_at: string
          folder: string | null
          id: string
          last_error: string | null
          mailbox_id: string | null
          outcome: string | null
          payload: Json
          processed_at: string | null
          processing_run_id: string | null
          processing_started_at: string | null
          provider: string
          provider_message_id: string | null
          receipt_key: string
          status: string
          trigger_run_id: string | null
          uid: string | null
          updated_at: string
          workspace_id: string
        }
        Insert: {
          attempts?: number
          created_at?: string
          folder?: string | null
          id?: string
          last_error?: string | null
          mailbox_id?: string | null
          outcome?: string | null
          payload?: Json
          processed_at?: string | null
          processing_run_id?: string | null
          processing_started_at?: string | null
          provider: string
          provider_message_id?: string | null
          receipt_key: string
          status?: string
          trigger_run_id?: string | null
          uid?: string | null
          updated_at?: string
          workspace_id: string
        }
        Update: {
          attempts?: number
          created_at?: string
          folder?: string | null
          id?: string
          last_error?: string | null
          mailbox_id?: string | null
          outcome?: string | null
          payload?: Json
          processed_at?: string | null
          processing_run_id?: string | null
          processing_started_at?: string | null
          provider?: string
          provider_message_id?: string | null
          receipt_key?: string
          status?: string
          trigger_run_id?: string | null
          uid?: string | null
          updated_at?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "inbound_receipts_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      lead_data_quality_flags: {
        Row: {
          created_at: string
          id: string
          issue_type: string
          lead_id: string
          metadata: Json
          normalized_email: string | null
          reason: string
          related_lead_ids: string[]
          resolution_reason: string | null
          resolved_at: string | null
          resolved_by: string | null
          status: string
          updated_at: string
          workspace_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          issue_type: string
          lead_id: string
          metadata?: Json
          normalized_email?: string | null
          reason: string
          related_lead_ids?: string[]
          resolution_reason?: string | null
          resolved_at?: string | null
          resolved_by?: string | null
          status?: string
          updated_at?: string
          workspace_id: string
        }
        Update: {
          created_at?: string
          id?: string
          issue_type?: string
          lead_id?: string
          metadata?: Json
          normalized_email?: string | null
          reason?: string
          related_lead_ids?: string[]
          resolution_reason?: string | null
          resolved_at?: string | null
          resolved_by?: string | null
          status?: string
          updated_at?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "lead_data_quality_flags_lead_id_fkey"
            columns: ["lead_id"]
            isOneToOne: false
            referencedRelation: "leads"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "lead_data_quality_flags_resolved_by_fkey"
            columns: ["resolved_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "lead_data_quality_flags_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      leads: {
        Row: {
          address: string | null
          business_name: string
          category_id: string | null
          category_name: string
          category_policy_facts: Json
          city: string
          content_created: boolean | null
          content_type: string | null
          created_at: string | null
          deal_type: string | null
          deal_value: number | null
          delivery_suppressed_emails: string[]
          description: string | null
          email: string | null
          facebook_url: string | null
          google_rating: number | null
          google_reviews_count: number | null
          halal: boolean | null
          halal_confidence_score: number | null
          halal_reasons: Json | null
          id: string
          instagram_handle: string | null
          normalized_email: string | null
          notes: string | null
          outreach_channel: string | null
          outreach_suppressed_at: string | null
          outreach_suppression_reason: string | null
          payment_received: boolean | null
          phone: string | null
          reactivation_sent_at: string | null
          services: string | null
          source: string | null
          state: string | null
          status: string | null
          suburb: string | null
          updated_at: string | null
          website: string | null
          workspace_id: string
        }
        Insert: {
          address?: string | null
          business_name: string
          category_id?: string | null
          category_name: string
          category_policy_facts?: Json
          city: string
          content_created?: boolean | null
          content_type?: string | null
          created_at?: string | null
          deal_type?: string | null
          deal_value?: number | null
          delivery_suppressed_emails?: string[]
          description?: string | null
          email?: string | null
          facebook_url?: string | null
          google_rating?: number | null
          google_reviews_count?: number | null
          halal?: boolean | null
          halal_confidence_score?: number | null
          halal_reasons?: Json | null
          id?: string
          instagram_handle?: string | null
          normalized_email?: string | null
          notes?: string | null
          outreach_channel?: string | null
          outreach_suppressed_at?: string | null
          outreach_suppression_reason?: string | null
          payment_received?: boolean | null
          phone?: string | null
          reactivation_sent_at?: string | null
          services?: string | null
          source?: string | null
          state?: string | null
          status?: string | null
          suburb?: string | null
          updated_at?: string | null
          website?: string | null
          workspace_id: string
        }
        Update: {
          address?: string | null
          business_name?: string
          category_id?: string | null
          category_name?: string
          category_policy_facts?: Json
          city?: string
          content_created?: boolean | null
          content_type?: string | null
          created_at?: string | null
          deal_type?: string | null
          deal_value?: number | null
          delivery_suppressed_emails?: string[]
          description?: string | null
          email?: string | null
          facebook_url?: string | null
          google_rating?: number | null
          google_reviews_count?: number | null
          halal?: boolean | null
          halal_confidence_score?: number | null
          halal_reasons?: Json | null
          id?: string
          instagram_handle?: string | null
          normalized_email?: string | null
          notes?: string | null
          outreach_channel?: string | null
          outreach_suppressed_at?: string | null
          outreach_suppression_reason?: string | null
          payment_received?: boolean | null
          phone?: string | null
          reactivation_sent_at?: string | null
          services?: string | null
          source?: string | null
          state?: string | null
          status?: string | null
          suburb?: string | null
          updated_at?: string | null
          website?: string | null
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "leads_category_id_fkey"
            columns: ["category_id"]
            isOneToOne: false
            referencedRelation: "categories"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "leads_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "leads_workspace_category_fkey"
            columns: ["workspace_id", "category_id"]
            isOneToOne: false
            referencedRelation: "categories"
            referencedColumns: ["workspace_id", "id"]
          },
        ]
      }
      profiles: {
        Row: {
          created_at: string
          email: string
          full_name: string | null
          id: string
          is_active: boolean
          role: string
        }
        Insert: {
          created_at?: string
          email: string
          full_name?: string | null
          id: string
          is_active?: boolean
          role?: string
        }
        Update: {
          created_at?: string
          email?: string
          full_name?: string | null
          id?: string
          is_active?: boolean
          role?: string
        }
        Relationships: []
      }
      recipient_outreach_ownership: {
        Row: {
          claimed_at: string
          last_activity_at: string
          metadata: Json
          normalized_email: string
          owner_lead_id: string | null
          state: string
          workspace_id: string
        }
        Insert: {
          claimed_at?: string
          last_activity_at?: string
          metadata?: Json
          normalized_email: string
          owner_lead_id?: string | null
          state?: string
          workspace_id: string
        }
        Update: {
          claimed_at?: string
          last_activity_at?: string
          metadata?: Json
          normalized_email?: string
          owner_lead_id?: string | null
          state?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "recipient_outreach_ownership_owner_lead_id_fkey"
            columns: ["owner_lead_id"]
            isOneToOne: false
            referencedRelation: "leads"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "recipient_outreach_ownership_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      search_cache: {
        Row: {
          api_used: string
          created_at: string | null
          expires_at: string | null
          id: string
          query: string
          results: Json
          workspace_id: string
        }
        Insert: {
          api_used: string
          created_at?: string | null
          expires_at?: string | null
          id?: string
          query: string
          results: Json
          workspace_id: string
        }
        Update: {
          api_used?: string
          created_at?: string | null
          expires_at?: string | null
          id?: string
          query?: string
          results?: Json
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "search_cache_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      settings: {
        Row: {
          description: string | null
          id: string
          key: string
          updated_at: string | null
          value: string
        }
        Insert: {
          description?: string | null
          id?: string
          key: string
          updated_at?: string | null
          value: string
        }
        Update: {
          description?: string | null
          id?: string
          key?: string
          updated_at?: string | null
          value?: string
        }
        Relationships: []
      }
      workflow_runs: {
        Row: {
          attempt: number
          category_id: string | null
          completed_at: string | null
          correlation_id: string | null
          created_at: string
          decision_action: string | null
          decision_reason_code: string | null
          duration_ms: number | null
          error_category: string | null
          error_code: string | null
          error_message: string | null
          id: string
          idempotency_key: string | null
          lead_id: string | null
          metadata: Json
          parent_run_id: string | null
          source: string
          started_at: string | null
          status: string
          trigger_run_id: string | null
          trigger_task_id: string | null
          updated_at: string
          workflow_type: string
          workspace_id: string
        }
        Insert: {
          attempt?: number
          category_id?: string | null
          completed_at?: string | null
          correlation_id?: string | null
          created_at?: string
          decision_action?: string | null
          decision_reason_code?: string | null
          duration_ms?: number | null
          error_category?: string | null
          error_code?: string | null
          error_message?: string | null
          id?: string
          idempotency_key?: string | null
          lead_id?: string | null
          metadata?: Json
          parent_run_id?: string | null
          source: string
          started_at?: string | null
          status?: string
          trigger_run_id?: string | null
          trigger_task_id?: string | null
          updated_at?: string
          workflow_type: string
          workspace_id: string
        }
        Update: {
          attempt?: number
          category_id?: string | null
          completed_at?: string | null
          correlation_id?: string | null
          created_at?: string
          decision_action?: string | null
          decision_reason_code?: string | null
          duration_ms?: number | null
          error_category?: string | null
          error_code?: string | null
          error_message?: string | null
          id?: string
          idempotency_key?: string | null
          lead_id?: string | null
          metadata?: Json
          parent_run_id?: string | null
          source?: string
          started_at?: string | null
          status?: string
          trigger_run_id?: string | null
          trigger_task_id?: string | null
          updated_at?: string
          workflow_type?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "workflow_runs_category_id_fkey"
            columns: ["category_id"]
            isOneToOne: false
            referencedRelation: "categories"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "workflow_runs_lead_id_fkey"
            columns: ["lead_id"]
            isOneToOne: false
            referencedRelation: "leads"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "workflow_runs_parent_run_id_fkey"
            columns: ["parent_run_id"]
            isOneToOne: false
            referencedRelation: "workflow_runs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "workflow_runs_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      workflow_steps: {
        Row: {
          attempt: number
          completed_at: string | null
          created_at: string
          decision_action: string | null
          decision_reason_code: string | null
          duration_ms: number | null
          error_category: string | null
          error_code: string | null
          error_message: string | null
          estimated_cost_usd: number | null
          external_message_id: string | null
          external_request_id: string | null
          id: string
          input_summary: Json
          input_tokens: number | null
          lead_id: string | null
          metadata: Json
          model: string | null
          output_summary: Json
          output_tokens: number | null
          provider: string | null
          response_status: string | null
          retry_count: number
          retryable: boolean | null
          sequence: number
          started_at: string | null
          status: string
          step_name: string
          step_type: string
          total_tokens: number | null
          updated_at: string
          workflow_run_id: string
          workspace_id: string
        }
        Insert: {
          attempt?: number
          completed_at?: string | null
          created_at?: string
          decision_action?: string | null
          decision_reason_code?: string | null
          duration_ms?: number | null
          error_category?: string | null
          error_code?: string | null
          error_message?: string | null
          estimated_cost_usd?: number | null
          external_message_id?: string | null
          external_request_id?: string | null
          id?: string
          input_summary?: Json
          input_tokens?: number | null
          lead_id?: string | null
          metadata?: Json
          model?: string | null
          output_summary?: Json
          output_tokens?: number | null
          provider?: string | null
          response_status?: string | null
          retry_count?: number
          retryable?: boolean | null
          sequence?: number
          started_at?: string | null
          status?: string
          step_name: string
          step_type: string
          total_tokens?: number | null
          updated_at?: string
          workflow_run_id: string
          workspace_id: string
        }
        Update: {
          attempt?: number
          completed_at?: string | null
          created_at?: string
          decision_action?: string | null
          decision_reason_code?: string | null
          duration_ms?: number | null
          error_category?: string | null
          error_code?: string | null
          error_message?: string | null
          estimated_cost_usd?: number | null
          external_message_id?: string | null
          external_request_id?: string | null
          id?: string
          input_summary?: Json
          input_tokens?: number | null
          lead_id?: string | null
          metadata?: Json
          model?: string | null
          output_summary?: Json
          output_tokens?: number | null
          provider?: string | null
          response_status?: string | null
          retry_count?: number
          retryable?: boolean | null
          sequence?: number
          started_at?: string | null
          status?: string
          step_name?: string
          step_type?: string
          total_tokens?: number | null
          updated_at?: string
          workflow_run_id?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "workflow_steps_lead_id_fkey"
            columns: ["lead_id"]
            isOneToOne: false
            referencedRelation: "leads"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "workflow_steps_workflow_run_id_fkey"
            columns: ["workflow_run_id"]
            isOneToOne: false
            referencedRelation: "workflow_runs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "workflow_steps_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      workspace_members: {
        Row: {
          created_at: string
          role: string
          status: string
          updated_at: string
          user_id: string
          workspace_id: string
        }
        Insert: {
          created_at?: string
          role?: string
          status?: string
          updated_at?: string
          user_id: string
          workspace_id: string
        }
        Update: {
          created_at?: string
          role?: string
          status?: string
          updated_at?: string
          user_id?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "workspace_members_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "workspace_members_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      workspace_settings: {
        Row: {
          description: string | null
          key: string
          updated_at: string
          value: string
          workspace_id: string
        }
        Insert: {
          description?: string | null
          key: string
          updated_at?: string
          value: string
          workspace_id: string
        }
        Update: {
          description?: string | null
          key?: string
          updated_at?: string
          value?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "workspace_settings_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      workspaces: {
        Row: {
          created_at: string
          id: string
          name: string
          plan: string
          slug: string
          status: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          id?: string
          name: string
          plan?: string
          slug: string
          status?: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          id?: string
          name?: string
          plan?: string
          slug?: string
          status?: string
          updated_at?: string
        }
        Relationships: []
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      admin_ai_usage_summary: {
        Args: { p_from: string; p_to: string }
        Returns: {
          estimated_cost_usd: number
          input_tokens: number
          model: string
          output_tokens: number
          provider: string
          request_count: number
          total_tokens: number
        }[]
      }
      admin_decision_distribution: {
        Args: { p_from: string; p_to: string }
        Returns: {
          action: string
          occurrence_count: number
          reason_code: string
        }[]
      }
      admin_provider_failure_summary: {
        Args: { p_from: string; p_to: string }
        Returns: {
          error_category: string
          error_code: string
          failure_count: number
          provider: string
        }[]
      }
      admin_workflow_run_detail: { Args: { p_run_id: string }; Returns: Json }
      admin_workflow_runs: {
        Args: {
          p_from?: string
          p_lead_id?: string
          p_limit?: number
          p_status?: string
          p_to?: string
          p_workflow_type?: string
        }
        Returns: {
          attempt: number
          category_id: string | null
          completed_at: string | null
          correlation_id: string | null
          created_at: string
          decision_action: string | null
          decision_reason_code: string | null
          duration_ms: number | null
          error_category: string | null
          error_code: string | null
          error_message: string | null
          id: string
          idempotency_key: string | null
          lead_id: string | null
          metadata: Json
          parent_run_id: string | null
          source: string
          started_at: string | null
          status: string
          trigger_run_id: string | null
          trigger_task_id: string | null
          updated_at: string
          workflow_type: string
          workspace_id: string
        }[]
        SetofOptions: {
          from: "*"
          to: "workflow_runs"
          isOneToOne: false
          isSetofReturn: true
        }
      }
      claim_hostinger_inbound_receipt: {
        Args: {
          p_receipt_id: string
          p_run_id: string
          p_stale_before: string
          p_workspace_id: string
        }
        Returns: {
          attempt_count: number
          receipt_id: string
        }[]
      }
      claim_recipient_outreach: {
        Args: { p_lead_id: string; p_phase: string; p_workspace_id: string }
        Returns: Json
      }
      classify_data_quality_group: { Args: { p_leads: Json }; Returns: Json }
      classify_email_quality: {
        Args: { p_email: string }
        Returns: {
          issue_type: string
          reason: string
        }[]
      }
      data_quality_compact_identity: {
        Args: { p_value: string }
        Returns: string
      }
      data_quality_meaningful_website_identity: {
        Args: { p_value: string }
        Returns: string
      }
      data_quality_phone_identity: {
        Args: { p_value: string }
        Returns: string
      }
      data_quality_present: { Args: { p_value: string }; Returns: string }
      data_quality_social_identity: {
        Args: { p_value: string }
        Returns: string
      }
      data_quality_website_identity: {
        Args: { p_value: string }
        Returns: string
      }
      finder_email_root_domain: { Args: { p_email: string }; Returns: string }
      finder_website_domain: { Args: { p_website: string }; Returns: string }
      get_ai_request_analytics: {
        Args: {
          p_end_at?: string
          p_provider?: string
          p_recent_limit?: number
          p_start_at?: string
          p_status?: string
          p_workflow?: string
        }
        Returns: Json
      }
      get_dashboard_summary: {
        Args: { p_as_of?: string; p_workspace_id?: string }
        Returns: Json
      }
      get_data_quality_report: {
        Args: {
          p_business?: string
          p_category?: string
          p_city?: string
          p_email?: string
          p_issue_type?: string
          p_page?: number
          p_page_size?: number
        }
        Returns: Json
      }
      get_data_quality_report_v2: {
        Args: {
          p_business?: string
          p_category?: string
          p_city?: string
          p_email?: string
          p_issue_type?: string
          p_page?: number
          p_page_size?: number
          p_search?: string
        }
        Returns: Json
      }
      get_data_quality_summary: { Args: never; Returns: Json }
      get_deals_search_page: {
        Args: { p_page?: number; p_page_size?: number; p_search?: string }
        Returns: Json
      }
      get_delivery_failure_lead_selection: {
        Args: {
          p_email_type?: string
          p_include_ids?: boolean
          p_search?: string
          p_status?: string
        }
        Returns: Json
      }
      get_delivery_failure_report: {
        Args: {
          p_email_type?: string
          p_page?: number
          p_page_size?: number
          p_search?: string
          p_status?: string
        }
        Returns: Json
      }
      get_dm_queue_search_page: {
        Args: {
          p_city?: string
          p_page?: number
          p_page_size?: number
          p_platform?: string
          p_search?: string
          p_status?: string
        }
        Returns: Json
      }
      get_email_log_search_page: {
        Args: {
          p_page?: number
          p_page_size?: number
          p_search?: string
          p_status?: string
          p_type?: string
        }
        Returns: Json
      }
      get_email_log_summary: {
        Args: { p_search?: string; p_status?: string; p_type?: string }
        Returns: Json
      }
      get_email_report_leads: {
        Args: { p_addresses: string[]; p_domains: string[] }
        Returns: {
          business_name: string
          email: string
          id: string
          status: string
        }[]
      }
      get_health_summary: { Args: { p_as_of?: string }; Returns: Json }
      get_lead_status_counts: {
        Args: never
        Returns: {
          count: number
          status: string
        }[]
      }
      get_leads_search_page: {
        Args: {
          p_category?: string
          p_city?: string
          p_ids_only?: boolean
          p_page?: number
          p_page_size?: number
          p_search?: string
          p_statuses?: string[]
        }
        Returns: Json
      }
      get_lifecycle_page: {
        Args: {
          p_as_of?: string
          p_filter?: string
          p_page?: number
          p_page_size?: number
          p_search?: string
          p_sort_dir?: string
          p_sort_key?: string
        }
        Returns: Json
      }
      get_pipeline_search_page: {
        Args: {
          p_page?: number
          p_page_size?: number
          p_search?: string
          p_statuses: string[]
        }
        Returns: Json
      }
      insert_finder_lead_if_new:
        | { Args: { p_lead: Json }; Returns: Json }
        | { Args: { p_lead: Json; p_workspace_id: string }; Returns: Json }
      is_active_admin: { Args: never; Returns: boolean }
      is_platform_admin: { Args: never; Returns: boolean }
      is_workspace_member: {
        Args: { p_min_role?: string; p_workspace_id: string }
        Returns: boolean
      }
      literal_ilike_pattern: { Args: { p_search: string }; Returns: string }
      lookup_finder_candidates: {
        Args: { p_candidates: Json; p_workspace_id: string }
        Returns: {
          candidate_index: number
          match_type: string
          matched_business_name: string
          matched_email: string
          matched_id: string
          matched_status: string
          matched_suppression_reason: string
        }[]
      }
      refresh_email_group_quality: {
        Args: { p_email: string; p_workspace_id: string }
        Returns: undefined
      }
      refresh_lead_data_quality: {
        Args: { p_lead_id: string; p_workspace_id: string }
        Returns: undefined
      }
      release_recipient_outreach_claim: {
        Args: {
          p_claim_token: string
          p_lead_id: string
          p_normalized_email: string
          p_workspace_id: string
        }
        Returns: boolean
      }
      remove_data_quality_emails: {
        Args: { p_lead_ids: string[]; p_workspace_id: string }
        Returns: Json
      }
      set_data_quality_flag_status: {
        Args: {
          p_issue_type: string
          p_lead_ids?: string[]
          p_normalized_email?: string
          p_resolution_reason?: string
          p_status?: string
          p_workspace_id: string
        }
        Returns: Json
      }
      suppress_lead_delivery_email: {
        Args: { p_email: string; p_lead_id: string; p_workspace_id: string }
        Returns: undefined
      }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  graphql_public: {
    Enums: {},
  },
  public: {
    Enums: {},
  },
} as const
