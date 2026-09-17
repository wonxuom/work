import { CSSProperties, FormEvent, MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent, ReactNode, Ref, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { LogicalSize, PhysicalPosition } from "@tauri-apps/api/dpi";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { isRegistered, register, ShortcutEvent, unregister } from "@tauri-apps/plugin-global-shortcut";
import { api } from "./api";
import TaskWorkspace, { TaskStore, useTasks } from "./TaskWorkspace";
import type { CheckItem, DayActivity, DayOrderEntry, Plan, TaskItem } from "./types";

const isDesktop = "__TAURI_INTERNALS__" in window;
const widgetSize = new LogicalSize(404, 592);
const trackerSize = new LogicalSize(1000, 740);

const dateKey = (date: Date) =>
  date.getFullYear() + "-" + String(date.getMonth() + 1).padStart(2, "0") + "-" + String(date.getDate()).padStart(2, "0");
const monthKey = (date: Date) => dateKey(date).slice(0, 7);
const formatDate = (date: string, options: Intl.DateTimeFormatOptions) =>
  new Intl.DateTimeFormat("ko-KR", options).format(new Date(date + "T00:00:00"));
const message = (error: unknown) => error instanceof Error ? error.message : String(error || "처리하지 못했습니다.");
const titleDate = (date: string) => `${formatDate(date, { month: "long", day: "numeric" })} (${formatDate(date, { weekday: "short" })})`;

// Shortcut calls run one at a time: a dev re-mount or webview reload must release the previous
// registration before registering again, or macOS rejects the duplicate hotkey.
let shortcutQueue: Promise<void> = Promise.resolve();
const queueShortcut = (task: () => Promise<void>) => { shortcutQueue = shortcutQueue.then(task); };

/** A task checklist item scheduled for the selected day, shown alongside that day's plans. */
type DueItem = TaskItem & { taskTitle: string };
const toTaskItem = ({ taskTitle: _, ...item }: DueItem): TaskItem => item;

export default function App() {
  const [today, setToday] = useState(() => dateKey(new Date()));
  const [selectedDate, setSelectedDate] = useState(today);
  const [cursor, setCursor] = useState(() => new Date());
  const [plans, setPlans] = useState<Plan[]>([]);
  const [order, setOrder] = useState<DayOrderEntry[]>([]);
  const [activity, setActivity] = useState<DayActivity[]>([]);
  const [expanded, setExpanded] = useState(false);
  const [section, setSection] = useState<"today" | "tasks">("today");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [backgroundEnabled, setBackgroundEnabled] = useState(() =>
    localStorage.getItem("trace-background-enabled") !== "false");
  const widgetPosition = useRef<PhysicalPosition | null>(null);
  const expandedRef = useRef(false);

  useEffect(() => {
    localStorage.setItem("trace-background-enabled", String(backgroundEnabled));
    if (!isDesktop) return;
    let disposed = false;
    const reduced = window.matchMedia("(prefers-reduced-transparency: reduce)");
    const apply = () => {
      const enabled = backgroundEnabled && !reduced.matches;
      if (!enabled) document.documentElement.dataset.translucent = "false";
      void invoke<boolean>("set_window_blur", { enabled, expanded }).then((applied) => {
        if (!disposed) document.documentElement.dataset.translucent = String(applied);
      }).catch((cause) => {
        if (disposed) return;
        document.documentElement.dataset.translucent = "false";
        setError(message(cause));
      });
    };
    apply();
    reduced.addEventListener("change", apply);
    return () => { disposed = true; reduced.removeEventListener("change", apply); };
  }, [expanded, backgroundEnabled]);

  const loadPlans = async (date = selectedDate) => {
    if (!isDesktop) {
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const [nextPlans, nextOrder] = await Promise.all([api.listPlans(date), api.listDayOrder(date)]);
      setPlans(nextPlans.filter((plan) => plan.id !== pendingRemoval.current?.plan.id));
      setOrder(nextOrder);
      setError("");
    } catch (cause) {
      setError(message(cause));
    } finally {
      setLoading(false);
    }
  };

  const loadActivity = async (month = cursor) => {
    if (!isDesktop) return;
    try {
      setActivity(await api.planActivity(monthKey(month)));
    } catch (cause) {
      setError(message(cause));
    }
  };

  const tasks = useTasks({ onChange: () => void loadActivity(cursor), onError: setError });
  const dueItems = tasks.tasks.flatMap((task) => task.items
    .filter((item) => item.due_date === selectedDate)
    .map((item) => ({ ...item, taskTitle: task.title })));
  const due: DayProps = {
    dueItems,
    order,
    onReorder: (entries) => {
      setOrder(entries);
      if (isDesktop) api.setDayOrder(selectedDate, entries).catch((cause) => setError(message(cause)));
    },
    onToggleDue: (item) => tasks.updateItem({ ...toTaskItem(item), completed: !item.completed }),
    onUpdateDue: (item, content) => tasks.updateItem({ ...toTaskItem(item), content }),
    onUnscheduleDue: (item) => tasks.updateItem({ ...toTaskItem(item), due_date: null }),
  };

  useEffect(() => { void loadPlans(selectedDate); }, [selectedDate]);
  useEffect(() => { if (expanded) void loadActivity(cursor); }, [cursor, expanded]);

  useEffect(() => {
    let timer = 0;
    const updateDate = () => {
      const next = dateKey(new Date());
      setToday((current) => {
        if (current !== next && !expandedRef.current) setSelectedDate(next);
        return next;
      });
    };
    const scheduleMidnight = () => {
      updateDate();
      const now = new Date();
      const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
      timer = window.setTimeout(scheduleMidnight, midnight.getTime() - now.getTime() + 1000);
    };
    scheduleMidnight();
    window.addEventListener("focus", updateDate);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("focus", updateDate);
    };
  }, []);

  useEffect(() => {
    if (!isDesktop) return;
    const appWindow = getCurrentWindow();
    const saved = localStorage.getItem("trace-widget-position");
    if (saved) {
      try {
        const { x, y } = JSON.parse(saved);
        if (Number.isFinite(x) && Number.isFinite(y)) void appWindow.setPosition(new PhysicalPosition(x, y));
      } catch { localStorage.removeItem("trace-widget-position"); }
    }
    const moved = appWindow.onMoved(({ payload }) => {
      if (!expandedRef.current) localStorage.setItem("trace-widget-position", JSON.stringify(payload));
    });
    let disposed = false;
    let registered = "";
    queueShortcut(async () => {
      if (disposed) return;
      try {
        const shortcut = await api.getShortcut();
        // The native plugin keeps registrations from a previous page load of this same window.
        if (await isRegistered(shortcut)) await unregister(shortcut);
        await register(shortcut, (event: ShortcutEvent) => {
          if (event.state === "Pressed") void appWindow.show().then(() => appWindow.setFocus());
        });
        registered = shortcut;
      } catch (cause) {
        setError(message(cause).includes("RegisterEventHotKey")
          ? "전역 단축키를 다른 앱이 사용 중이라 등록하지 못했어요. 설치된 Trace가 함께 실행 중인지 확인하세요."
          : message(cause));
      }
    });
    return () => {
      disposed = true;
      void moved.then((stop) => stop());
      queueShortcut(async () => { if (registered) await unregister(registered).catch(() => undefined); });
    };
  }, []);

  const changeMode = async (next: boolean) => {
    expandedRef.current = next;
    setExpanded(next);
    if (!isDesktop) return;
    const appWindow = getCurrentWindow();
    try {
      if (next) {
        widgetPosition.current = await appWindow.outerPosition();
        await appWindow.setSize(trackerSize);
        await appWindow.center();
        setSelectedDate(today);
        setCursor(new Date(today + "T00:00:00"));
      } else {
        await appWindow.setSize(widgetSize);
        if (widgetPosition.current) await appWindow.setPosition(widgetPosition.current);
        setSelectedDate(today);
      }
    } catch (cause) {
      setError(message(cause));
    }
  };

  const addPlan = async (content: string) => {
    if (!isDesktop) {
      setPlans((current) => [...current, { id: Date.now(), date: selectedDate, priority: "Must", content, memo: "", completed: false }]);
      return;
    }
    try {
      await api.createPlan(content, selectedDate);
      await Promise.all([loadPlans(selectedDate), loadActivity(cursor)]);
    } catch (cause) { setError(message(cause)); throw cause; }
  };
  const togglePlan = async (plan: Plan) => {
    setPlans((current) => current.map((item) => item.id === plan.id ? { ...item, completed: !item.completed } : item));
    if (isDesktop) {
      try { await api.togglePlan(plan.id, !plan.completed); await loadActivity(cursor); }
      catch (cause) { setError(message(cause)); await loadPlans(selectedDate); }
    }
  };
  const updatePlan = async (plan: Plan, content: string) => {
    setPlans((current) => current.map((item) => item.id === plan.id ? { ...item, content } : item));
    if (isDesktop) {
      try { await api.updatePlan(plan.id, content, plan.memo); }
      catch (cause) { setError(message(cause)); await loadPlans(selectedDate); }
    }
  };
  // The hover delete button is easy to hit and confirm dialogs do not work in the webview, so a deleted
  // plan stays restorable for a few seconds before it is removed from the database.
  const [removed, setRemoved] = useState<Plan | null>(null);
  const pendingRemoval = useRef<{ plan: Plan; timer: number } | null>(null);
  const commitRemoval = () => {
    const pending = pendingRemoval.current;
    if (!pending) return;
    window.clearTimeout(pending.timer);
    pendingRemoval.current = null;
    setRemoved(null);
    if (isDesktop) api.deletePlan(pending.plan.id).then(() => loadActivity(cursor)).catch((cause) => {
      setError(message(cause));
      void loadPlans(selectedDate);
    });
  };
  const deletePlan = async (plan: Plan) => {
    commitRemoval();
    setPlans((current) => current.filter((item) => item.id !== plan.id));
    pendingRemoval.current = { plan, timer: window.setTimeout(commitRemoval, 5000) };
    setRemoved(plan);
  };
  const undoRemoval = () => {
    const pending = pendingRemoval.current;
    if (!pending) return;
    window.clearTimeout(pending.timer);
    pendingRemoval.current = null;
    setRemoved(null);
    if (pending.plan.date === selectedDate) setPlans((current) => [...current, pending.plan].sort((a, b) => a.id - b.id));
  };
  const removalNotice = removed && (
    <div className="undo-toast" role="status">
      <span>할 일을 삭제했어요</span>
      <button type="button" onClick={undoRemoval}>실행 취소</button>
    </div>
  );

  const startDragging = (event: React.MouseEvent<HTMLElement>) => {
    if (!isDesktop || event.button !== 0 || (event.target as HTMLElement).closest("button, input, .appearance-menu")) return;
    event.preventDefault();
    void getCurrentWindow().startDragging();
  };
  const hide = () => { if (isDesktop) void getCurrentWindow().hide(); };

  return (
    <main className={expanded ? "tracker" : "daily-widget"} aria-label="Trace 업무 관리">
      <header className={expanded ? "tracker-header" : "widget-header"} data-tauri-drag-region onMouseDown={startDragging}>
        {expanded ? <div className="tracker-brand"><span /><b>Trace</b><small>Workspace</small></div> : (
          <h1>{section === "today" ? titleDate(today) : "TASK"}</h1>
        )}
        <div className={expanded ? "tracker-window-actions" : "window-actions"}>
          <AppearanceMenu backgroundEnabled={backgroundEnabled} onChange={setBackgroundEnabled} />
          {expanded ? <IconButton label="작게 보기" onClick={() => void changeMode(false)}><CollapseIcon /></IconButton> : (
            <>
              <IconButton label={section === "today" ? "캘린더로 확장" : "태스크 확장"} onClick={() => void changeMode(true)}><ExpandIcon /></IconButton>
              <IconButton label="숨기기" onClick={hide}><CloseIcon /></IconButton>
            </>
          )}
        </div>
      </header>
      <div className="view-navigation">
        <div className="view-tabs" role="tablist" aria-label="업무 보기">
          {(["today", "tasks"] as const).map((tab) => (
            <button type="button" role="tab" id={`${tab}-tab`} aria-selected={section === tab} aria-controls={`${tab}-panel`} tabIndex={section === tab ? 0 : -1} key={tab} onClick={() => setSection(tab)} onKeyDown={(event) => {
              if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
              event.preventDefault();
              const next = event.key === "Home" ? "today" : event.key === "End" ? "tasks" : tab === "today" ? "tasks" : "today";
              setSection(next);
              document.getElementById(`${next}-tab`)?.focus();
            }}>{tab === "today" ? "TODAY" : "TASK"}</button>
          ))}
        </div>
      </div>
      {error && <p className={expanded ? "tracker-error" : "inline-error"} role="alert">{error}</p>}
      <section className="today-panel" role="tabpanel" id="today-panel" aria-labelledby="today-tab" hidden={section !== "today"}>
        {expanded ? (
          <Calendar activity={activity} cursor={cursor} loading={loading} plans={plans} selectedDate={selectedDate} today={today} onAdd={addPlan} onCursor={setCursor} onDelete={deletePlan} onSelect={setSelectedDate} onToggle={togglePlan} onUpdate={updatePlan} notice={removalNotice} {...due} />
        ) : (
          <TodayList loading={loading || tasks.loading} plans={plans} onAdd={addPlan} onDelete={deletePlan} onToggle={togglePlan} onUpdate={updatePlan} notice={removalNotice} {...due} />
        )}
      </section>
      <TaskWorkspace compact={!expanded} hidden={section !== "tasks"} store={tasks} today={today} />
    </main>
  );
}

