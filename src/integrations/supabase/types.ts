export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.15"
  }
  public: {
    Tables: {
      alerts: {
        Row: {
          acknowledged: boolean
          context: Json | null
          created_at: string
          dedup_key: string | null
          id: string
          kind: string
          level: string
          message: string
          notification_attempted_at: string | null
          notification_error: string | null
          notification_status: string
          notified_at: string | null
        }
        Insert: {
          acknowledged?: boolean
          context?: Json | null
          created_at?: string
          dedup_key?: string | null
          id?: string
          kind: string
          level?: string
          message: string
          notification_attempted_at?: string | null
          notification_error?: string | null
          notification_status?: string
          notified_at?: string | null
        }
        Update: {
          acknowledged?: boolean
          context?: Json | null
          created_at?: string
          dedup_key?: string | null
          id?: string
          kind?: string
          level?: string
          message?: string
          notification_attempted_at?: string | null
          notification_error?: string | null
          notification_status?: string
          notified_at?: string | null
        }
        Relationships: []
      }
      candidate_fingerprint: {
        Row: {
          bot_label: string
          bot_likelihood: number | null
          candidate_id: string
          computed_at: string
          fingerprint: Json
          id: string
        }
        Insert: {
          bot_label?: string
          bot_likelihood?: number | null
          candidate_id: string
          computed_at?: string
          fingerprint?: Json
          id?: string
        }
        Update: {
          bot_label?: string
          bot_likelihood?: number | null
          candidate_id?: string
          computed_at?: string
          fingerprint?: Json
          id?: string
        }
        Relationships: [
          {
            foreignKeyName: "candidate_fingerprint_candidate_id_fkey"
            columns: ["candidate_id"]
            isOneToOne: false
            referencedRelation: "candidate_watchlist"
            referencedColumns: ["id"]
          },
        ]
      }
      candidate_metrics: {
        Row: {
          candidate_id: string
          completeness: number | null
          computed_at: string
          coverage_end: string | null
          coverage_start: string | null
          id: string
          metrics: Json
          sample_count: number
        }
        Insert: {
          candidate_id: string
          completeness?: number | null
          computed_at?: string
          coverage_end?: string | null
          coverage_start?: string | null
          id?: string
          metrics?: Json
          sample_count?: number
        }
        Update: {
          candidate_id?: string
          completeness?: number | null
          computed_at?: string
          coverage_end?: string | null
          coverage_start?: string | null
          id?: string
          metrics?: Json
          sample_count?: number
        }
        Relationships: [
          {
            foreignKeyName: "candidate_metrics_candidate_id_fkey"
            columns: ["candidate_id"]
            isOneToOne: false
            referencedRelation: "candidate_watchlist"
            referencedColumns: ["id"]
          },
        ]
      }
      candidate_scores: {
        Row: {
          candidate_id: string
          capacity: number | null
          completeness: Json
          computed_at: string
          consistency: number | null
          copyability: number | null
          final_score: number | null
          id: string
          mirror_similarity: number | null
          profit_quality: number | null
          risks: Json
          score_status: string
          strengths: Json
        }
        Insert: {
          candidate_id: string
          capacity?: number | null
          completeness?: Json
          computed_at?: string
          consistency?: number | null
          copyability?: number | null
          final_score?: number | null
          id?: string
          mirror_similarity?: number | null
          profit_quality?: number | null
          risks?: Json
          score_status?: string
          strengths?: Json
        }
        Update: {
          candidate_id?: string
          capacity?: number | null
          completeness?: Json
          computed_at?: string
          consistency?: number | null
          copyability?: number | null
          final_score?: number | null
          id?: string
          mirror_similarity?: number | null
          profit_quality?: number | null
          risks?: Json
          score_status?: string
          strengths?: Json
        }
        Relationships: [
          {
            foreignKeyName: "candidate_scores_candidate_id_fkey"
            columns: ["candidate_id"]
            isOneToOne: false
            referencedRelation: "candidate_watchlist"
            referencedColumns: ["id"]
          },
        ]
      }
      candidate_watchlist: {
        Row: {
          added_at: string
          handle: string
          id: string
          notes: string | null
          promoted_experiment_id: string | null
          source: string
          status: string
          updated_at: string
          wallet: string | null
          wallet_resolved: boolean
          weekly_snapshot_pnl: number | null
          weekly_snapshot_rank: number | null
        }
        Insert: {
          added_at?: string
          handle: string
          id?: string
          notes?: string | null
          promoted_experiment_id?: string | null
          source?: string
          status?: string
          updated_at?: string
          wallet?: string | null
          wallet_resolved?: boolean
          weekly_snapshot_pnl?: number | null
          weekly_snapshot_rank?: number | null
        }
        Update: {
          added_at?: string
          handle?: string
          id?: string
          notes?: string | null
          promoted_experiment_id?: string | null
          source?: string
          status?: string
          updated_at?: string
          wallet?: string | null
          wallet_resolved?: boolean
          weekly_snapshot_pnl?: number | null
          weekly_snapshot_rank?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "candidate_watchlist_promoted_experiment_id_fkey"
            columns: ["promoted_experiment_id"]
            isOneToOne: false
            referencedRelation: "paper_experiments"
            referencedColumns: ["id"]
          },
        ]
      }
      compatibility_checks: {
        Row: {
          checked_at: string
          checks: number
          compatibility_status: string
          created_at: string
          event_key: string
          id: string
          matched_us_market: string | null
          reason: string | null
          source_event_id: string | null
          source_market: string | null
          source_slug: string | null
          wallet: string
        }
        Insert: {
          checked_at?: string
          checks?: number
          compatibility_status?: string
          created_at?: string
          event_key: string
          id?: string
          matched_us_market?: string | null
          reason?: string | null
          source_event_id?: string | null
          source_market?: string | null
          source_slug?: string | null
          wallet?: string
        }
        Update: {
          checked_at?: string
          checks?: number
          compatibility_status?: string
          created_at?: string
          event_key?: string
          id?: string
          matched_us_market?: string | null
          reason?: string | null
          source_event_id?: string | null
          source_market?: string | null
          source_slug?: string | null
          wallet?: string
        }
        Relationships: [
          {
            foreignKeyName: "compatibility_checks_source_event_id_fkey"
            columns: ["source_event_id"]
            isOneToOne: false
            referencedRelation: "source_events"
            referencedColumns: ["id"]
          },
        ]
      }
      copyability_observations: {
        Row: {
          asset: string
          best_ask: number | null
          best_bid: number | null
          created_at: string
          delay_seconds: number
          detected_at: string | null
          event_key: string
          experiment_id: string
          fillable: boolean | null
          follower_price: number | null
          id: string
          improved: boolean | null
          leader_price: number | null
          market_title: string | null
          midpoint: number | null
          observed_at: string | null
          price_direction: string | null
          required_shares: number | null
          sample_delay: string
          scheduled_at: string
          side: string
          slippage_cents: number | null
          slippage_pct: number | null
          source_event_id: string | null
          source_ts: number | null
          spread: number | null
          status: string
          visible_depth: number | null
        }
        Insert: {
          asset: string
          best_ask?: number | null
          best_bid?: number | null
          created_at?: string
          delay_seconds: number
          detected_at?: string | null
          event_key: string
          experiment_id: string
          fillable?: boolean | null
          follower_price?: number | null
          id?: string
          improved?: boolean | null
          leader_price?: number | null
          market_title?: string | null
          midpoint?: number | null
          observed_at?: string | null
          price_direction?: string | null
          required_shares?: number | null
          sample_delay: string
          scheduled_at: string
          side: string
          slippage_cents?: number | null
          slippage_pct?: number | null
          source_event_id?: string | null
          source_ts?: number | null
          spread?: number | null
          status?: string
          visible_depth?: number | null
        }
        Update: {
          asset?: string
          best_ask?: number | null
          best_bid?: number | null
          created_at?: string
          delay_seconds?: number
          detected_at?: string | null
          event_key?: string
          experiment_id?: string
          fillable?: boolean | null
          follower_price?: number | null
          id?: string
          improved?: boolean | null
          leader_price?: number | null
          market_title?: string | null
          midpoint?: number | null
          observed_at?: string | null
          price_direction?: string | null
          required_shares?: number | null
          sample_delay?: string
          scheduled_at?: string
          side?: string
          slippage_cents?: number | null
          slippage_pct?: number | null
          source_event_id?: string | null
          source_ts?: number | null
          spread?: number | null
          status?: string
          visible_depth?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "copyability_observations_experiment_id_fkey"
            columns: ["experiment_id"]
            isOneToOne: false
            referencedRelation: "paper_experiments"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "copyability_observations_source_event_id_fkey"
            columns: ["source_event_id"]
            isOneToOne: false
            referencedRelation: "source_events"
            referencedColumns: ["id"]
          },
        ]
      }
      experiment_event_state: {
        Row: {
          backfilled: boolean
          event_key: string
          experiment_id: string
          legacy_seeded: boolean
          processed_at: string
          source_event_id: string
        }
        Insert: {
          backfilled?: boolean
          event_key: string
          experiment_id: string
          legacy_seeded?: boolean
          processed_at?: string
          source_event_id: string
        }
        Update: {
          backfilled?: boolean
          event_key?: string
          experiment_id?: string
          legacy_seeded?: boolean
          processed_at?: string
          source_event_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "experiment_event_state_experiment_id_fkey"
            columns: ["experiment_id"]
            isOneToOne: false
            referencedRelation: "paper_experiments"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "experiment_event_state_source_event_id_fkey"
            columns: ["source_event_id"]
            isOneToOne: false
            referencedRelation: "source_events"
            referencedColumns: ["id"]
          },
        ]
      }
      experiment_source_position_state: {
        Row: {
          asset: string
          experiment_id: string
          last_event_key: string | null
          last_event_ts: number | null
          market_title: string | null
          outcome: string | null
          shares: number
          updated_at: string
          wallet: string
        }
        Insert: {
          asset: string
          experiment_id: string
          last_event_key?: string | null
          last_event_ts?: number | null
          market_title?: string | null
          outcome?: string | null
          shares?: number
          updated_at?: string
          wallet: string
        }
        Update: {
          asset?: string
          experiment_id?: string
          last_event_key?: string | null
          last_event_ts?: number | null
          market_title?: string | null
          outcome?: string | null
          shares?: number
          updated_at?: string
          wallet?: string
        }
        Relationships: [
          {
            foreignKeyName: "experiment_source_position_state_experiment_id_fkey"
            columns: ["experiment_id"]
            isOneToOne: false
            referencedRelation: "paper_experiments"
            referencedColumns: ["id"]
          },
        ]
      }
      general_activity: {
        Row: {
          activity_type: string
          asset: string | null
          category: string
          condition_id: string | null
          created_at: string
          economics_status: string
          event_key: string
          first_seen_at: string
          id: string
          market_title: string | null
          outcome: string | null
          post_go_live: boolean
          price: number | null
          raw: Json | null
          shares: number | null
          slug: string | null
          source_ts: number
          usdc_size: number | null
          wallet: string
        }
        Insert: {
          activity_type: string
          asset?: string | null
          category?: string
          condition_id?: string | null
          created_at?: string
          economics_status?: string
          event_key: string
          first_seen_at?: string
          id?: string
          market_title?: string | null
          outcome?: string | null
          post_go_live?: boolean
          price?: number | null
          raw?: Json | null
          shares?: number | null
          slug?: string | null
          source_ts: number
          usdc_size?: number | null
          wallet: string
        }
        Update: {
          activity_type?: string
          asset?: string | null
          category?: string
          condition_id?: string | null
          created_at?: string
          economics_status?: string
          event_key?: string
          first_seen_at?: string
          id?: string
          market_title?: string | null
          outcome?: string | null
          post_go_live?: boolean
          price?: number | null
          raw?: Json | null
          shares?: number | null
          slug?: string | null
          source_ts?: number
          usdc_size?: number | null
          wallet?: string
        }
        Relationships: []
      }
      integration_status: {
        Row: {
          account_summary: Json | null
          configured: boolean
          connected: boolean
          detail: string | null
          id: string
          last_verified_at: string | null
          status: string
          updated_at: string
        }
        Insert: {
          account_summary?: Json | null
          configured?: boolean
          connected?: boolean
          detail?: string | null
          id: string
          last_verified_at?: string | null
          status?: string
          updated_at?: string
        }
        Update: {
          account_summary?: Json | null
          configured?: boolean
          connected?: boolean
          detail?: string | null
          id?: string
          last_verified_at?: string | null
          status?: string
          updated_at?: string
        }
        Relationships: []
      }
      live_safety_state: {
        Row: {
          activated_at: string | null
          activated_by: string | null
          activation_stage: string
          armed_at: string | null
          armed_by: string | null
          id: string
          kill_switch_engaged: boolean
          last_action: string | null
          last_action_at: string | null
          max_live_exposure_usd: number
          max_live_notional_usd: number
          updated_at: string
        }
        Insert: {
          activated_at?: string | null
          activated_by?: string | null
          activation_stage?: string
          armed_at?: string | null
          armed_by?: string | null
          id?: string
          kill_switch_engaged?: boolean
          last_action?: string | null
          last_action_at?: string | null
          max_live_exposure_usd?: number
          max_live_notional_usd?: number
          updated_at?: string
        }
        Update: {
          activated_at?: string | null
          activated_by?: string | null
          activation_stage?: string
          armed_at?: string | null
          armed_by?: string | null
          id?: string
          kill_switch_engaged?: boolean
          last_action?: string | null
          last_action_at?: string | null
          max_live_exposure_usd?: number
          max_live_notional_usd?: number
          updated_at?: string
        }
        Relationships: []
      }
      order_previews: {
        Row: {
          asset: string
          available_balance: number | null
          balance_currency: string | null
          candidate_notional: number
          candidate_shares: number
          compatibility: string
          compatibility_reason: string | null
          created_at: string
          decided_at: string | null
          error: string | null
          event_key: string
          experiment_id: string
          id: string
          market_title: string | null
          outcome: string | null
          preview_estimated_cost: number | null
          preview_price: number | null
          preview_quantity: number | null
          preview_side: string | null
          source_event_id: string | null
          source_price: number | null
          source_side: string
          source_slug: string | null
          source_ts: number | null
          status: string
          updated_at: string
          us_market_slug: string | null
        }
        Insert: {
          asset: string
          available_balance?: number | null
          balance_currency?: string | null
          candidate_notional?: number
          candidate_shares?: number
          compatibility?: string
          compatibility_reason?: string | null
          created_at?: string
          decided_at?: string | null
          error?: string | null
          event_key: string
          experiment_id: string
          id?: string
          market_title?: string | null
          outcome?: string | null
          preview_estimated_cost?: number | null
          preview_price?: number | null
          preview_quantity?: number | null
          preview_side?: string | null
          source_event_id?: string | null
          source_price?: number | null
          source_side: string
          source_slug?: string | null
          source_ts?: number | null
          status?: string
          updated_at?: string
          us_market_slug?: string | null
        }
        Update: {
          asset?: string
          available_balance?: number | null
          balance_currency?: string | null
          candidate_notional?: number
          candidate_shares?: number
          compatibility?: string
          compatibility_reason?: string | null
          created_at?: string
          decided_at?: string | null
          error?: string | null
          event_key?: string
          experiment_id?: string
          id?: string
          market_title?: string | null
          outcome?: string | null
          preview_estimated_cost?: number | null
          preview_price?: number | null
          preview_quantity?: number | null
          preview_side?: string | null
          source_event_id?: string | null
          source_price?: number | null
          source_side?: string
          source_slug?: string | null
          source_ts?: number | null
          status?: string
          updated_at?: string
          us_market_slug?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "order_previews_experiment_id_fkey"
            columns: ["experiment_id"]
            isOneToOne: false
            referencedRelation: "paper_experiments"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "order_previews_source_event_id_fkey"
            columns: ["source_event_id"]
            isOneToOne: false
            referencedRelation: "source_events"
            referencedColumns: ["id"]
          },
        ]
      }
      paper_experiments: {
        Row: {
          buy_amount: number
          cash: number
          copyability_cursor_created_at: string | null
          copyability_cursor_id: string | null
          created_at: string
          enabled: boolean
          follow_from_ts: number | null
          id: string
          name: string
          poll_interval_seconds: number
          realized_pnl: number
          settlement_cursor_asset: string | null
          simulated: boolean
          sizing_rule: string
          sizing_rule_updated_at: string
          starting_cash: number
          updated_at: string
          wallet_address: string
          weather_only: boolean
        }
        Insert: {
          buy_amount?: number
          cash?: number
          copyability_cursor_created_at?: string | null
          copyability_cursor_id?: string | null
          created_at?: string
          enabled?: boolean
          follow_from_ts?: number | null
          id?: string
          name: string
          poll_interval_seconds?: number
          realized_pnl?: number
          settlement_cursor_asset?: string | null
          simulated?: boolean
          sizing_rule?: string
          sizing_rule_updated_at?: string
          starting_cash?: number
          updated_at?: string
          wallet_address: string
          weather_only?: boolean
        }
        Update: {
          buy_amount?: number
          cash?: number
          copyability_cursor_created_at?: string | null
          copyability_cursor_id?: string | null
          created_at?: string
          enabled?: boolean
          follow_from_ts?: number | null
          id?: string
          name?: string
          poll_interval_seconds?: number
          realized_pnl?: number
          settlement_cursor_asset?: string | null
          simulated?: boolean
          sizing_rule?: string
          sizing_rule_updated_at?: string
          starting_cash?: number
          updated_at?: string
          wallet_address?: string
          weather_only?: boolean
        }
        Relationships: []
      }
      paper_positions: {
        Row: {
          asset: string
          avg_price: number
          best_ask: number | null
          best_bid: number | null
          cost_basis: number
          experiment_id: string
          id: string
          last_activity_ts: number | null
          mark: number | null
          mark_source: string | null
          mark_ts: string | null
          market_title: string | null
          midpoint: number | null
          outcome: string | null
          realized_pnl: number
          settlement_status: string
          shares: number
          updated_at: string
        }
        Insert: {
          asset: string
          avg_price?: number
          best_ask?: number | null
          best_bid?: number | null
          cost_basis?: number
          experiment_id: string
          id?: string
          last_activity_ts?: number | null
          mark?: number | null
          mark_source?: string | null
          mark_ts?: string | null
          market_title?: string | null
          midpoint?: number | null
          outcome?: string | null
          realized_pnl?: number
          settlement_status?: string
          shares?: number
          updated_at?: string
        }
        Update: {
          asset?: string
          avg_price?: number
          best_ask?: number | null
          best_bid?: number | null
          cost_basis?: number
          experiment_id?: string
          id?: string
          last_activity_ts?: number | null
          mark?: number | null
          mark_source?: string | null
          mark_ts?: string | null
          market_title?: string | null
          midpoint?: number | null
          outcome?: string | null
          realized_pnl?: number
          settlement_status?: string
          shares?: number
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "paper_positions_experiment_id_fkey"
            columns: ["experiment_id"]
            isOneToOne: false
            referencedRelation: "paper_experiments"
            referencedColumns: ["id"]
          },
        ]
      }
      paper_settlements: {
        Row: {
          asset: string
          condition_id: string | null
          cost_basis: number
          created_at: string
          evidence: Json
          experiment_id: string
          id: string
          market_title: string | null
          outcome: string | null
          payout: number
          realized_pnl: number
          resolution_outcome: string
          resolution_source: string
          resolution_ts: string | null
          settled_at: string
          shares: number
          slippage_basis_cents: number | null
          slippage_method_version: string | null
          slippage_sample_count: number | null
          slippage_sample_cutoff_at: string | null
          verified: boolean
        }
        Insert: {
          asset: string
          condition_id?: string | null
          cost_basis?: number
          created_at?: string
          evidence?: Json
          experiment_id: string
          id?: string
          market_title?: string | null
          outcome?: string | null
          payout?: number
          realized_pnl?: number
          resolution_outcome: string
          resolution_source: string
          resolution_ts?: string | null
          settled_at?: string
          shares?: number
          slippage_basis_cents?: number | null
          slippage_method_version?: string | null
          slippage_sample_count?: number | null
          slippage_sample_cutoff_at?: string | null
          verified?: boolean
        }
        Update: {
          asset?: string
          condition_id?: string | null
          cost_basis?: number
          created_at?: string
          evidence?: Json
          experiment_id?: string
          id?: string
          market_title?: string | null
          outcome?: string | null
          payout?: number
          realized_pnl?: number
          resolution_outcome?: string
          resolution_source?: string
          resolution_ts?: string | null
          settled_at?: string
          shares?: number
          slippage_basis_cents?: number | null
          slippage_method_version?: string | null
          slippage_sample_count?: number | null
          slippage_sample_cutoff_at?: string | null
          verified?: boolean
        }
        Relationships: [
          {
            foreignKeyName: "paper_settlements_experiment_id_fkey"
            columns: ["experiment_id"]
            isOneToOne: false
            referencedRelation: "paper_experiments"
            referencedColumns: ["id"]
          },
        ]
      }
      paper_trades: {
        Row: {
          action: string
          asset: string
          cash_after: number | null
          created_at: string
          event_key: string
          experiment_id: string
          id: string
          market_title: string | null
          notional: number
          outcome: string | null
          price: number | null
          realized_pnl: number
          reason: string | null
          shares: number
          side: string | null
          source_event_id: string | null
          source_ts: number | null
        }
        Insert: {
          action: string
          asset: string
          cash_after?: number | null
          created_at?: string
          event_key: string
          experiment_id: string
          id?: string
          market_title?: string | null
          notional?: number
          outcome?: string | null
          price?: number | null
          realized_pnl?: number
          reason?: string | null
          shares?: number
          side?: string | null
          source_event_id?: string | null
          source_ts?: number | null
        }
        Update: {
          action?: string
          asset?: string
          cash_after?: number | null
          created_at?: string
          event_key?: string
          experiment_id?: string
          id?: string
          market_title?: string | null
          notional?: number
          outcome?: string | null
          price?: number | null
          realized_pnl?: number
          reason?: string | null
          shares?: number
          side?: string | null
          source_event_id?: string | null
          source_ts?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "paper_trades_experiment_id_fkey"
            columns: ["experiment_id"]
            isOneToOne: false
            referencedRelation: "paper_experiments"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "paper_trades_source_event_id_fkey"
            columns: ["source_event_id"]
            isOneToOne: false
            referencedRelation: "source_events"
            referencedColumns: ["id"]
          },
        ]
      }
      pipeline_audit: {
        Row: {
          action: string | null
          alert_created_at: string | null
          compatibility_checked_at: string | null
          created_at: string
          decision_at: string | null
          decision_latency_seconds: number | null
          detected_at: string | null
          detection_latency_seconds: number | null
          event_key: string
          event_persisted_at: string | null
          experiment_id: string
          id: string
          market_title: string | null
          paper_trade_at: string | null
          position_updated_at: string | null
          preview_created_at: string | null
          side: string | null
          source_ts: number | null
          total_latency_seconds: number | null
          wallet: string
        }
        Insert: {
          action?: string | null
          alert_created_at?: string | null
          compatibility_checked_at?: string | null
          created_at?: string
          decision_at?: string | null
          decision_latency_seconds?: number | null
          detected_at?: string | null
          detection_latency_seconds?: number | null
          event_key: string
          event_persisted_at?: string | null
          experiment_id: string
          id?: string
          market_title?: string | null
          paper_trade_at?: string | null
          position_updated_at?: string | null
          preview_created_at?: string | null
          side?: string | null
          source_ts?: number | null
          total_latency_seconds?: number | null
          wallet: string
        }
        Update: {
          action?: string | null
          alert_created_at?: string | null
          compatibility_checked_at?: string | null
          created_at?: string
          decision_at?: string | null
          decision_latency_seconds?: number | null
          detected_at?: string | null
          detection_latency_seconds?: number | null
          event_key?: string
          event_persisted_at?: string | null
          experiment_id?: string
          id?: string
          market_title?: string | null
          paper_trade_at?: string | null
          position_updated_at?: string | null
          preview_created_at?: string | null
          side?: string | null
          source_ts?: number | null
          total_latency_seconds?: number | null
          wallet?: string
        }
        Relationships: [
          {
            foreignKeyName: "pipeline_audit_experiment_id_fkey"
            columns: ["experiment_id"]
            isOneToOne: false
            referencedRelation: "paper_experiments"
            referencedColumns: ["id"]
          },
        ]
      }
      source_events: {
        Row: {
          asset: string
          backfilled: boolean
          condition_id: string | null
          event_key: string
          first_seen_at: string
          id: string
          identity_basis: string
          identity_degraded: boolean
          log_index: string | null
          market_title: string
          outcome: string | null
          price: number
          processed_at: string | null
          raw: Json | null
          shares: number
          side: string
          slug: string | null
          source_native_id: string | null
          source_ts: number
          tx_hash: string | null
          wallet: string
        }
        Insert: {
          asset: string
          backfilled?: boolean
          condition_id?: string | null
          event_key: string
          first_seen_at?: string
          id?: string
          identity_basis: string
          identity_degraded?: boolean
          log_index?: string | null
          market_title?: string
          outcome?: string | null
          price?: number
          processed_at?: string | null
          raw?: Json | null
          shares?: number
          side: string
          slug?: string | null
          source_native_id?: string | null
          source_ts?: number
          tx_hash?: string | null
          wallet: string
        }
        Update: {
          asset?: string
          backfilled?: boolean
          condition_id?: string | null
          event_key?: string
          first_seen_at?: string
          id?: string
          identity_basis?: string
          identity_degraded?: boolean
          log_index?: string | null
          market_title?: string
          outcome?: string | null
          price?: number
          processed_at?: string | null
          raw?: Json | null
          shares?: number
          side?: string
          slug?: string | null
          source_native_id?: string | null
          source_ts?: number
          tx_hash?: string | null
          wallet?: string
        }
        Relationships: []
      }
      source_position_state: {
        Row: {
          asset: string
          calculation_version: number
          id: string
          last_event_key: string | null
          last_event_ts: number | null
          market_title: string | null
          outcome: string | null
          reconciled_at: string | null
          reconciliation_status: string
          shares: number
          updated_at: string
          wallet: string
        }
        Insert: {
          asset: string
          calculation_version?: number
          id?: string
          last_event_key?: string | null
          last_event_ts?: number | null
          market_title?: string | null
          outcome?: string | null
          reconciled_at?: string | null
          reconciliation_status?: string
          shares?: number
          updated_at?: string
          wallet: string
        }
        Update: {
          asset?: string
          calculation_version?: number
          id?: string
          last_event_key?: string | null
          last_event_ts?: number | null
          market_title?: string | null
          outcome?: string | null
          reconciled_at?: string | null
          reconciliation_status?: string
          shares?: number
          updated_at?: string
          wallet?: string
        }
        Relationships: []
      }
      tracked_wallets: {
        Row: {
          active: boolean
          address: string
          created_at: string
          id: string
          label: string | null
        }
        Insert: {
          active?: boolean
          address: string
          created_at?: string
          id?: string
          label?: string | null
        }
        Update: {
          active?: boolean
          address?: string
          created_at?: string
          id?: string
          label?: string | null
        }
        Relationships: []
      }
      us_market_scans: {
        Row: {
          detail: string | null
          id: string
          new_count: number
          relevant_count: number
          scanned_at: string
          slugs: Json | null
          status: string
        }
        Insert: {
          detail?: string | null
          id?: string
          new_count?: number
          relevant_count?: number
          scanned_at?: string
          slugs?: Json | null
          status?: string
        }
        Update: {
          detail?: string | null
          id?: string
          new_count?: number
          relevant_count?: number
          scanned_at?: string
          slugs?: Json | null
          status?: string
        }
        Relationships: []
      }
      user_roles: {
        Row: {
          created_at: string
          id: string
          role: Database["public"]["Enums"]["app_role"]
          user_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          role: Database["public"]["Enums"]["app_role"]
          user_id: string
        }
        Update: {
          created_at?: string
          id?: string
          role?: Database["public"]["Enums"]["app_role"]
          user_id?: string
        }
        Relationships: []
      }
      wallet_reconcile_leases: {
        Row: {
          holder: string
          lease_expires_at: string
          updated_at: string
          wallet: string
        }
        Insert: {
          holder: string
          lease_expires_at: string
          updated_at?: string
          wallet: string
        }
        Update: {
          holder?: string
          lease_expires_at?: string
          updated_at?: string
          wallet?: string
        }
        Relationships: []
      }
      worker_checkpoints: {
        Row: {
          bootstrap_complete: boolean
          events_seen: number
          id: string
          last_event_key: string | null
          last_source_ts: number
          updated_at: string
          wallet: string
        }
        Insert: {
          bootstrap_complete?: boolean
          events_seen?: number
          id: string
          last_event_key?: string | null
          last_source_ts?: number
          updated_at?: string
          wallet: string
        }
        Update: {
          bootstrap_complete?: boolean
          events_seen?: number
          id?: string
          last_event_key?: string | null
          last_source_ts?: number
          updated_at?: string
          wallet?: string
        }
        Relationships: []
      }
      worker_status: {
        Row: {
          events_ingested: number
          fence: number
          heartbeat_at: string | null
          id: string
          lag_seconds: number | null
          last_error: string | null
          last_poll_at: string | null
          last_poll_events_inserted: number
          last_success_at: string | null
          lease_expires_at: string | null
          poll_failures: number
          stage_ms: Json | null
          state: string
          updated_at: string
          worker_id: string | null
        }
        Insert: {
          events_ingested?: number
          fence?: number
          heartbeat_at?: string | null
          id: string
          lag_seconds?: number | null
          last_error?: string | null
          last_poll_at?: string | null
          last_poll_events_inserted?: number
          last_success_at?: string | null
          lease_expires_at?: string | null
          poll_failures?: number
          stage_ms?: Json | null
          state?: string
          updated_at?: string
          worker_id?: string | null
        }
        Update: {
          events_ingested?: number
          fence?: number
          heartbeat_at?: string | null
          id?: string
          lag_seconds?: number | null
          last_error?: string | null
          last_poll_at?: string | null
          last_poll_events_inserted?: number
          last_success_at?: string | null
          lease_expires_at?: string | null
          poll_failures?: number
          stage_ms?: Json | null
          state?: string
          updated_at?: string
          worker_id?: string | null
        }
        Relationships: []
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      acquire_worker_lease: {
        Args: { p_id: string; p_lease_seconds: number; p_worker_id: string }
        Returns: number
      }
      apply_verified_paper_settlement: {
        Args: {
          p_asset: string
          p_condition_id: string
          p_evidence: Json
          p_experiment_id: string
          p_payout_per_share: number
          p_resolution_outcome: string
          p_resolution_source: string
          p_resolution_ts: string
          p_slippage_basis_cents?: number
          p_slippage_method_version?: string
          p_slippage_sample_count?: number
          p_slippage_sample_cutoff_at?: string
        }
        Returns: {
          applied: boolean
          payout: number
          realized_pnl: number
        }[]
      }
      get_experiment_source_positions: {
        Args: { p_assets: string[]; p_experiment_id: string }
        Returns: {
          asset: string
          shares: number
        }[]
      }
      get_pending_experiment_source_events: {
        Args: { p_experiment_id: string; p_limit?: number }
        Returns: {
          asset: string
          event_key: string
          first_seen_at: string
          id: string
          market_title: string
          outcome: string
          price: number
          shares: number
          side: string
          source_ts: number
        }[]
      }
      has_role: {
        Args: {
          _role: Database["public"]["Enums"]["app_role"]
          _user_id: string
        }
        Returns: boolean
      }
      process_source_event_atomic: {
        Args: {
          p_event: Json
          p_experiment_id: string
          p_fence: number
          p_lock_id: string
          p_worker_id: string
        }
        Returns: Json
      }
      release_reconcile_lease: {
        Args: { p_holder: string; p_wallet: string }
        Returns: undefined
      }
      try_acquire_reconcile_lease: {
        Args: { p_holder: string; p_seconds: number; p_wallet: string }
        Returns: boolean
      }
    }
    Enums: {
      app_role: "admin"
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
  public: {
    Enums: {
      app_role: ["admin"],
    },
  },
} as const
