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
          id: string
          kind: string
          level: string
          message: string
        }
        Insert: {
          acknowledged?: boolean
          context?: Json | null
          created_at?: string
          id?: string
          kind: string
          level?: string
          message: string
        }
        Update: {
          acknowledged?: boolean
          context?: Json | null
          created_at?: string
          id?: string
          kind?: string
          level?: string
          message?: string
        }
        Relationships: []
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
          created_at: string
          enabled: boolean
          follow_from_ts: number | null
          id: string
          name: string
          poll_interval_seconds: number
          realized_pnl: number
          simulated: boolean
          starting_cash: number
          updated_at: string
          wallet_address: string
          weather_only: boolean
        }
        Insert: {
          buy_amount?: number
          cash?: number
          created_at?: string
          enabled?: boolean
          follow_from_ts?: number | null
          id?: string
          name: string
          poll_interval_seconds?: number
          realized_pnl?: number
          simulated?: boolean
          starting_cash?: number
          updated_at?: string
          wallet_address: string
          weather_only?: boolean
        }
        Update: {
          buy_amount?: number
          cash?: number
          created_at?: string
          enabled?: boolean
          follow_from_ts?: number | null
          id?: string
          name?: string
          poll_interval_seconds?: number
          realized_pnl?: number
          simulated?: boolean
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
          last_success_at: string | null
          lease_expires_at: string | null
          poll_failures: number
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
          last_success_at?: string | null
          lease_expires_at?: string | null
          poll_failures?: number
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
          last_success_at?: string | null
          lease_expires_at?: string | null
          poll_failures?: number
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
  public: {
    Enums: {},
  },
} as const