type RowHandlers<T extends CheckItem> = {
  onToggle: (plan: T) => Promise<void>;
  onUpdate: (plan: T, content: string) => Promise<void>;
};
type ListProps = RowHandlers<Plan> & {
  plans: Plan[];
  loading: boolean;
  onDelete: (plan: Plan) => Promise<void>;
};
type DayProps = {
  dueItems: DueItem[];
  order: DayOrderEntry[];
  onReorder: (entries: DayOrderEntry[]) => void;
  onToggleDue: (item: DueItem) => Promise<void>;
  onUpdateDue: (item: DueItem, content: string) => Promise<void>;
  onUnscheduleDue: (item: DueItem) => Promise<void>;
};
type DayRow = { entry: DayOrderEntry; plan: Plan; item?: never } | { entry: DayOrderEntry; item: DueItem; plan?: never };
const rowKey = ({ entry }: DayRow) => `${entry.kind}-${entry.item_id}`;

const dayProgress = (plans: CheckItem[], dueItems: CheckItem[]) => {
  const items = [...plans, ...dueItems];
  return { total: items.length, completed: items.filter((item) => item.completed).length };
};

function DayChecklist({ plans, loading, onToggle, onUpdate, onDelete, dueItems, order, onReorder, onToggleDue, onUpdateDue, onUnscheduleDue }: ListProps & DayProps) {
  if (loading) return <div className="task-empty">불러오는 중…</div>;
  const rows: DayRow[] = [
    ...plans.map((plan) => ({ entry: { kind: "plan" as const, item_id: plan.id }, plan })),
    ...dueItems.map((item) => ({ entry: { kind: "task_item" as const, item_id: item.id }, item })),
  ];
  if (!rows.length) return <div className="task-empty"><span><CheckIcon /></span><p>아직 할 일이 없어요.</p></div>;
  // Rows the user has not placed yet (new plans, newly scheduled task items) keep their default order at the end.
  const position = new Map(order.map((entry, index) => [`${entry.kind}-${entry.item_id}`, index]));
  const sorted = rows.map((row, index) => ({ row, rank: position.get(rowKey(row)) ?? order.length + index }))
    .sort((a, b) => a.rank - b.rank)
    .map(({ row }) => row);
  return (
    <ReorderList items={sorted} getKey={rowKey} onReorder={(next) => onReorder(next.map((row) => row.entry))} renderItem={(row, drag) => row.plan ? (
      <TaskRow key={rowKey(row)} plan={row.plan} drag={drag} onToggle={onToggle} onUpdate={onUpdate}
        actions={<IconButton className="row-action" label="할 일 삭제" onClick={() => void onDelete(row.plan)}><TrashIcon /></IconButton>} />
    ) : (
      <TaskRow key={rowKey(row)} plan={row.item} meta={row.item.taskTitle} drag={drag} onToggle={onToggleDue} onUpdate={onUpdateDue}
        actions={<IconButton className="row-action" label="오늘 할 일에서 빼기" onClick={() => void onUnscheduleDue(row.item)}><CloseIcon /></IconButton>} />
    )} />
  );
}

