import { MouseEvent, ReactNode, useEffect, useRef, useState } from "react";
import { Menu } from "@tauri-apps/api/menu";
import { api } from "./api";
import { AddTask, IconButton, PlusIcon, TaskList, TrashIcon } from "./App";
import type { Task, TaskItem } from "./types";

const isDesktop = "__TAURI_INTERNALS__" in window;
const message = (error: unknown) => error instanceof Error ? error.message : String(error || "처리하지 못했습니다.");
const shortDate = (date: string) => Number(date.slice(5, 7)) + "/" + Number(date.slice(8));

export type TaskStore = ReturnType<typeof useTasks>;

/** Tasks are shared by the task tab and the today list, so both always show the same checklist state. */
export function useTasks({ onChange, onError }: { onChange: () => void; onError: (message: string) => void }) {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [loading, setLoading] = useState(true);
  const callbacks = useRef({ onChange, onError });
  callbacks.current = { onChange, onError };
  const request = useRef(0);

  const reload = async () => {
    if (!isDesktop) { setLoading(false); return; }
    const current = ++request.current;
    try {
      const next = await api.listTasks();
      if (current === request.current) setTasks(next);
    } catch (cause) { callbacks.current.onError(message(cause)); }
    finally { if (current === request.current) setLoading(false); }
  };
  useEffect(() => { void reload(); }, []);

  // Edits apply immediately and roll back by reloading. Creates wait for the database id so follow-up
  // edits target a real row, and rethrow so the input keeps its text for a retry.
  const mutate = async (remote: () => Promise<unknown>, local: (tasks: Task[]) => Task[], optimistic = true) => {
    if (!isDesktop || optimistic) setTasks(local);
    if (!isDesktop) return;
    try {
      await remote();
      await reload();
      callbacks.current.onChange();
    } catch (cause) {
      callbacks.current.onError(message(cause));
      await reload();
      if (!optimistic) throw cause;
    }
  };
  const mapItems = (tasks: Task[], map: (items: TaskItem[]) => TaskItem[]) => tasks.map((task) => ({ ...task, items: map(task.items) }));

  return {
    tasks,
    loading,
    createTask: (title: string) => mutate(() => api.createTask(title), (current) => [...current, { id: Date.now(), title, goal: "", completed: false, items: [] }], false),
    updateTask: (next: Task) => mutate(() => api.updateTask(next), (current) => current.map((task) => task.id === next.id ? { ...next, items: task.items } : task)),
    deleteTask: (id: number) => mutate(() => api.deleteTask(id), (current) => current.filter((task) => task.id !== id)),
    createItem: (taskId: number, content: string) => mutate(() => api.createTaskItem(taskId, content), (current) => current.map((task) => task.id === taskId ? { ...task, items: [...task.items, { id: Date.now(), content, completed: false, due_date: null }] } : task), false),
    updateItem: (next: TaskItem) => mutate(() => api.updateTaskItem(next), (current) => mapItems(current, (items) => items.map((item) => item.id === next.id ? next : item))),
    deleteItem: (id: number) => mutate(() => api.deleteTaskItem(id), (current) => mapItems(current, (items) => items.filter((item) => item.id !== id))),
  };
}

export default function TaskWorkspace({ compact, hidden, store, today }: { compact: boolean; hidden: boolean; store: TaskStore; today: string }) {
  // Expanded cards live here so they stay open when switching between the widget and the expanded workspace.
  const [openIds, setOpenIds] = useState<Set<number>>(() => new Set());
  const setOpen = (id: number, open: boolean) => setOpenIds((current) => {
    const next = new Set(current);
    if (open) next.add(id); else next.delete(id);
    return next;
  });
  const sorted = [...store.tasks].sort((a, b) => a.id - b.id);
  const active = sorted.filter((task) => !task.completed);
  const done = sorted.filter((task) => task.completed);
  const cards = (tasks: Task[], empty: ReactNode) => (
    <div className="task-board-list">
      {store.loading ? <div className="task-empty">불러오는 중…</div>
        : tasks.length ? tasks.map((task) => <TaskCard key={task.id} task={task} today={today} store={store} compact={compact} open={openIds.has(task.id)} onOpenChange={(open) => setOpen(task.id, open)} />)
        : empty}
    </div>
  );
  const activeEmpty = <div className="workspace-empty"><h2>큰 일부터 적어보세요.</h2><p>태스크를 입력하고 <b>+</b>로 할 일을 나눠보세요.<br />할 일을 우클릭하면 오늘 할 일로 올릴 수 있어요.</p></div>;
  const addTask = <AddTask onAdd={store.createTask} placeholder="새 태스크를 입력하세요" label="새 태스크" />;
  return (
    <section id="tasks-panel" role="tabpanel" aria-labelledby="tasks-tab" hidden={hidden} className={`task-workspace ${compact ? "compact" : ""}`}>
      {/* The widget is for doing work, so it lists only open tasks; finished ones are reviewed when expanded. */}
      {compact ? <div className="task-board">{cards(active, activeEmpty)}{addTask}</div> : (
        <div className="task-columns">
          <section className="task-column" aria-labelledby="active-tasks-heading">
            <div className="day-heading"><div><span>IN PROGRESS</span><h2 id="active-tasks-heading">진행 중</h2></div><strong>{active.length}</strong></div>
            {cards(active, activeEmpty)}
            {addTask}
          </section>
          <section className="task-column" aria-labelledby="done-tasks-heading">
            <div className="day-heading"><div><span>DONE</span><h2 id="done-tasks-heading">완료</h2></div><strong>{done.length}</strong></div>
            {cards(done, <div className="workspace-empty"><h2>완료한 태스크가 없어요.</h2><p>진행 중인 태스크를 펼쳐<br />‘태스크 완료’를 누르면 여기에 모여요.</p></div>)}
          </section>
        </div>
      )}
    </section>
  );
}

