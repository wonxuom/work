export type Plan = {
  id: number;
  date: string;
  priority: "Must" | "Should" | "Could";
  content: string;
  memo: string;
  completed: boolean;
};

export type DayActivity = {
  date: string;
  total: number;
  completed: number;
};

export type CheckItem = { id: number; content: string; completed: boolean };
/** A task checklist item; a due date puts it on that day's todo list. */
export type TaskItem = CheckItem & { due_date: string | null };
export type Task = {
  id: number;
  title: string;
  goal: string;
  completed: boolean;
  items: TaskItem[];
};

/** One row of a day's manual order; a day mixes its own plans with task items due that day. */
export type DayOrderEntry = { kind: "plan" | "task_item"; item_id: number };