type DragHandle = { key: string; dragging: boolean; ref: (element: HTMLElement | null) => void; onPointerDown: (event: ReactPointerEvent<HTMLElement>) => void };

const settle = "transform .2s cubic-bezier(.2, .8, .2, 1)";

/**
 * Vertical drag-to-reorder with pointer events; HTML drag and drop is unreliable inside the Tauri webview.
 * The dragged row follows the pointer, and every other row glides to its new slot (FLIP on layout offsets).
 */
function ReorderList<T>({ items, getKey, onReorder, renderItem }: { items: T[]; getKey: (item: T) => string; onReorder: (items: T[]) => void; renderItem: (item: T, drag: DragHandle) => ReactNode }) {
  const [preview, setPreview] = useState<{ key: string; items: T[] } | null>(null);
  const container = useRef<HTMLDivElement>(null);
  const rows = useRef(new Map<string, HTMLElement>());
  const tops = useRef(new Map<string, number>());
  // Pointer position in list coordinates, minus where inside the row it was grabbed.
  const pointer = useRef<{ key: string; y: number; grab: number } | null>(null);

  const listY = (clientY: number) => {
    const box = container.current!;
    return clientY - box.getBoundingClientRect().top + box.scrollTop;
  };
  // Where the dragged row is drawn: under the pointer, but held within the list with a little elastic give.
  const draggedTop = (row: HTMLElement) => {
    const drag = pointer.current!;
    const elements = [...rows.current.values()];
    const first = Math.min(...elements.map((element) => element.offsetTop));
    const last = Math.max(...elements.map((element) => element.offsetTop + element.offsetHeight)) - row.offsetHeight;
    const raw = drag.y - drag.grab;
    const give = (distance: number) => 6 * (1 - Math.exp(-distance / 24));
    return raw < first ? first - give(first - raw) : raw > last ? last + give(raw - last) : raw;
  };
  const followPointer = () => {
    const drag = pointer.current;
    const row = drag && rows.current.get(drag.key);
    if (!drag || !row) return;
    row.style.transition = "none";
    row.style.transform = `translateY(${draggedTop(row) - row.offsetTop}px)`;
  };

  useLayoutEffect(() => {
    for (const key of tops.current.keys()) if (!rows.current.has(key)) tops.current.delete(key);
    for (const [key, row] of rows.current) {
      const top = row.offsetTop;
      const previous = tops.current.get(key);
      tops.current.set(key, top);
      if (key === pointer.current?.key || previous === undefined || previous === top) continue;
      row.style.transition = "none";
      row.style.transform = `translateY(${previous - top}px)`;
      void row.offsetHeight; // Commit the inverted position before animating back to the new slot.
      row.style.transition = settle;
      row.style.transform = "";
    }
    followPointer();
  });

  const begin = (event: ReactPointerEvent<HTMLElement>, key: string) => {
    if (event.button !== 0 || (event.target as HTMLElement).closest("button")) return;
    const startY = event.clientY;
    let current = items;
    let dragging = false;
    const move = (moveEvent: PointerEvent) => {
      const row = rows.current.get(key);
      if (!row || !container.current) return;
      if (!dragging) {
        // A short press still opens the row for editing.
        if (Math.abs(moveEvent.clientY - startY) < 6) return;
        dragging = true;
        (document.activeElement as HTMLElement | null)?.blur();
        window.getSelection()?.removeAllRanges();
        document.documentElement.classList.add("reordering");
        pointer.current = { key, y: listY(startY), grab: listY(startY) - row.offsetTop };
        setPreview({ key, items: current });
      }
      moveEvent.preventDefault();
      pointer.current = { ...pointer.current!, y: listY(moveEvent.clientY) };
      followPointer();
      // Place the row where its center falls among the other rows' stacked heights, ignoring their animations.
      const others = current.filter((item) => getKey(item) !== key);
      const center = draggedTop(row) + row.offsetHeight / 2;
      let slotTop = Math.min(...[...rows.current.values()].map((element) => element.offsetTop));
      let target = others.length;
      for (const [index, item] of others.entries()) {
        const height = rows.current.get(getKey(item))?.offsetHeight ?? 0;
        if (center < slotTop + height / 2) { target = index; break; }
        slotTop += height;
      }
      const next = [...others];
      next.splice(target, 0, current.find((item) => getKey(item) === key)!);
      if (next.some((item, index) => item !== current[index])) {
        current = next;
        setPreview({ key, items: next });
      }
    };
    const end = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", end);
      if (!dragging) return;
      document.documentElement.classList.remove("reordering");
      const swallow = (click: MouseEvent) => { click.stopPropagation(); click.preventDefault(); };
      window.addEventListener("click", swallow, { capture: true, once: true });
      setTimeout(() => window.removeEventListener("click", swallow, { capture: true }), 0);
      // Let the dropped row glide from the pointer into its slot.
      const row = rows.current.get(key);
      pointer.current = null;
      if (row) {
        row.style.transition = settle;
        row.style.transform = "";
      }
      setPreview(null);
      if (current.some((item, index) => item !== items[index])) onReorder(current);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", end);
  };

  return (
    <div className="task-list reorder-list" ref={container}>
      {(preview?.items ?? items).map((item) => {
        const key = getKey(item);
        return renderItem(item, {
          key,
          dragging: preview?.key === key,
          // React detaches and reattaches inline refs on every render, so remembered offsets are pruned in the layout effect instead.
          ref: (element) => { if (element) rows.current.set(key, element); else rows.current.delete(key); },
          onPointerDown: (event) => begin(event, key),
        });
      })}
    </div>
  );
}