function TaskCard({ task, today, store, compact, open, onOpenChange: setOpen }: { task: Task; today: string; store: TaskStore; compact: boolean; open: boolean; onOpenChange: (open: boolean) => void }) {
  // The item input appears only after pressing +, so an expanded card reads as a plain checklist.
  const [adding, setAdding] = useState(false);
  const [title, setTitle] = useState(task.title);
  const [goal, setGoal] = useState(task.goal);
  const addInput = useRef<HTMLInputElement>(null);
  useEffect(() => setTitle(task.title), [task.title]);
  useEffect(() => setGoal(task.goal), [task.goal]);
  const done = task.items.filter((item) => item.completed).length;

  const saveTitle = () => {
    const next = title.trim();
    if (!next) setTitle(task.title);
    else if (next !== task.title) void store.updateTask({ ...task, title: next });
  };
  const saveGoal = () => {
    const next = goal.trim();
    if (next !== task.goal) void store.updateTask({ ...task, goal: next });
  };
  const addItem = () => {
    setOpen(true);
    setAdding(true);
    requestAnimationFrame(() => addInput.current?.focus());
  };
  // window.confirm always answers "no" in the Tauri macOS webview, so deleting a whole task asks with a second press.
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  useEffect(() => {
    if (!confirmingDelete) return;
    const timer = window.setTimeout(() => setConfirmingDelete(false), 3000);
    return () => window.clearTimeout(timer);
  }, [confirmingDelete]);
  const remove = () => {
    if (confirmingDelete) void store.deleteTask(task.id);
    else setConfirmingDelete(true);
  };
  // Row buttons squeezed the text, so scheduling and deleting a checklist item live in a native context menu.
  const showItemMenu = async (item: TaskItem, event: MouseEvent) => {
    event.preventDefault();
    if (!isDesktop) return;
    const scheduled = item.due_date === today;
    const menu = await Menu.new({ items: [
      { text: scheduled ? "오늘 할 일에서 빼기" : "오늘 할 일로 올리기", action: () => void store.updateItem({ ...item, due_date: scheduled ? null : today }) },
      { item: "Separator" },
      { text: "삭제", action: () => void store.deleteItem(item.id) },
    ] });
    await menu.popup();
  };

  return (
    <article className={["task-card", open ? "open" : "", task.completed ? "complete" : ""].filter(Boolean).join(" ")}>
      <div className="task-card-row">
        <button type="button" className="task-expand" onClick={() => { setOpen(!open); setAdding(false); }} aria-expanded={open} aria-label={open ? `${task.title} 접기` : `${task.title} 펼치기`} title={open ? "접기" : "펼치기"}><TriangleIcon up={open} /></button>
        <input value={title} onChange={(event) => setTitle(event.target.value)} onBlur={saveTitle} onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); }} aria-label="태스크 이름 수정" />
        <div className="task-card-tools">
          {task.items.length > 0 && <span className="task-count">{done}/{task.items.length}</span>}
          {/* A finished task is read back, not extended; reopen it with 완료 취소 to add more. */}
          {!task.completed && <IconButton label={`${task.title}에 할 일 추가`} onClick={addItem}><PlusIcon /></IconButton>}
        </div>
      </div>
      {open && (
        <div className="task-card-body">
          {task.goal && <input className="task-goal" value={goal} onChange={(event) => setGoal(event.target.value)} onBlur={saveGoal} onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); }} aria-label="목표 메모" />}
          {task.items.length > 0 && (
            <TaskList
              plans={task.items}
              onToggle={(item) => store.updateItem({ ...item, completed: !item.completed })}
              onUpdate={(item, content) => store.updateItem({ ...item, content })}
              onContextMenu={(item, event) => void showItemMenu(item, event)}
              renderActions={(item) => item.due_date && <TodayToggle item={item} today={today} onChange={(due_date) => void store.updateItem({ ...item, due_date })} />}
            />
          )}
          {!task.completed && (adding || task.items.length === 0) && <AddTask onAdd={(content) => { setAdding(true); return store.createItem(task.id, content); }} placeholder="할 일을 입력하세요" label={`${task.title} 할 일`} inputRef={addInput} onDismiss={() => setAdding(false)} />}
          {/* Finishing or deleting a task is a deliberate review step, so both live only in the expanded workspace. */}
          {!compact && <div className="task-card-footer">
            <button className="text-button" onClick={() => void store.updateTask({ ...task, completed: !task.completed })}>{task.completed ? "완료 취소" : "태스크 완료"}</button>
            <button className="text-button danger" onClick={remove}><TrashIcon /> {confirmingDelete ? "한 번 더 누르면 삭제" : "태스크 삭제"}</button>
          </div>}
        </div>
      )}
    </article>
  );
}

/** Badge for a scheduled checklist item: "오늘" removes it from today, an older date moves it to today. */
function TodayToggle({ item, today, onChange }: { item: TaskItem; today: string; onChange: (due: string | null) => void }) {
  const scheduled = item.due_date === today;
  const date = shortDate(item.due_date ?? today);
  const label = scheduled ? "오늘 할 일에서 빼기" : `${date} 할 일을 오늘로 옮기기`;
  return (
    <button type="button" className={`today-chip ${scheduled ? "today" : "dated"}`} onClick={() => onChange(scheduled ? null : today)} aria-pressed={scheduled} aria-label={label} title={label}>
      {scheduled ? "오늘" : date}
    </button>
  );
}

const TriangleIcon = ({ up }: { up: boolean }) => <svg viewBox="0 0 12 12" aria-hidden="true"><path d={up ? "M2.5 8h7L6 3.5z" : "M2.5 4h7L6 8.5z"} /></svg>;
