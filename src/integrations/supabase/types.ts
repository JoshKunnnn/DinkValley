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
    PostgrestVersion: "14.5"
  }
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
      categories: {
        Row: {
          category_slug: string
          created_at: string | null
          division: string
          entry_fee: string | null
          id: string
          label: string
          level: string
          tournament_id: string
        }
        Insert: {
          category_slug: string
          created_at?: string | null
          division: string
          entry_fee?: string | null
          id?: string
          label: string
          level: string
          tournament_id: string
        }
        Update: {
          category_slug?: string
          created_at?: string | null
          division?: string
          entry_fee?: string | null
          id?: string
          label?: string
          level?: string
          tournament_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "categories_tournament_id_fkey"
            columns: ["tournament_id"]
            isOneToOne: false
            referencedRelation: "tournaments"
            referencedColumns: ["id"]
          },
        ]
      }
      court_stations: {
        Row: {
          assigned_umpire: string | null
          court_name: string
          current_match_id: string | null
          dispatched_at: string | null
          maintenance_note: string | null
          on_deck_match_id: string | null
          status: string
          tournament_id: string | null
          updated_at: string | null
        }
        Insert: {
          assigned_umpire?: string | null
          court_name: string
          current_match_id?: string | null
          dispatched_at?: string | null
          maintenance_note?: string | null
          on_deck_match_id?: string | null
          status?: string
          tournament_id?: string | null
          updated_at?: string | null
        }
        Update: {
          assigned_umpire?: string | null
          court_name?: string
          current_match_id?: string | null
          dispatched_at?: string | null
          maintenance_note?: string | null
          on_deck_match_id?: string | null
          status?: string
          tournament_id?: string | null
          updated_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "court_stations_tournament_id_fkey"
            columns: ["tournament_id"]
            isOneToOne: false
            referencedRelation: "tournaments"
            referencedColumns: ["id"]
          },
        ]
      }
      matches: {
        Row: {
          category_id: string | null
          court: string
          created_at: string | null
          ended_at: string | null
          id: string
          match_type: string
          officiated_by: string | null
          rallies: Json | null
          server_number: number
          serving_team: string
          stage: string
          started_at: string | null
          status: string
          team_a_id: string | null
          team_a_name: string
          team_a_players: string[] | null
          team_a_score: number
          team_b_id: string | null
          team_b_name: string
          team_b_players: string[] | null
          team_b_score: number
          tournament_id: string | null
          tournament_slug: string | null
          updated_at: string | null
          winner_team: string | null
        }
        Insert: {
          category_id?: string | null
          court?: string
          created_at?: string | null
          ended_at?: string | null
          id: string
          match_type?: string
          officiated_by?: string | null
          rallies?: Json | null
          server_number?: number
          serving_team?: string
          stage?: string
          started_at?: string | null
          status?: string
          team_a_id?: string | null
          team_a_name: string
          team_a_players?: string[] | null
          team_a_score?: number
          team_b_id?: string | null
          team_b_name: string
          team_b_players?: string[] | null
          team_b_score?: number
          tournament_id?: string | null
          tournament_slug?: string | null
          updated_at?: string | null
          winner_team?: string | null
        }
        Update: {
          category_id?: string | null
          court?: string
          created_at?: string | null
          ended_at?: string | null
          id?: string
          match_type?: string
          officiated_by?: string | null
          rallies?: Json | null
          server_number?: number
          serving_team?: string
          stage?: string
          started_at?: string | null
          status?: string
          team_a_id?: string | null
          team_a_name?: string
          team_a_players?: string[] | null
          team_a_score?: number
          team_b_id?: string | null
          team_b_name?: string
          team_b_players?: string[] | null
          team_b_score?: number
          tournament_id?: string | null
          tournament_slug?: string | null
          updated_at?: string | null
          winner_team?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "matches_category_id_fkey"
            columns: ["category_id"]
            isOneToOne: false
            referencedRelation: "categories"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "matches_team_a_id_fkey"
            columns: ["team_a_id"]
            isOneToOne: false
            referencedRelation: "teams"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "matches_team_b_id_fkey"
            columns: ["team_b_id"]
            isOneToOne: false
            referencedRelation: "teams"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "matches_tournament_id_fkey"
            columns: ["tournament_id"]
            isOneToOne: false
            referencedRelation: "tournaments"
            referencedColumns: ["id"]
          },
        ]
      }
      profiles: {
        Row: {
          created_at: string | null
          email: string | null
          id: string
          name: string | null
          role: string
        }
        Insert: {
          created_at?: string | null
          email?: string | null
          id?: string
          name?: string | null
          role?: string
        }
        Update: {
          created_at?: string | null
          email?: string | null
          id?: string
          name?: string | null
          role?: string
        }
        Relationships: []
      }
      teams: {
        Row: {
          category_id: string
          club: string | null
          created_at: string | null
          id: string
          name: string
          paid: boolean | null
          payment_proof_url: string | null
          payment_ref: string | null
          payment_status: string | null
          players: string[]
          tournament_id: string
        }
        Insert: {
          category_id: string
          club?: string | null
          created_at?: string | null
          id?: string
          name: string
          paid?: boolean | null
          payment_proof_url?: string | null
          payment_ref?: string | null
          payment_status?: string | null
          players?: string[]
          tournament_id: string
        }
        Update: {
          category_id?: string
          club?: string | null
          created_at?: string | null
          id?: string
          name?: string
          paid?: boolean | null
          payment_proof_url?: string | null
          payment_ref?: string | null
          payment_status?: string | null
          players?: string[]
          tournament_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "teams_category_id_fkey"
            columns: ["category_id"]
            isOneToOne: false
            referencedRelation: "categories"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "teams_tournament_id_fkey"
            columns: ["tournament_id"]
            isOneToOne: false
            referencedRelation: "tournaments"
            referencedColumns: ["id"]
          },
        ]
      }
      tournaments: {
        Row: {
          city: string | null
          created_at: string | null
          date: string | null
          entry_fee: string | null
          format: string | null
          id: string
          name: string
          rules: Json | null
          schedule: Json | null
          slug: string
          status: string
          tagline: string | null
          updated_at: string | null
          venue: string | null
        }
        Insert: {
          city?: string | null
          created_at?: string | null
          date?: string | null
          entry_fee?: string | null
          format?: string | null
          id?: string
          name: string
          rules?: Json | null
          schedule?: Json | null
          slug: string
          status?: string
          tagline?: string | null
          updated_at?: string | null
          venue?: string | null
        }
        Update: {
          city?: string | null
          created_at?: string | null
          date?: string | null
          entry_fee?: string | null
          format?: string | null
          id?: string
          name?: string
          rules?: Json | null
          schedule?: Json | null
          slug?: string
          status?: string
          tagline?: string | null
          updated_at?: string | null
          venue?: string | null
        }
        Relationships: []
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      [_ in never]: never
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
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never) = never,
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
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
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
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
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
  EnumName extends (DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never) = never,
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
  CompositeTypeName extends (PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never) = never,
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