import { FormEvent, MouseEvent, useEffect, useMemo, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { register, unregisterAll } from "@tauri-apps/plugin-global-shortcut";
import { api } from "./api";
import type { Note, Plan, Settings, Summary } from "./types";

type View = "timeline" | "today" | "weekly" | "search" | "settings";
const nav: { id: View; label: string }[] = [{ id: "timeline", label: "흔적" }, { id: "today", label: "오늘" }, { id: "weekly", label: "이번 주" }, { id: "search", label: "검색" }, { id: "settings", label: "설정" }];
const defaults: Settings = { shortcut: "CommandOrControl+;", ai_provider: "off", theme: "system" };
const isDesktop = "__TAURI_INTERNALS__" in window;

export default function App() {
  const [view, setView] = useState<View>("today");
  const [notes, setNotes] = useState<Note[]>([]); const [plans, setPlans] = useState<Plan[]>([]);
  const [query, setQuery] = useState(""); const [summary, setSummary] = useState<Summary | null>(null); const [weekly, setWeekly] = useState<string[]>([]);
  const [settings, setSettings] = useState<Settings>(defaults); const [editing, setEditing] = useState<Note | null>(null);
  const refreshNotes = async (search = "") => { try { setNotes(await api.listNotes(search)); } catch {} };
  const refreshToday = async () => { try { const [p, s] = await Promise.all([api.listPlans(), api.dailySummary()]); setPlans(p); setSummary(s); } catch {} };
  const openCapture = async () => { if (!isDesktop) return; const capture = await WebviewWindow.getByLabel("capture"); await capture?.show(); await capture?.center(); await capture?.setFocus(); };

  useEffect(() => {
    void refreshNotes(); void refreshToday();
    if (isDesktop) { void api.getSettings().then((saved) => { setSettings(saved); register(saved.shortcut, openCapture).catch(console.error); }); }
    const stop = isDesktop ? listen("note-created", () => { void refreshNotes(); void refreshToday(); }) : Promise.resolve(() => {});
    return () => { void stop.then((fn) => fn()); };
  }, []);
  useEffect(() => { document.documentElement.dataset.theme = settings.theme; }, [settings.theme]);
  useEffect(() => { if (view === "today") void refreshToday(); if (view === "weekly") void api.weeklySummary().then(setWeekly).catch(() => {}); }, [view]);
  const saveSettings = async () => { await api.saveSettings(settings); await unregisterAll(); await register(settings.shortcut, openCapture); };
  const grouped = useMemo(() => notes.reduce<Record<string, Note[]>>((all, note) => { const date = new Intl.DateTimeFormat("ko-KR", { month: "long", day: "numeric", weekday: "short" }).format(new Date(note.created_at)); (all[date] ??= []).push(note); return all; }, {}), [notes]);
  const removeNote = async (note: Note, event?: MouseEvent) => { event?.stopPropagation(); if (!confirm("이 기록을 삭제할까요?")) return; await api.deleteNote(note.id); setEditing(null); await refreshNotes(query); await refreshToday(); };

  return <div className="app-shell">
    <aside className="sidebar"><button className="brand" onClick={() => setView("today")}>Trace</button><nav>{nav.map((item) => <button key={item.id} className={view === item.id ? "nav-item active" : "nav-item"} onClick={() => setView(item.id)}>{item.label}</button>)}</nav><button className="capture-trigger" onClick={openCapture}><span>빠른 입력</span><kbd>⌘ ;</kbd></button></aside>
    <main className="content">
      {view === "timeline" && <><Header title="흔적" action={<button className="primary-button" onClick={openCapture}>새 기록</button>} /><Timeline grouped={grouped} onEdit={setEditing} onDelete={removeNote} /></>}
      {view === "today" && <><Header title="오늘" meta={new Intl.DateTimeFormat("ko-KR", { year: "numeric", month: "long", day: "numeric", weekday: "long" }).format(new Date())} /><Today plans={plans} summary={summary} onRefresh={refreshToday} /></>}
      {view === "weekly" && <><Header title="이번 주" /><section className="panel weekly-panel">{weekly.length ? weekly.map((line, i) => <p key={i}>{line}</p>) : <Empty />}</section></>}
      {view === "search" && <><Header title="검색" /><form className="search-bar" onSubmit={(e) => { e.preventDefault(); void refreshNotes(query); }}><input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="기록 검색" autoFocus /><kbd>Enter</kbd></form><Timeline grouped={grouped} onEdit={setEditing} onDelete={removeNote} empty="기록이 없습니다." /></>}
      {view === "settings" && <><Header title="설정" /><SettingsForm settings={settings} onChange={setSettings} onSave={saveSettings} /></>}
    </main>
    {isDesktop && <button className="window-close" onClick={() => getCurrentWindow().hide()} aria-label="창 숨기기">×</button>}
    {editing && <EditDialog note={editing} onClose={() => setEditing(null)} onDelete={() => removeNote(editing)} onSaved={async () => { setEditing(null); await refreshNotes(); await refreshToday(); }} />}
  </div>;
}

function Header({ title, meta, action }: { title: string; meta?: string; action?: React.ReactNode }) { return <header className="page-header"><div><h1>{title}</h1>{meta && <p>{meta}</p>}</div>{action}</header>; }
function Timeline({ grouped, onEdit, onDelete, empty }: { grouped: Record<string, Note[]>; onEdit: (n: Note) => void; onDelete: (n: Note, e: MouseEvent) => void; empty?: string }) {
  if (!Object.keys(grouped).length) return <Empty label={empty} />;
  return <div className="timeline">{Object.entries(grouped).map(([date, items]) => <section className="day" key={date}><h2>{date}</h2><div className="entries">{items.map((note) => <button className="note-row" key={note.id} onClick={() => onEdit(note)}><time>{new Date(note.created_at).toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit" })}</time><div className="note-copy"><p>{note.content}</p><div className="tags">{note.tags.map((tag) => <span key={tag}>{tag}</span>)}</div></div><span className="category">{note.category}</span><span className="row-actions"><span onClick={(e) => onDelete(note, e)}>삭제</span></span></button>)}</div></section>)}</div>;
}
function Today({ plans, summary, onRefresh }: { plans: Plan[]; summary: Summary | null; onRefresh: () => Promise<void> }) {
  const [priority, setPriority] = useState<Plan["priority"]>("Must"); const [content, setContent] = useState("");
  const add = async (e: FormEvent) => { e.preventDefault(); if (!content.trim()) return; await api.createPlan(priority, content); setContent(""); await onRefresh(); };
  const toggle = async (plan: Plan) => { await api.togglePlan(plan.id, !plan.completed); await onRefresh(); };
  const remove = async (id: number) => { await api.deletePlan(id); await onRefresh(); };
  return <div className="today-layout"><section className="panel plan-panel"><div className="section-title"><h2>오늘 계획</h2><span>{plans.filter((p) => p.completed).length}/{plans.length}</span></div>{(["Must", "Should", "Could"] as const).map((level) => <div className="priority-group" key={level}><h3>{level}</h3>{plans.filter((p) => p.priority === level).map((plan) => <label className="plan-row" key={plan.id}><input type="checkbox" checked={plan.completed} onChange={() => toggle(plan)} /><span className={plan.completed ? "done" : ""}>{plan.content}</span><button type="button" onClick={() => remove(plan.id)} aria-label="계획 삭제">×</button></label>)}</div>)}<form className="plan-add" onSubmit={add}><select value={priority} onChange={(e) => setPriority(e.target.value as Plan["priority"])}><option>Must</option><option>Should</option><option>Could</option></select><input value={content} onChange={(e) => setContent(e.target.value)} placeholder="계획 추가" /><button>추가</button></form></section><DailyRecord summary={summary} /></div>;
}
function DailyRecord({ summary }: { summary: Summary | null }) { if (!summary) return <section className="panel"><Empty /></section>; const groups: [string, { content: string; id: number }[]][] = [["완료한 업무", summary.completed], ["주요 결정", summary.decisions], ["반영된 피드백", summary.feedback], ["아이디어", summary.ideas], ["발견한 문제와 질문", summary.questions]]; return <section className="panel record-panel"><div className="section-title"><h2>오늘의 기록</h2><span>자동 구성</span></div>{groups.map(([title, items]) => items.length > 0 && <div className="record-group" key={title}><h3>{title}</h3>{items.map((item) => <p key={item.id}>{item.content}</p>)}</div>)}{groups.every(([, items]) => !items.length) && <Empty />}</section>; }
function SettingsForm({ settings, onChange, onSave }: { settings: Settings; onChange: (s: Settings) => void; onSave: () => Promise<void> }) { const [saved, setSaved] = useState(false); const save = async (e: FormEvent) => { e.preventDefault(); await onSave(); setSaved(true); setTimeout(() => setSaved(false), 1200); }; return <form className="settings-card panel" onSubmit={save}><label><span>글로벌 단축키<small>빠른 입력 창 열기</small></span><input value={settings.shortcut} onChange={(e) => onChange({ ...settings, shortcut: e.target.value })} /></label><label><span>AI Provider<small>선택 사항</small></span><select value={settings.ai_provider} onChange={(e) => onChange({ ...settings, ai_provider: e.target.value as Settings["ai_provider"] })}><option value="off">Off</option><option value="openai">OpenAI</option><option value="claude">Claude</option><option value="gemini">Gemini</option></select></label><label><span>테마</span><select value={settings.theme} onChange={(e) => onChange({ ...settings, theme: e.target.value as Settings["theme"] })}><option value="system">시스템</option><option value="light">라이트</option><option value="dark">다크</option></select></label><button className="primary-button">{saved ? "저장됨" : "저장"}</button></form>; }
function EditDialog({ note, onClose, onDelete, onSaved }: { note: Note; onClose: () => void; onDelete: () => void; onSaved: () => void }) { const [content, setContent] = useState(note.content); const [tags, setTags] = useState(note.tags.join(", ")); const save = async (e: FormEvent) => { e.preventDefault(); await api.updateNote(note.id, content, tags.split(",").map((t) => t.trim()).filter(Boolean)); onSaved(); }; return <div className="dialog-backdrop" onMouseDown={onClose}><form className="edit-dialog" onSubmit={save} onMouseDown={(e) => e.stopPropagation()}><h2>기록 수정</h2><textarea value={content} onChange={(e) => setContent(e.target.value)} autoFocus /><input value={tags} onChange={(e) => setTags(e.target.value)} placeholder="태그, 쉼표로 구분" /><div className="dialog-actions"><button type="button" className="danger-button" onClick={onDelete}>삭제</button><span /><button type="button" className="secondary-button" onClick={onClose}>취소</button><button className="primary-button">저장</button></div></form></div>; }
function Empty({ label = "기록이 없습니다." }: { label?: string }) { return <div className="empty">{label}</div>; }
