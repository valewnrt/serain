import type { Mission, MissionNote, MissionStore } from "../src/missions/types.js";

/** `missions` and `mission_notes` in memory, with the same rules as the tables. */
export class FakeMissionStore implements MissionStore {
  missions: Mission[] = [];
  notesOf = new Map<string, MissionNote[]>();
  private seq = 0;

  async create(input: { title: string; goal: string }): Promise<Mission> {
    const mission: Mission = {
      id: `10000000-0000-4000-8000-${String(++this.seq).padStart(12, "0")}`,
      title: input.title,
      goal: input.goal,
      status: "active",
      outcome: null,
      createdAt: "2026-10-13T08:00:00.000Z",
      updatedAt: "2026-10-13T08:00:00.000Z",
    };
    this.missions.push(mission);
    return { ...mission };
  }
  async active() {
    return this.missions.filter((mission) => mission.status === "active");
  }
  async get(id: string) {
    return this.missions.find((mission) => mission.id === id) ?? null;
  }
  async notes(id: string, limit: number) {
    return (this.notesOf.get(id) ?? []).slice(-limit);
  }
  async addNote(id: string, note: { text: string; taintSources: readonly string[]; origin: string }) {
    const list = this.notesOf.get(id) ?? [];
    list.push({ at: `2026-10-13T09:${String(list.length).padStart(2, "0")}:00.000Z`, text: note.text, taintSources: [...note.taintSources], origin: note.origin });
    this.notesOf.set(id, list);
  }
  async close(id: string, status: "done" | "cancelled", outcome: string) {
    const mission = this.missions.find((entry) => entry.id === id && entry.status === "active");
    if (!mission) return false;
    mission.status = status;
    mission.outcome = outcome;
    return true;
  }
  async remove(id: string) {
    const before = this.missions.length;
    this.missions = this.missions.filter((mission) => mission.id !== id);
    this.notesOf.delete(id);
    return this.missions.length < before;
  }
}