// Calm sparkles inside the progress fill: [left %, top %, size px, delay s, star-shaped].
const sparkles: [number, number, number, number, boolean][] = [
  [22, 42, 12, 0, true], [64, 54, 10, 3.2, true],
  [12, 64, 4, 1.4, false], [44, 34, 3, 4.6, false], [84, 42, 4, 2.4, false],
];

function TodayList({ onAdd, notice, ...list }: ListProps & DayProps & {
  onAdd: (content: string) => Promise<void>;
  notice: ReactNode;
}) {
  const { total, completed } = dayProgress(list.plans, list.dueItems);
  const percent = total ? completed / total * 100 : 0;
  // Keep a visible pill once anything is done; the white label is clipped to exactly the filled part.
  const fill = completed ? `max(var(--progress-height), ${percent}%)` : "0%";
  const label = !total ? "할 일을 추가해보세요" : completed === total ? `모두 완료 ${completed}/${total}` : `완료 ${completed}/${total}`;
  return (
    <>
      <div className={completed ? "day-progress active" : "day-progress"} style={{ "--fill": fill } as CSSProperties} role="progressbar" aria-label="오늘 할 일 진행률" aria-valuemin={0} aria-valuemax={total} aria-valuenow={completed} aria-valuetext={label}>
        <span className="day-progress-glow" aria-hidden="true" />
        <div className="day-progress-track">
          <span className="day-progress-fill" aria-hidden="true">
            {sparkles.map(([left, top, size, delay, star], index) => (
              <i key={index} className={star ? "star" : undefined} style={{ left: `${left}%`, top: `${top}%`, width: size, height: size, animationDelay: `${delay}s` }} />
            ))}
          </span>
          <span className="day-progress-label">{label}</span>
          <span className="day-progress-label on-fill" aria-hidden="true">{label}</span>
        </div>
      </div>
      <DayChecklist {...list} />
      {notice}
      <AddTask onAdd={onAdd} />
    </>
  );
}

