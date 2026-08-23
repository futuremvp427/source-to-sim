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
      http_rate_limits: {
        Row: {
          blocked_until: string | null
          host: string
          next_request_at: string | null
          reason: string | null
          updated_at: string
        }
        Insert: {
          blocked_until?: string | null
          host: string
          next_request_at?: string | null
          reason?: string | null
          updated_at?: string
        }
        Update: {
          blocked_until?: string | null
          host?: string
          next_request_at?: string | null
          reason?: string | null
          updated_at?: string
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
      live_order_intents: {
        Row: {
          avg_fill_price: number | null
          created_at: string
          decision_at: string | null
          detected_at: string
          fail_reason: string | null
          fees_usd: number | null
          filled_shares: number | null
          id: string
          live_price_snapshot: Json | null
          market_mapping_status: string | null
          pilot_id: string
          requested_notional_usd: number | null
          requested_shares: number | null
          safety_checks: Json | null
          source_asset: string | null
          source_condition_id: string | null
          source_event_id: string
          source_event_key: string
          source_experiment_id: string
          source_price: number
          source_side: string
          source_ts: number
          source_wallet: string
          status: string
          status_history: Json
          submitted_order_id: string | null
          updated_at: string
          us_market_slug: string | null
        }
        Insert: {
          avg_fill_price?: number | null
          created_at?: string
          decision_at?: string | null
          detected_at?: string
          fail_reason?: string | null
          fees_usd?: number | null
          filled_shares?: number | null
          id?: string
          live_price_snapshot?: Json | null
          market_mapping_status?: string | null
          pilot_id: string
          requested_notional_usd?: number | null
          requested_shares?: number | null
          safety_checks?: Json | null
          source_asset?: string | null
          source_condition_id?: string | null
          source_event_id: string
          source_event_key: string
          source_experiment_id: string
          source_price: number
          source_side: string
          source_ts: number
          source_wallet: string
          status?: string
          status_history?: Json
          submitted_order_id?: string | null
          updated_at?: string
          us_market_slug?: string | null
        }
        Update: {
          avg_fill_price?: number | null
          created_at?: string
          decision_at?: string | null
          detected_at?: string
          fail_reason?: string | null
          fees_usd?: number | null
          filled_shares?: number | null
          id?: string
          live_price_snapshot?: Json | null
          market_mapping_status?: string | null
          pilot_id?: string
          requested_notional_usd?: number | null
          requested_shares?: number | null
          safety_checks?: Json | null
          source_asset?: string | null
          source_condition_id?: string | null
          source_event_id?: string
          source_event_key?: string
          source_experiment_id?: string
          source_price?: number
          source_side?: string
          source_ts?: number
          source_wallet?: string
          status?: string
          status_history?: Json
          submitted_order_id?: string | null
          updated_at?: string
          us_market_slug?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "live_order_intents_pilot_id_fkey"
            columns: ["pilot_id"]
            isOneToOne: false
            referencedRelation: "live_pilot_state"
            referencedColumns: ["pilot_id"]
          },
          {
            foreignKeyName: "live_order_intents_source_event_id_fkey"
            columns: ["source_event_id"]
            isOneToOne: false
            referencedRelation: "source_events"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "live_order_intents_source_experiment_id_fkey"
            columns: ["source_experiment_id"]
            isOneToOne: false
            referencedRelation: "paper_experiments"
            referencedColumns: ["id"]
          },
        ]
      }
      live_pilot_state: {
        Row: {
          activated_at: string | null
          activated_by: string | null
          activation_stage: string
          armed_at: string | null
          armed_by: string | null
          consecutive_failed_orders: number
          kill_switch_engaged: boolean
          last_action: string | null
          last_action_at: string | null
          max_daily_realized_loss_usd: number
          max_order_notional_usd: number
          max_total_exposure_usd: number
          pilot_bankroll_usd: number
          pilot_id: string
          updated_at: string
        }
        Insert: {
          activated_at?: string | null
          activated_by?: string | null
          activation_stage?: string
          armed_at?: string | null
          armed_by?: string | null
          consecutive_failed_orders?: number
          kill_switch_engaged?: boolean
          last_action?: string | null
          last_action_at?: string | null
          max_daily_realized_loss_usd?: number
          max_order_notional_usd?: number
          max_total_exposure_usd?: number
          pilot_bankroll_usd?: number
          pilot_id: string
          updated_at?: string
        }
        Update: {
          activated_at?: string | null
          activated_by?: string | null
          activation_stage?: string
          armed_at?: string | null
          armed_by?: string | null
          consecutive_failed_orders?: number
          kill_switch_engaged?: boolean
          last_action?: string | null
          last_action_at?: string | null
          max_daily_realized_loss_usd?: number
          max_order_notional_usd?: number
          max_total_exposure_usd?: number
          pilot_bankroll_usd?: number
          pilot_id?: string
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
      paper_buy_notification_cursor: {
        Row: {
          cursor_name: string
          last_created_at: string
          last_trade_id: string
          updated_at: string
        }
        Insert: {
          cursor_name: string
          last_created_at: string
          last_trade_id: string
          updated_at?: string
        }
        Update: {
          cursor_name?: string
          last_created_at?: string
          last_trade_id?: string
          updated_at?: string
        }
        Relationships: []
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
          market_scope: string
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
          market_scope?: string
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
          market_scope?: string
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
      sports_market_matches: {
        Row: {
          first_match_status: string
          id: string
          line: number | null
          match_status: string
          metadata: Json | null
          next_recheck_at: string | null
          normalized_game_id: string | null
          reason: string | null
          recheck_count: number
          resolved_at: string
          rule_fingerprint: Json | null
          rule_fingerprint_version: string | null
          selected_side: string | null
          settlement_compatibility: string
          signal_id: string
          target_event_id: string | null
          target_identifier: string | null
          target_market_id: string | null
          venue: string
        }
        Insert: {
          first_match_status: string
          id?: string
          line?: number | null
          match_status: string
          metadata?: Json | null
          next_recheck_at?: string | null
          normalized_game_id?: string | null
          reason?: string | null
          recheck_count?: number
          resolved_at?: string
          rule_fingerprint?: Json | null
          rule_fingerprint_version?: string | null
          selected_side?: string | null
          settlement_compatibility?: string
          signal_id: string
          target_event_id?: string | null
          target_identifier?: string | null
          target_market_id?: string | null
          venue: string
        }
        Update: {
          first_match_status?: string
          id?: string
          line?: number | null
          match_status?: string
          metadata?: Json | null
          next_recheck_at?: string | null
          normalized_game_id?: string | null
          reason?: string | null
          recheck_count?: number
          resolved_at?: string
          rule_fingerprint?: Json | null
          rule_fingerprint_version?: string | null
          selected_side?: string | null
          settlement_compatibility?: string
          signal_id?: string
          target_event_id?: string | null
          target_identifier?: string | null
          target_market_id?: string | null
          venue?: string
        }
        Relationships: [
          {
            foreignKeyName: "sports_market_matches_signal_id_fkey"
            columns: ["signal_id"]
            isOneToOne: false
            referencedRelation: "sports_shadow_signals"
            referencedColumns: ["id"]
          },
        ]
      }
      sports_quote_observations: {
        Row: {
          ask_depth: Json | null
          best_ask: number | null
          best_bid: number | null
          bid_depth: Json | null
          created_at: string
          detection_latency_ms: number | null
          error_code: string | null
          fetch_ended_at: string | null
          fetch_started_at: string | null
          fire_at: string
          id: string
          market_status: string | null
          match_id: string | null
          observed_at: string | null
          raw_metadata: Json | null
          reason: string | null
          requested_delay_ms: number
          signal_id: string
          source_timestamp: string
          spread: number | null
          stale: boolean
          trigger_source_fill_id: string | null
          venue: string
        }
        Insert: {
          ask_depth?: Json | null
          best_ask?: number | null
          best_bid?: number | null
          bid_depth?: Json | null
          created_at?: string
          detection_latency_ms?: number | null
          error_code?: string | null
          fetch_ended_at?: string | null
          fetch_started_at?: string | null
          fire_at: string
          id?: string
          market_status?: string | null
          match_id?: string | null
          observed_at?: string | null
          raw_metadata?: Json | null
          reason?: string | null
          requested_delay_ms: number
          signal_id: string
          source_timestamp: string
          spread?: number | null
          stale?: boolean
          trigger_source_fill_id?: string | null
          venue: string
        }
        Update: {
          ask_depth?: Json | null
          best_ask?: number | null
          best_bid?: number | null
          bid_depth?: Json | null
          created_at?: string
          detection_latency_ms?: number | null
          error_code?: string | null
          fetch_ended_at?: string | null
          fetch_started_at?: string | null
          fire_at?: string
          id?: string
          market_status?: string | null
          match_id?: string | null
          observed_at?: string | null
          raw_metadata?: Json | null
          reason?: string | null
          requested_delay_ms?: number
          signal_id?: string
          source_timestamp?: string
          spread?: number | null
          stale?: boolean
          trigger_source_fill_id?: string | null
          venue?: string
        }
        Relationships: [
          {
            foreignKeyName: "sports_quote_observations_match_id_fkey"
            columns: ["match_id"]
            isOneToOne: false
            referencedRelation: "sports_market_matches"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "sports_quote_observations_signal_id_fkey"
            columns: ["signal_id"]
            isOneToOne: false
            referencedRelation: "sports_shadow_signals"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "sports_quote_observations_trigger_source_fill_id_fkey"
            columns: ["trigger_source_fill_id"]
            isOneToOne: false
            referencedRelation: "sports_shadow_lifecycle_triggers"
            referencedColumns: ["id"]
          },
        ]
      }
      sports_shadow_alerts: {
        Row: {
          alert_key: string
          created_at: string
          id: string
          message: string
          resolved_at: string | null
          severity: string
        }
        Insert: {
          alert_key: string
          created_at?: string
          id?: string
          message: string
          resolved_at?: string | null
          severity: string
        }
        Update: {
          alert_key?: string
          created_at?: string
          id?: string
          message?: string
          resolved_at?: string | null
          severity?: string
        }
        Relationships: []
      }
      sports_shadow_experiment_epochs: {
        Row: {
          calibration_started_at: string | null
          classifier_version: string
          config_hash: string
          created_at: string
          episode_version: string
          execution_simulator_version: string
          frozen_at: string | null
          frozen_config: Json | null
          git_sha: string
          go_live_at: string
          id: string
          is_current: boolean
          kalshi_fee_model_version: string
          notes: string | null
          oos_started_at: string | null
          pmus_fee_model_version: string
          resolver_version: string
          router_version: string
          settlement_version: string
          soak_started_at: string | null
          stage: string
          stage_entered_at: string
          wallet_cohort: string[]
        }
        Insert: {
          calibration_started_at?: string | null
          classifier_version: string
          config_hash: string
          created_at?: string
          episode_version: string
          execution_simulator_version: string
          frozen_at?: string | null
          frozen_config?: Json | null
          git_sha: string
          go_live_at: string
          id?: string
          is_current?: boolean
          kalshi_fee_model_version: string
          notes?: string | null
          oos_started_at?: string | null
          pmus_fee_model_version: string
          resolver_version: string
          router_version: string
          settlement_version: string
          soak_started_at?: string | null
          stage?: string
          stage_entered_at?: string
          wallet_cohort: string[]
        }
        Update: {
          calibration_started_at?: string | null
          classifier_version?: string
          config_hash?: string
          created_at?: string
          episode_version?: string
          execution_simulator_version?: string
          frozen_at?: string | null
          frozen_config?: Json | null
          git_sha?: string
          go_live_at?: string
          id?: string
          is_current?: boolean
          kalshi_fee_model_version?: string
          notes?: string | null
          oos_started_at?: string | null
          pmus_fee_model_version?: string
          resolver_version?: string
          router_version?: string
          settlement_version?: string
          soak_started_at?: string | null
          stage?: string
          stage_entered_at?: string
          wallet_cohort?: string[]
        }
        Relationships: []
      }
      sports_shadow_integrity_audits: {
        Row: {
          checks_failed: number
          checks_run: number
          findings: Json
          id: string
          passed: boolean
          run_at: string
        }
        Insert: {
          checks_failed: number
          checks_run: number
          findings?: Json
          id?: string
          passed: boolean
          run_at?: string
        }
        Update: {
          checks_failed?: number
          checks_run?: number
          findings?: Json
          id?: string
          passed?: boolean
          run_at?: string
        }
        Relationships: []
      }
      sports_shadow_lifecycle_triggers: {
        Row: {
          add_fraction: number | null
          detected_at: string
          exit_fraction: number | null
          id: string
          price: number
          signal_id: string
          source_fill_id: string
          source_ts: number
          tracked_shares: number
          trigger_type: string
        }
        Insert: {
          add_fraction?: number | null
          detected_at?: string
          exit_fraction?: number | null
          id?: string
          price: number
          signal_id: string
          source_fill_id: string
          source_ts: number
          tracked_shares: number
          trigger_type: string
        }
        Update: {
          add_fraction?: number | null
          detected_at?: string
          exit_fraction?: number | null
          id?: string
          price?: number
          signal_id?: string
          source_fill_id?: string
          source_ts?: number
          tracked_shares?: number
          trigger_type?: string
        }
        Relationships: [
          {
            foreignKeyName: "sports_shadow_lifecycle_triggers_signal_id_fkey"
            columns: ["signal_id"]
            isOneToOne: false
            referencedRelation: "sports_shadow_signals"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "sports_shadow_lifecycle_triggers_source_fill_id_fkey"
            columns: ["source_fill_id"]
            isOneToOne: true
            referencedRelation: "sports_shadow_source_fills"
            referencedColumns: ["id"]
          },
        ]
      }
      sports_shadow_milestone_snapshots: {
        Row: {
          classification: string
          created_at: string
          experiment_epoch_id: string
          frozen_config: Json
          id: string
          milestone_kind: string
          report: Json
          snapshot_version: string
        }
        Insert: {
          classification: string
          created_at?: string
          experiment_epoch_id: string
          frozen_config: Json
          id?: string
          milestone_kind: string
          report: Json
          snapshot_version: string
        }
        Update: {
          classification?: string
          created_at?: string
          experiment_epoch_id?: string
          frozen_config?: Json
          id?: string
          milestone_kind?: string
          report?: Json
          snapshot_version?: string
        }
        Relationships: [
          {
            foreignKeyName: "sports_shadow_milestone_snapshots_experiment_epoch_id_fkey"
            columns: ["experiment_epoch_id"]
            isOneToOne: false
            referencedRelation: "sports_shadow_experiment_epochs"
            referencedColumns: ["id"]
          },
        ]
      }
      sports_shadow_paper_fills: {
        Row: {
          all_in_cost_usd: number | null
          chosen_venue: string | null
          contracts: number
          created_at: string
          cutoff_reason: string | null
          decided_at: string | null
          experiment_epoch_id: string | null
          fee_model_version: string | null
          fee_usd: number | null
          fee_valid: boolean
          fill_status: string | null
          fire_at: string | null
          id: string
          kalshi_observation_id: string | null
          kalshi_result: Json | null
          notional_tier_usd: number
          pmus_observation_id: string | null
          pmus_result: Json | null
          reject_reason: string | null
          requested_delay_ms: number
          routing_timestamp: string | null
          selected_side: string | null
          side: string | null
          signal_id: string
          source_fill_id: string | null
          target_market_id: string | null
          trigger_source_fill_id: string | null
          vwap: number | null
        }
        Insert: {
          all_in_cost_usd?: number | null
          chosen_venue?: string | null
          contracts?: number
          created_at?: string
          cutoff_reason?: string | null
          decided_at?: string | null
          experiment_epoch_id?: string | null
          fee_model_version?: string | null
          fee_usd?: number | null
          fee_valid?: boolean
          fill_status?: string | null
          fire_at?: string | null
          id?: string
          kalshi_observation_id?: string | null
          kalshi_result?: Json | null
          notional_tier_usd: number
          pmus_observation_id?: string | null
          pmus_result?: Json | null
          reject_reason?: string | null
          requested_delay_ms: number
          routing_timestamp?: string | null
          selected_side?: string | null
          side?: string | null
          signal_id: string
          source_fill_id?: string | null
          target_market_id?: string | null
          trigger_source_fill_id?: string | null
          vwap?: number | null
        }
        Update: {
          all_in_cost_usd?: number | null
          chosen_venue?: string | null
          contracts?: number
          created_at?: string
          cutoff_reason?: string | null
          decided_at?: string | null
          experiment_epoch_id?: string | null
          fee_model_version?: string | null
          fee_usd?: number | null
          fee_valid?: boolean
          fill_status?: string | null
          fire_at?: string | null
          id?: string
          kalshi_observation_id?: string | null
          kalshi_result?: Json | null
          notional_tier_usd?: number
          pmus_observation_id?: string | null
          pmus_result?: Json | null
          reject_reason?: string | null
          requested_delay_ms?: number
          routing_timestamp?: string | null
          selected_side?: string | null
          side?: string | null
          signal_id?: string
          source_fill_id?: string | null
          target_market_id?: string | null
          trigger_source_fill_id?: string | null
          vwap?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "sports_shadow_paper_fills_experiment_epoch_id_fkey"
            columns: ["experiment_epoch_id"]
            isOneToOne: false
            referencedRelation: "sports_shadow_experiment_epochs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "sports_shadow_paper_fills_kalshi_observation_id_fkey"
            columns: ["kalshi_observation_id"]
            isOneToOne: false
            referencedRelation: "sports_quote_observations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "sports_shadow_paper_fills_pmus_observation_id_fkey"
            columns: ["pmus_observation_id"]
            isOneToOne: false
            referencedRelation: "sports_quote_observations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "sports_shadow_paper_fills_signal_id_fkey"
            columns: ["signal_id"]
            isOneToOne: false
            referencedRelation: "sports_shadow_signals"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "sports_shadow_paper_fills_source_fill_id_fkey"
            columns: ["source_fill_id"]
            isOneToOne: false
            referencedRelation: "sports_shadow_source_fills"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "sports_shadow_paper_fills_trigger_source_fill_id_fkey"
            columns: ["trigger_source_fill_id"]
            isOneToOne: false
            referencedRelation: "sports_shadow_lifecycle_triggers"
            referencedColumns: ["id"]
          },
        ]
      }
      sports_shadow_paper_positions: {
        Row: {
          add_cost_usd: number
          avg_entry_price: number | null
          contracts_added: number
          contracts_exited: number
          contracts_open: number
          exit_proceeds_usd: number
          id: string
          notional_tier_usd: number
          realized_pnl_usd: number
          remaining_cost_basis_usd: number
          signal_id: string
          status: string
          total_fees_usd: number
          updated_at: string
          venue: string
        }
        Insert: {
          add_cost_usd?: number
          avg_entry_price?: number | null
          contracts_added?: number
          contracts_exited?: number
          contracts_open?: number
          exit_proceeds_usd?: number
          id?: string
          notional_tier_usd: number
          realized_pnl_usd?: number
          remaining_cost_basis_usd?: number
          signal_id: string
          status?: string
          total_fees_usd?: number
          updated_at?: string
          venue: string
        }
        Update: {
          add_cost_usd?: number
          avg_entry_price?: number | null
          contracts_added?: number
          contracts_exited?: number
          contracts_open?: number
          exit_proceeds_usd?: number
          id?: string
          notional_tier_usd?: number
          realized_pnl_usd?: number
          remaining_cost_basis_usd?: number
          signal_id?: string
          status?: string
          total_fees_usd?: number
          updated_at?: string
          venue?: string
        }
        Relationships: [
          {
            foreignKeyName: "sports_shadow_paper_positions_signal_id_fkey"
            columns: ["signal_id"]
            isOneToOne: false
            referencedRelation: "sports_shadow_signals"
            referencedColumns: ["id"]
          },
        ]
      }
      sports_shadow_settlements: {
        Row: {
          check_attempt_count: number
          created_at: string
          gross_pnl_usd: number | null
          id: string
          net_pnl_usd: number | null
          next_check_at: string | null
          notional_tier_usd: number
          settlement_source: string | null
          settlement_status: string
          settlement_timestamp: string | null
          settlement_value: number | null
          signal_id: string
          total_fees_usd: number | null
          updated_at: string
          venue: string
        }
        Insert: {
          check_attempt_count?: number
          created_at?: string
          gross_pnl_usd?: number | null
          id?: string
          net_pnl_usd?: number | null
          next_check_at?: string | null
          notional_tier_usd: number
          settlement_source?: string | null
          settlement_status?: string
          settlement_timestamp?: string | null
          settlement_value?: number | null
          signal_id: string
          total_fees_usd?: number | null
          updated_at?: string
          venue: string
        }
        Update: {
          check_attempt_count?: number
          created_at?: string
          gross_pnl_usd?: number | null
          id?: string
          net_pnl_usd?: number | null
          next_check_at?: string | null
          notional_tier_usd?: number
          settlement_source?: string | null
          settlement_status?: string
          settlement_timestamp?: string | null
          settlement_value?: number | null
          signal_id?: string
          total_fees_usd?: number | null
          updated_at?: string
          venue?: string
        }
        Relationships: [
          {
            foreignKeyName: "sports_shadow_settlements_signal_id_fkey"
            columns: ["signal_id"]
            isOneToOne: false
            referencedRelation: "sports_shadow_signals"
            referencedColumns: ["id"]
          },
        ]
      }
      sports_shadow_signals: {
        Row: {
          away_team: string | null
          bet_type: string
          cluster_key: string | null
          created_at: string
          episode_key: string
          experiment_epoch_id: string | null
          first_fill_id: string
          home_team: string | null
          id: string
          league: string
          line: number | null
          scheduled_start_at: string | null
          selected_side: string
          source_asset: string
          source_condition_id: string | null
          source_event_slug: string | null
          source_fill_count: number
          source_first_fill_at: string
          source_handle: string | null
          source_last_fill_at: string
          source_market_slug: string | null
          source_notional: number
          source_outcome: string | null
          source_rules_description: string | null
          source_sell_notional: number
          source_sell_seen: boolean
          source_sell_shares: number
          source_sell_vwap: number | null
          source_shares: number
          source_vwap: number
          source_wallet: string
          status: string
          untracked_sell_notional: number
          untracked_sell_shares: number
          updated_at: string
        }
        Insert: {
          away_team?: string | null
          bet_type: string
          cluster_key?: string | null
          created_at?: string
          episode_key: string
          experiment_epoch_id?: string | null
          first_fill_id: string
          home_team?: string | null
          id?: string
          league?: string
          line?: number | null
          scheduled_start_at?: string | null
          selected_side: string
          source_asset: string
          source_condition_id?: string | null
          source_event_slug?: string | null
          source_fill_count?: number
          source_first_fill_at: string
          source_handle?: string | null
          source_last_fill_at: string
          source_market_slug?: string | null
          source_notional?: number
          source_outcome?: string | null
          source_rules_description?: string | null
          source_sell_notional?: number
          source_sell_seen?: boolean
          source_sell_shares?: number
          source_sell_vwap?: number | null
          source_shares?: number
          source_vwap?: number
          source_wallet: string
          status?: string
          untracked_sell_notional?: number
          untracked_sell_shares?: number
          updated_at?: string
        }
        Update: {
          away_team?: string | null
          bet_type?: string
          cluster_key?: string | null
          created_at?: string
          episode_key?: string
          experiment_epoch_id?: string | null
          first_fill_id?: string
          home_team?: string | null
          id?: string
          league?: string
          line?: number | null
          scheduled_start_at?: string | null
          selected_side?: string
          source_asset?: string
          source_condition_id?: string | null
          source_event_slug?: string | null
          source_fill_count?: number
          source_first_fill_at?: string
          source_handle?: string | null
          source_last_fill_at?: string
          source_market_slug?: string | null
          source_notional?: number
          source_outcome?: string | null
          source_rules_description?: string | null
          source_sell_notional?: number
          source_sell_seen?: boolean
          source_sell_shares?: number
          source_sell_vwap?: number | null
          source_shares?: number
          source_vwap?: number
          source_wallet?: string
          status?: string
          untracked_sell_notional?: number
          untracked_sell_shares?: number
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "sports_shadow_signals_experiment_epoch_id_fkey"
            columns: ["experiment_epoch_id"]
            isOneToOne: false
            referencedRelation: "sports_shadow_experiment_epochs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "sports_shadow_signals_first_fill_id_fkey"
            columns: ["first_fill_id"]
            isOneToOne: false
            referencedRelation: "sports_shadow_source_fills"
            referencedColumns: ["id"]
          },
        ]
      }
      sports_shadow_source_fills: {
        Row: {
          asset: string
          condition_id: string | null
          downstream_status: string
          downstream_unverified_reason: string | null
          event_key: string
          event_slug: string | null
          first_seen_at: string
          id: string
          identity_basis: string
          identity_degraded: boolean
          market_slug: string | null
          market_title: string
          outcome: string | null
          price: number
          raw: Json | null
          shares: number
          side: string
          source_ts: number
          tuple_prefix: string | null
          wallet: string
          wallet_handle: string | null
        }
        Insert: {
          asset: string
          condition_id?: string | null
          downstream_status?: string
          downstream_unverified_reason?: string | null
          event_key: string
          event_slug?: string | null
          first_seen_at?: string
          id?: string
          identity_basis: string
          identity_degraded?: boolean
          market_slug?: string | null
          market_title?: string
          outcome?: string | null
          price?: number
          raw?: Json | null
          shares?: number
          side: string
          source_ts?: number
          tuple_prefix?: string | null
          wallet: string
          wallet_handle?: string | null
        }
        Update: {
          asset?: string
          condition_id?: string | null
          downstream_status?: string
          downstream_unverified_reason?: string | null
          event_key?: string
          event_slug?: string | null
          first_seen_at?: string
          id?: string
          identity_basis?: string
          identity_degraded?: boolean
          market_slug?: string | null
          market_title?: string
          outcome?: string | null
          price?: number
          raw?: Json | null
          shares?: number
          side?: string
          source_ts?: number
          tuple_prefix?: string | null
          wallet?: string
          wallet_handle?: string | null
        }
        Relationships: []
      }
      sports_shadow_source_sell_events: {
        Row: {
          created_at: string
          id: string
          is_pre_epoch: boolean
          notional: number
          price: number
          shares: number
          signal_id: string | null
          source_fill_id: string
          source_ts: number
          untracked_shares: number
        }
        Insert: {
          created_at?: string
          id?: string
          is_pre_epoch?: boolean
          notional: number
          price: number
          shares: number
          signal_id?: string | null
          source_fill_id: string
          source_ts: number
          untracked_shares?: number
        }
        Update: {
          created_at?: string
          id?: string
          is_pre_epoch?: boolean
          notional?: number
          price?: number
          shares?: number
          signal_id?: string | null
          source_fill_id?: string
          source_ts?: number
          untracked_shares?: number
        }
        Relationships: [
          {
            foreignKeyName: "sports_shadow_source_sell_events_signal_id_fkey"
            columns: ["signal_id"]
            isOneToOne: false
            referencedRelation: "sports_shadow_signals"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "sports_shadow_source_sell_events_source_fill_id_fkey"
            columns: ["source_fill_id"]
            isOneToOne: true
            referencedRelation: "sports_shadow_source_fills"
            referencedColumns: ["id"]
          },
        ]
      }
      sports_shadow_telemetry_events: {
        Row: {
          category: string
          created_at: string
          experiment_epoch_id: string | null
          id: string
          labels: Json
          metric: string
          value: number | null
        }
        Insert: {
          category: string
          created_at?: string
          experiment_epoch_id?: string | null
          id?: string
          labels?: Json
          metric: string
          value?: number | null
        }
        Update: {
          category?: string
          created_at?: string
          experiment_epoch_id?: string | null
          id?: string
          labels?: Json
          metric?: string
          value?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "sports_shadow_telemetry_events_experiment_epoch_id_fkey"
            columns: ["experiment_epoch_id"]
            isOneToOne: false
            referencedRelation: "sports_shadow_experiment_epochs"
            referencedColumns: ["id"]
          },
        ]
      }
      sports_shadow_venue_capability: {
        Row: {
          checked_at: string
          detail: string | null
          discovery_available: boolean
          orderbook_available: boolean
          venue: string
        }
        Insert: {
          checked_at?: string
          detail?: string | null
          discovery_available?: boolean
          orderbook_available?: boolean
          venue: string
        }
        Update: {
          checked_at?: string
          detail?: string | null
          discovery_available?: boolean
          orderbook_available?: boolean
          venue?: string
        }
        Relationships: []
      }
      sports_shadow_wallet_coverage: {
        Row: {
          coverage_complete: boolean
          covered_through_ts: number | null
          incomplete_reason: string | null
          updated_at: string
          wallet: string
        }
        Insert: {
          coverage_complete?: boolean
          covered_through_ts?: number | null
          incomplete_reason?: string | null
          updated_at?: string
          wallet: string
        }
        Update: {
          coverage_complete?: boolean
          covered_through_ts?: number | null
          incomplete_reason?: string | null
          updated_at?: string
          wallet?: string
        }
        Relationships: []
      }
      sports_shadow_wallet_cursor: {
        Row: {
          id: string
          next_wallet_index: number
          updated_at: string
        }
        Insert: {
          id: string
          next_wallet_index?: number
          updated_at?: string
        }
        Update: {
          id?: string
          next_wallet_index?: number
          updated_at?: string
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
      advance_paper_buy_notification_cursor: {
        Args: { p_last_created_at: string; p_last_trade_id: string }
        Returns: undefined
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
      count_durable_ordinal_fills: {
        Args: { p_tuple_prefixes: string[]; p_wallet: string }
        Returns: {
          fill_count: number
          tuple_prefix: string
        }[]
      }
      create_or_get_live_pilot_intent_atomic: {
        Args: {
          p_payload: Json
          p_pilot_id: string
          p_source_event_id: string
          p_source_experiment_id: string
        }
        Returns: Json
      }
      finalize_sports_shadow_lifecycle_decision: {
        Args: {
          p_all_in_cost_usd: number
          p_contracts: number
          p_decided_at: string
          p_experiment_epoch_id: string
          p_fee_model_version: string
          p_fee_usd: number
          p_fee_valid: boolean
          p_fill_status: string
          p_notional_tier_usd: number
          p_observation_id: string
          p_reject_reason: string
          p_requested_delay_ms: number
          p_selected_side: string
          p_side: string
          p_signal_id: string
          p_source_fill_id: string
          p_target_market_id: string
          p_trigger_source_fill_id: string
          p_venue: string
          p_venue_result: Json
          p_vwap: number
        }
        Returns: boolean
      }
      finalize_sports_shadow_routing_decision: {
        Args: {
          p_all_in_cost_usd: number
          p_chosen_venue: string
          p_contracts: number
          p_cutoff_reason: string
          p_decided_at: string
          p_experiment_epoch_id: string
          p_fee_model_version: string
          p_fee_usd: number
          p_fee_valid: boolean
          p_fill_status: string
          p_kalshi_result: Json
          p_notional_tier_usd: number
          p_pmus_result: Json
          p_reject_reason: string
          p_requested_delay_ms: number
          p_selected_side: string
          p_side: string
          p_signal_id: string
          p_source_fill_id: string
          p_target_market_id: string
          p_trigger_source_fill_id?: string
          p_vwap: number
        }
        Returns: boolean
      }
      find_open_sports_shadow_paper_positions: {
        Args: { p_limit: number }
        Returns: {
          all_in_cost_usd: number
          check_attempt_count: number
          chosen_venue: string
          contracts: number
          notional_tier_usd: number
          selected_side: string
          signal_id: string
          target_market_id: string
        }[]
      }
      find_pending_sports_shadow_signals: {
        Args: { p_limit: number; p_venue: string }
        Returns: {
          away_team: string
          bet_type: string
          created_at: string
          home_team: string
          id: string
          line: number
          missing_kalshi: boolean
          missing_pmus: boolean
          scheduled_start_at: string
          selected_side: string
          source_asset: string
          source_condition_id: string
          source_event_slug: string
          source_first_fill_at: string
          source_market_slug: string
          source_rules_description: string
          source_wallet: string
        }[]
      }
      find_unscheduled_sports_shadow_lifecycle_triggers: {
        Args: { p_limit: number }
        Returns: {
          detected_at: string
          id: string
          match_id: string
          signal_id: string
          source_fill_id: string
          source_ts: number
          venue: string
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
          condition_id: string
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
      get_pending_paper_buy_notification_trades: {
        Args: { p_limit?: number }
        Returns: {
          cash_after: number
          created_at: string
          event_key: string
          experiment_id: string
          experiment_name: string
          market_title: string
          notional: number
          outcome: string
          price: number
          shares: number
          source_ts: number
          trade_id: string
        }[]
      }
      get_sports_shadow_episode_outcomes: {
        Args: { p_epoch_id: string }
        Returns: {
          all_in_cost_usd: number
          bet_type: string
          chosen_venue: string
          cluster_key: string
          contracts: number
          detection_latency_ms: number
          fee_usd: number
          fill_status: string
          fire_at: string
          gross_pnl_usd: number
          kalshi_result: Json
          net_pnl_usd: number
          notional_tier_usd: number
          observed_at: string
          pmus_result: Json
          reject_reason: string
          routing_timestamp: string
          scheduled_start_at: string
          settlement_status: string
          signal_created_at: string
          signal_id: string
          source_wallet: string
          spread: number
          total_fees_usd: number
          vwap: number
        }[]
      }
      get_sports_shadow_epoch_counters: {
        Args: { p_epoch_id: string }
        Returns: {
          calibration_independent_settled_count: number
          independent_episode_count: number
          oos_independent_settled_count: number
          raw_episode_count: number
          rejected_count: number
          settled_count: number
          settled_independent_count: number
        }[]
      }
      get_sports_shadow_soak_telemetry_rollup: {
        Args: { p_epoch_id: string; p_since: string }
        Returns: {
          actual_cycle_count: number
          kalshi_discovery_attempted_cycles: number
          kalshi_discovery_failed_count: number
          lease_lost_count: number
          observation_backlog_total: number
          observation_captured_total: number
          observation_failed_total: number
          pmus_discovery_attempted_cycles: number
          pmus_discovery_failed_count: number
          source_lane_acquired_cycles: number
          source_lease_skipped_count: number
          source_starved_cycles: number
          total_cycle_errors: number
        }[]
      }
      has_role: {
        Args: {
          _role: Database["public"]["Enums"]["app_role"]
          _user_id: string
        }
        Returns: boolean
      }
      insert_sports_shadow_episode: {
        Args: {
          p_away_team: string
          p_bet_type: string
          p_cluster_key?: string
          p_episode_key: string
          p_experiment_epoch_id?: string
          p_fill_id: string
          p_home_team: string
          p_league: string
          p_line: number
          p_scheduled_start_at: string
          p_selected_side: string
          p_source_asset: string
          p_source_condition_id: string
          p_source_event_slug: string
          p_source_fill_count: number
          p_source_first_fill_at: string
          p_source_handle: string
          p_source_last_fill_at: string
          p_source_market_slug: string
          p_source_notional: number
          p_source_outcome: string
          p_source_rules_description?: string
          p_source_sell_seen: boolean
          p_source_shares: number
          p_source_vwap: number
          p_source_wallet: string
        }
        Returns: string
      }
      paper_trade_decision_stats: {
        Args: { p_experiment_id: string }
        Returns: Json
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
      record_http_rate_limit: {
        Args: { p_blocked_until: string; p_host: string; p_reason: string }
        Returns: undefined
      }
      record_pre_epoch_sell: {
        Args: {
          p_fill_id: string
          p_notional: number
          p_price: number
          p_shares: number
          p_source_ts: number
        }
        Returns: undefined
      }
      record_sports_shadow_lifecycle_trigger: {
        Args: {
          p_add_fraction: number
          p_exit_fraction: number
          p_price: number
          p_signal_id: string
          p_source_fill_id: string
          p_source_ts: number
          p_tracked_shares: number
          p_trigger_type: string
        }
        Returns: string
      }
      record_sports_shadow_routing_provenance_ladder: {
        Args: {
          p_fire_at: string
          p_observation_id: string
          p_requested_delay_ms: number
          p_signal_id: string
          p_trigger_source_fill_id?: string
          p_venue: string
        }
        Returns: {
          decided_at: string
          fire_at: string
          kalshi_observation_id: string
          notional_tier_usd: number
          pmus_observation_id: string
        }[]
      }
      release_reconcile_lease: {
        Args: { p_holder: string; p_wallet: string }
        Returns: undefined
      }
      renew_sports_shadow_lease: {
        Args: {
          p_fence: number
          p_id: string
          p_lease_seconds: number
          p_worker_id: string
        }
        Returns: boolean
      }
      reserve_http_request_slot: {
        Args: { p_host: string; p_min_interval_ms: number }
        Returns: string
      }
      try_acquire_reconcile_lease: {
        Args: { p_holder: string; p_seconds: number; p_wallet: string }
        Returns: boolean
      }
      update_live_pilot_intent_status_atomic: {
        Args: { p_fields: Json; p_intent_id: string; p_new_status: string }
        Returns: Json
      }
      update_sports_shadow_episode: {
        Args: {
          p_fill_id: string
          p_lifecycle_trigger_add_fraction?: number
          p_lifecycle_trigger_exit_fraction?: number
          p_lifecycle_trigger_price?: number
          p_lifecycle_trigger_source_ts?: number
          p_lifecycle_trigger_tracked_shares?: number
          p_lifecycle_trigger_type?: string
          p_sell_event_notional?: number
          p_sell_event_price?: number
          p_sell_event_shares?: number
          p_sell_event_source_ts?: number
          p_sell_event_untracked_shares?: number
          p_signal_id: string
          p_source_fill_count: number
          p_source_first_fill_at: string
          p_source_last_fill_at: string
          p_source_notional: number
          p_source_sell_notional?: number
          p_source_sell_seen: boolean
          p_source_sell_shares?: number
          p_source_shares: number
          p_source_vwap: number
          p_untracked_sell_notional?: number
          p_untracked_sell_shares?: number
        }
        Returns: undefined
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
