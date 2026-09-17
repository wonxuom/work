import { invoke } from "@tauri-apps/api/core";
import type { DayActivity, DayOrderEntry, Plan, Task, TaskItem } from "./types";
export const api = {
  listTasks: () => invoke<Task[]>("list_tasks"),
  createTask: (title: string, goal = "") => invoke<number>("create_task", { title, goal }),
  updateTask: (task: Task) => invoke<void>("update_task", { id: task.id, title: task.title, goal: task.goal, completed: task.completed }),
  deleteTask: (id: number) => invoke<void>("delete_task", { id }),
  createTaskItem: (taskId: number, content: string) => invoke<void>("create_task_item", { taskId, content }),
  updateTaskItem: (item: TaskItem) => invoke<void>("update_task_item", { id: item.id, content: item.content, completed: item.completed, dueDate: item.due_date }),
  deleteTaskItem: (id: number) => invoke<void>("delete_task_item", { id }),
  listPlans: (date: string) => invoke<Plan[]>("list_plans", { date }),
  createPlan: (content: string, date: string) => invoke<Plan>("create_plan", { priority: "Must", content, date }),
  updatePlan: (id: number, content: string, memo: string) => invoke<Plan>("update_plan", { id, content, memo }),
  togglePlan: (id: number, completed: boolean) => invoke<void>("toggle_plan", { id, completed }),
  deletePlan: (id: number) => invoke<void>("delete_plan", { id }),
  listDayOrder: (date: string) => invoke<DayOrderEntry[]>("list_day_order", { date }),
  setDayOrder: (date: string, entries: DayOrderEntry[]) => invoke<void>("set_day_order", { date, entries }),
  planActivity: (month: string) => invoke<DayActivity[]>("plan_activity", { month }),
  getShortcut: () => invoke<{ shortcut: string }>("get_settings").then((settings) => settings.shortcut),
};