function Calendar({ activity, cursor, plans, selectedDate, today, onAdd, onCursor, onSelect, notice, ...list }: ListProps & DayProps & {
  notice: ReactNode;
  activity: DayActivity[];
  cursor: Date;
  selectedDate: string;
  today: string;
  onAdd: (content: string) => Promise<void>;
  onCursor: (date: Date) => void;
  onSelect: (date: string) => void;
}) {
  const first = new Date(cursor.getFullYear(), cursor.getMonth(), 1);
  const start = new Date(cursor.getFullYear(), cursor.getMonth(), 1 - first.getDay());
  const days = Array.from({ length: 42 }, (_, index) => new Date(start.getFullYear(), start.getMonth(), start.getDate() + index));
  const counts = useMemo(() => Object.fromEntries(activity.map((item) => [item.date, item])), [activity]);
  const { total, completed } = dayProgress(plans, list.dueItems);
  return (
      <div className="tracker-layout">
        <section className="calendar-card" aria-label="할 일 캘린더">
          <div className="calendar-heading">
            <div>
              <span>DAILY ARCHIVE</span>
              <h1>{new Intl.DateTimeFormat("ko-KR", { year: "numeric", month: "long" }).format(cursor)}</h1>
            </div>
            <div className="calendar-actions">
              <IconButton label="이전 달" onClick={() => onCursor(new Date(cursor.getFullYear(), cursor.getMonth() - 1, 1))}><ChevronIcon direction="left" /></IconButton>
              <button onClick={() => { const now = new Date(); onCursor(now); onSelect(today); }}>오늘</button>
              <IconButton label="다음 달" onClick={() => onCursor(new Date(cursor.getFullYear(), cursor.getMonth() + 1, 1))}><ChevronIcon direction="right" /></IconButton>
            </div>
          </div>
          <div className="weekdays">{["일", "월", "화", "수", "목", "금", "토"].map((day) => <span key={day}>{day}</span>)}</div>
          <div className="calendar-grid">
            {days.map((day) => {
              const key = dateKey(day);
              const item = counts[key];
              const percentage = item?.total ? item.completed / item.total * 100 : 0;
              const className = ["calendar-day", day.getMonth() !== cursor.getMonth() ? "outside" : "", key === selectedDate ? "selected" : "", key === today ? "today" : ""].filter(Boolean).join(" ");
              return (
                <button className={className} key={key} onClick={() => {
                  onSelect(key);
                  if (day.getMonth() !== cursor.getMonth()) onCursor(new Date(day.getFullYear(), day.getMonth(), 1));
                }} aria-pressed={key === selectedDate}>
                  <span>{day.getDate()}</span>
                  {item && <><small>{item.completed}/{item.total}</small><i><b style={{ width: percentage + "%" }} /></i></>}
                </button>
              );
            })}
          </div>
          <div className="calendar-legend"><span><i /> 할 일 있음</span><span><i className="done" /> 모두 완료</span></div>
        </section>
        <aside className="day-card">
          <div className="day-heading">
            <div>
              <span>{selectedDate === today ? "TODAY" : formatDate(selectedDate, { weekday: "long" }).toUpperCase()}</span>
              <h2>{formatDate(selectedDate, { month: "long", day: "numeric" })}</h2>
            </div>
            <strong>{completed}/{total}</strong>
          </div>
          <p className="day-status">{total ? completed === total ? "모든 할 일을 마쳤어요." : `${total - completed}개 남았어요.` : "새로운 하루를 계획해보세요."}</p>
          <DayChecklist plans={plans} {...list} />
          {notice}
          <AddTask onAdd={onAdd} />
        </aside>
      </div>
  );
}

