import { db } from "./client.js";
import type { Mission, MissionNote, MissionStore } from "../missions/types.js";

/**
 * `missions` and `mission_notes` from 0033_missions.sql. Via PostgREST: read
 * at startup and on a tool call or wake, never on the tick (addendum D50 of
 * 2026-10-11).
 */

const COLUMNS = "id, title, goal, status, outcome, created_at, updated_at";

interface DbMission {
  id: string;
  title: string;
  goal: string;
  status: Mission["status"];
  outcome: string | null;
  created_at: string;
  updated_at: string;
}

function toMission(row: DbMission): Mission {
  return {
    id: row.id,
    title: row.title,
    goal: row.goal,
    status: row.status,
    outcome: row.outcome,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export const missionStore: MissionStore = {
  async create(input) {
    const { data, error } = await db.from("missions").insert({ title: input.title, goal: input.goal }).select(COLUMNS).single();
    if (error) throw new Error(`Mission not created: ${error.message}`);
    return toMission(data as DbMission);
  },

  async active() {
    const { data, error } = await db.from("missions").select(COLUMNS).eq("status", "active").order("created_at", { ascending: true });
    if (error) throw new Error(`Missions not readable: ${error.message}`);
    return ((data ?? []) as DbMission[]).map(toMission);
  },

  async get(id) {
    const { data, error } = await db.from("missions").select(COLUMNS).eq("id", id).maybeSingle();
    if (error) throw new Error(`Mission not readable: ${error.message}`);
    return data ? toMission(data as DbMission) : null;
  },

  async notes(id, limit) {
    const { data, error } = await db
      .from("mission_notes")
      .select("at, text, taint_sources, origin")
      .eq("mission_id", id)
      .order("at", { ascending: false })
      .limit(limit);
    if (error) throw new Error(`Mission notes not readable: ${error.message}`);
    return ((data ?? []) as Array<{ at: string; text: string; taint_sources: string[] | null; origin: string }>)
      .map((row): MissionNote => ({ at: row.at, text: row.text, taintSources: row.taint_sources ?? [], origin: row.origin }))
      .reverse();
  },

  async addNote(id, note) {
    const { error } = await db.from("mission_notes").insert({ mission_id: id, text: note.text, taint_sources: [...note.taintSources], origin: note.origin });
    if (error) throw new Error(`Note not saved: ${error.message}`);
    const { error: touched } = await db.from("missions").update({ updated_at: new Date().toISOString() }).eq("id", id);
    if (touched) throw new Error(`Mission not updated: ${touched.message}`);
  },

  async close(id, status, outcome) {
    const now = new Date().toISOString();
    const { data, error } = await db
      .from("missions")
      .update({ status, outcome, closed_at: now, updated_at: now })
      .eq("id", id)
      .eq("status", "active")
      .select("id");
    if (error) throw new Error(`Mission not closed: ${error.message}`);
    return (data ?? []).length > 0;
  },

  async remove(id) {
    const { data, error } = await db.from("missions").delete().eq("id", id).select("id");
    if (error) throw new Error(`Mission not deleted: ${error.message}`);
    return (data ?? []).length > 0;
  },
};
