import { invoke } from "@tauri-apps/api/core";
import type { Note, Plan, Settings, Summary } from "./types";
export const api = {
  listNotes: (query = "") => invoke<Note[]>("list_notes", { query }),
  createNote: (content: string) => invoke<Note>("create_note", { content }),
  updateNote: (id: number, content: string, tags: string[]) => invoke<Note>("update_note", { id, content, tags }),
  deleteNote: (id: number) => invoke<void>("delete_note", { id }),
  listPlans: (date?: string) => invoke<Plan[]>("list_plans", { date }),
  createPlan: (priority: Plan["priority"], content: string) => invoke<Plan>("create_plan", { priority, content }),
  updatePlan: (id: number, content: string, memo: string) => invoke<Plan>("update_plan", { id, content, memo }),
  togglePlan: (id: number, completed: boolean) => invoke<void>("toggle_plan", { id, completed }),
  deletePlan: (id: number) => invoke<void>("delete_plan", { id }),
  dailySummary: (date?: string) => invoke<Summary>("daily_summary", { date }),
  weeklySummary: () => invoke<string[]>("weekly_summary"),
  getSettings: () => invoke<Settings>("get_settings"),
  saveSettings: (settings: Settings) => invoke<void>("save_settings", { settings }),
};