export function TaskList<T extends CheckItem>({ plans, renderActions, onContextMenu, ...handlers }: RowHandlers<T> & {
  plans: T[];
  renderActions?: (plan: T) => ReactNode;
  onContextMenu?: (plan: T, event: ReactMouseEvent) => void;
}) {
  return (
    <div className="task-list">
      {plans.map((plan) => <TaskRow key={plan.id} plan={plan} {...handlers} actions={renderActions?.(plan)} onContextMenu={onContextMenu && ((event) => onContextMenu(plan, event))} />)}
    </div>
  );
}

function TaskRow<T extends CheckItem>({ plan, meta, actions, drag, onToggle, onUpdate, onContextMenu }: RowHandlers<T> & { plan: T; meta?: string; actions?: ReactNode; drag?: DragHandle; onContextMenu?: (event: ReactMouseEvent) => void }) {
  const [content, setContent] = useState(plan.content);
  const [editing, setEditing] = useState(false);
  const cancelled = useRef(false);
  useEffect(() => setContent(plan.content), [plan.content]);
  const finish = () => {
    const next = content.trim();
    if (cancelled.current || !next) setContent(plan.content);
    else if (next !== plan.content) void onUpdate(plan, next);
    cancelled.current = false;
    setEditing(false);
  };
  return (
    <div className={["task-row", plan.completed ? "complete" : "", drag ? "reorderable" : "", drag?.dragging ? "dragging" : ""].filter(Boolean).join(" ")} ref={drag?.ref} onPointerDown={drag?.onPointerDown} onContextMenu={onContextMenu}>
      <button className="check" onClick={() => void onToggle(plan)} aria-label={plan.completed ? `${plan.content} 완료 취소` : `${plan.content} 완료`} aria-pressed={plan.completed}>{plan.completed && <CheckIcon />}</button>
      <div className="row-body">
        {meta && <small>{meta}</small>}
        {/* Up to two lines while reading; a single-line field while editing. */}
        {editing ? (
          <input autoFocus value={content} onChange={(event) => setContent(event.target.value)} onBlur={finish} aria-label="할 일 수정" onKeyDown={(event) => {
            if (event.key === "Escape") cancelled.current = true;
            if (event.key === "Enter" || event.key === "Escape") event.currentTarget.blur();
          }} />
        ) : (
          <div className="row-text" role="button" tabIndex={0} aria-label={`${plan.content} 수정`} onClick={() => setEditing(true)} onKeyDown={(event) => {
            if (event.key !== "Enter" && event.key !== " ") return;
            event.preventDefault();
            setEditing(true);
          }}>{content}</div>
        )}
      </div>
      {actions && <div className="row-actions">{actions}</div>}
    </div>
  );
}

