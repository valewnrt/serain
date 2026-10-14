/**
 * Missions (D63, building block B): what runs over days. A goal the owner set
 * in a clean turn, a history of notes and a next check via the scheduler.
 * What a woken turn does goes through the same registry as everything else: a
 * mission grants no rights, it only remembers the state.
 */

export type MissionStatus = "active" | "done" | "cancelled";

export interface Mission {
  id: string;
  title: string;
  /** What should be achieved, written in a clean turn on a message from the owner. */
  goal: string;
  status: MissionStatus;
  outcome: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface MissionNote {
  at: string;
  text: string;
  /** Untrusted content the writing turn had seen (D8.4). Empty means clean. */
  taintSources: string[];
  /** Origin of the writing turn. */
  origin: string;
}

export interface MissionStore {
  create(input: { title: string; goal: string }): Promise<Mission>;
  /** All open ones, oldest first. */
  active(): Promise<Mission[]>;
  get(id: string): Promise<Mission | null>;
  /** The last `limit` notes, oldest first. */
  notes(id: string, limit: number): Promise<MissionNote[]>;
  addNote(id: string, note: { text: string; taintSources: readonly string[]; origin: string }): Promise<void>;
  /** Closes an open mission. False if it was not open (anymore). */
  close(id: string, status: Exclude<MissionStatus, "active">, outcome: string): Promise<boolean>;
  /** Hard delete, notes included (W7). False if the mission did not exist. */
  remove(id: string): Promise<boolean>;
}