export function AddTask({ onAdd, placeholder = "할 일을 입력하세요", label = "새 할 일", inputRef, onDismiss }: {
  onAdd: (content: string) => Promise<void>;
  placeholder?: string;
  label?: string;
  inputRef?: Ref<HTMLInputElement>;
  /** Called on Escape, or when focus leaves an empty field, for inputs that only appear on demand. */
  onDismiss?: () => void;
}) {
  const [content, setContent] = useState("");
  const [saving, setSaving] = useState(false);
  const inputId = useId();
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const next = content.trim();
    if (!next || saving) return;
    setSaving(true);
    try { await onAdd(next); setContent(""); }
    catch { /* The caller displays the save error; keep the input available to retry. */ }
    finally { setSaving(false); }
  };
  return (
    <form className="add-task" onSubmit={(event) => void submit(event)}>
      <label className="sr-only" htmlFor={inputId}>{label}</label>
      <input id={inputId} ref={inputRef} value={content} onChange={(event) => setContent(event.target.value)} placeholder={placeholder} autoComplete="off"
        onBlur={() => { if (!content.trim()) onDismiss?.(); }}
        onKeyDown={(event) => { if (event.key === "Escape" && onDismiss) { setContent(""); onDismiss(); } }} />
      <button disabled={!content.trim() || saving} aria-label={`${label} 추가`}><ArrowIcon /></button>
    </form>
  );
}

export function IconButton({ label, onClick, children, className = "" }: { label: string; onClick: () => void; children: React.ReactNode; className?: string }) {
  return <button type="button" className={`icon-button ${className}`} onClick={onClick} aria-label={label} title={label}>{children}</button>;
}

function AppearanceMenu({ backgroundEnabled, onChange }: { backgroundEnabled: boolean; onChange: (value: boolean) => void }) {
  const menu = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    const outside = (event: PointerEvent) => {
      if (menu.current && !menu.current.contains(event.target as Node)) menu.current.open = false;
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape" && menu.current?.open) {
        menu.current.open = false;
        menu.current.querySelector("summary")?.focus();
      }
    };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("keydown", escape);
    };
  }, []);
  return (
    <details className="appearance-menu" ref={menu}>
      <summary className="icon-button" aria-label="화면 설정" title="화면 설정"><MoreIcon /></summary>
      <div className="appearance-panel">
        <label className="background-toggle"><span>반투명 배경</span><input type="checkbox" checked={backgroundEnabled} onChange={(event) => onChange(event.target.checked)} /></label>
        <p>macOS 네이티브 소재를 사용합니다.<br />끄면 흰색 배경으로 표시합니다.</p>
      </div>
    </details>
  );
}

const ExpandIcon = () => <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 3H3v5M16 3h5v5M21 16v5h-5M3 16v5h5" /></svg>;
const CollapseIcon = () => <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 4v5H4M15 4v5h5M20 15h-5v5M4 15h5v5" /></svg>;
const CloseIcon = () => <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18" /></svg>;
const ArrowIcon = () => <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 18V6m-5 5 5-5 5 5" /></svg>;
export const PlusIcon = () => <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg>;
const MoreIcon = () => <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="5" cy="12" r="1" /><circle cx="12" cy="12" r="1" /><circle cx="19" cy="12" r="1" /></svg>;
export const CheckIcon = () => <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12 4 4L19 6" /></svg>;
export const TrashIcon = () => <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M9 7V4h6v3M7 7l1 13h8l1-13M10 11v5M14 11v5" /></svg>;
export const ChevronIcon = ({ direction }: { direction: "left" | "right" }) => <svg viewBox="0 0 24 24" aria-hidden="true"><path d={direction === "left" ? "m15 7-6 5 6 5" : "m9 7 6 5-6 5"} /></svg>;
