use chrono::{Duration, Local};
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use std::{fs, path::PathBuf, sync::Mutex};
use tauri::{Manager, State};

struct Db(Mutex<Connection>);

#[derive(Debug, Serialize)]
struct Note { id: i64, content: String, created_at: String, updated_at: String, tags: Vec<String>, project: Option<String>, category: String }
#[derive(Debug, Serialize)]
struct Plan { id: i64, date: String, priority: String, content: String, completed: bool }
#[derive(Serialize)]
struct Summary { completed: Vec<Plan>, decisions: Vec<Note>, work: Vec<Note>, ideas: Vec<Note>, questions: Vec<Note>, feedback: Vec<Note> }
#[derive(Debug, Serialize, Deserialize)]
struct Settings { shortcut: String, ai_provider: String, theme: String }

fn classify(content: &str) -> (String, Vec<String>, Option<String>) {
    let lower = content.to_lowercase();
    let category = if ["결정", "변경", "확정", "정책"].iter().any(|v| lower.contains(v)) { "결정" }
        else if ["아이디어", "실험", "가능", "자동화"].iter().any(|v| lower.contains(v)) { "아이디어" }
        else if ["질문", "문의", "어떻게", "?"].iter().any(|v| lower.contains(v)) { "질문" }
        else if ["피드백", "수정", "요청"].iter().any(|v| lower.contains(v)) { "피드백" }
        else { "업무" };
    let mut tags = vec![category.to_string()];
    for (needle, tag) in [("ai", "AI"), ("프롬프트", "AI"), ("인스타", "인스타"), ("상품", "상품"), ("태그", "태그"), ("관리자", "관리자"), ("다크모드", "UI"), ("캘린더", "캘린더")] {
        if lower.contains(needle) && !tags.iter().any(|item| item == tag) { tags.push(tag.to_string()); }
    }
    let project = tags.iter().nth(1).cloned();
    (category.to_string(), tags, project)
}

fn row_to_note(row: &rusqlite::Row<'_>) -> rusqlite::Result<Note> {
    let tags: String = row.get(4)?;
    Ok(Note { id: row.get(0)?, content: row.get(1)?, created_at: row.get(2)?, updated_at: row.get(3)?, tags: serde_json::from_str(&tags).unwrap_or_default(), project: row.get(5)?, category: row.get(6)? })
}
fn select_notes(conn: &Connection, sql: &str, value: &str) -> Result<Vec<Note>, String> {
    let mut statement = conn.prepare(sql).map_err(|e| e.to_string())?;
    let result = statement.query_map(params![value], row_to_note).map_err(|e| e.to_string())?.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string());
    result
}

#[tauri::command]
fn create_note(content: String, db: State<Db>) -> Result<Note, String> {
    let content = content.trim(); if content.is_empty() { return Err("내용이 비어 있습니다.".into()); }
    let (category, tags, project) = classify(content); let now = Local::now().to_rfc3339();
    let tags_json = serde_json::to_string(&tags).map_err(|e| e.to_string())?; let conn = db.0.lock().map_err(|e| e.to_string())?;
    conn.execute("INSERT INTO notes (content, created_at, updated_at, tags, project, category) VALUES (?1, ?2, ?2, ?3, ?4, ?5)", params![content, now, tags_json, project, category]).map_err(|e| e.to_string())?;
    Ok(Note { id: conn.last_insert_rowid(), content: content.into(), created_at: now.clone(), updated_at: now, tags, project, category })
}
#[tauri::command]
fn list_notes(query: String, db: State<Db>) -> Result<Vec<Note>, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    if query.trim().is_empty() { select_notes(&conn, "SELECT id, content, created_at, updated_at, tags, project, category FROM notes ORDER BY created_at DESC", "") }
    else {
        let cleaned = query.replace("보여줘", "").replace("찾아줘", "").replace("모아줘", "").replace("정리해줘", "");
        let keyword = cleaned.split_whitespace().find(|word| word.chars().count() > 1).unwrap_or(cleaned.trim());
        select_notes(&conn, "SELECT id, content, created_at, updated_at, tags, project, category FROM notes WHERE content LIKE '%' || ?1 || '%' OR tags LIKE '%' || ?1 || '%' ORDER BY created_at DESC", keyword)
    }
}
#[tauri::command]
fn update_note(id: i64, content: String, tags: Vec<String>, db: State<Db>) -> Result<Note, String> {
    if content.trim().is_empty() { return Err("내용이 비어 있습니다.".into()); }
    let (category, inferred, project) = classify(&content); let tags = if tags.is_empty() { inferred } else { tags }; let now = Local::now().to_rfc3339();
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    conn.execute("UPDATE notes SET content=?1, updated_at=?2, tags=?3, project=?4, category=?5 WHERE id=?6", params![content, now, serde_json::to_string(&tags).unwrap_or("[]".into()), project, category, id]).map_err(|e| e.to_string())?;
    let created_at = conn.query_row("SELECT created_at FROM notes WHERE id=?1", params![id], |row| row.get(0)).map_err(|e| e.to_string())?;
    Ok(Note { id, content, created_at, updated_at: now, tags, project, category })
}
#[tauri::command]
fn delete_note(id: i64, db: State<Db>) -> Result<(), String> { db.0.lock().map_err(|e| e.to_string())?.execute("DELETE FROM notes WHERE id=?1", params![id]).map_err(|e| e.to_string())?; Ok(()) }
fn row_to_plan(row: &rusqlite::Row<'_>) -> rusqlite::Result<Plan> { Ok(Plan { id: row.get(0)?, date: row.get(1)?, priority: row.get(2)?, content: row.get(3)?, completed: row.get::<_, i64>(4)? != 0 }) }
#[tauri::command]
fn list_plans(date: Option<String>, db: State<Db>) -> Result<Vec<Plan>, String> {
    let date = date.unwrap_or_else(|| Local::now().format("%Y-%m-%d").to_string()); let conn = db.0.lock().map_err(|e| e.to_string())?;
    let mut statement = conn.prepare("SELECT id, date, priority, content, completed FROM plans WHERE date=?1 ORDER BY CASE priority WHEN 'Must' THEN 1 WHEN 'Should' THEN 2 ELSE 3 END, id").map_err(|e| e.to_string())?;
    let result = statement.query_map(params![date], row_to_plan).map_err(|e| e.to_string())?.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string()); result
}
#[tauri::command]
fn create_plan(priority: String, content: String, db: State<Db>) -> Result<Plan, String> {
    if !["Must", "Should", "Could"].contains(&priority.as_str()) || content.trim().is_empty() { return Err("올바른 계획을 입력하세요.".into()); }
    let date = Local::now().format("%Y-%m-%d").to_string(); let conn = db.0.lock().map_err(|e| e.to_string())?;
    conn.execute("INSERT INTO plans (date, priority, content, completed) VALUES (?1, ?2, ?3, 0)", params![date, priority, content.trim()]).map_err(|e| e.to_string())?;
    Ok(Plan { id: conn.last_insert_rowid(), date, priority, content: content.trim().into(), completed: false })
}
#[tauri::command]
fn toggle_plan(id: i64, completed: bool, db: State<Db>) -> Result<(), String> { db.0.lock().map_err(|e| e.to_string())?.execute("UPDATE plans SET completed=?1 WHERE id=?2", params![completed as i64, id]).map_err(|e| e.to_string())?; Ok(()) }
#[tauri::command]
fn delete_plan(id: i64, db: State<Db>) -> Result<(), String> { db.0.lock().map_err(|e| e.to_string())?.execute("DELETE FROM plans WHERE id=?1", params![id]).map_err(|e| e.to_string())?; Ok(()) }
#[tauri::command]
fn daily_summary(date: Option<String>, db: State<Db>) -> Result<Summary, String> {
    let date = date.unwrap_or_else(|| Local::now().format("%Y-%m-%d").to_string()); let conn = db.0.lock().map_err(|e| e.to_string())?;
    let notes = select_notes(&conn, "SELECT id, content, created_at, updated_at, tags, project, category FROM notes WHERE substr(created_at, 1, 10)=?1 ORDER BY created_at DESC", &date)?;
    let completed = { let mut statement = conn.prepare("SELECT id, date, priority, content, completed FROM plans WHERE date=?1 AND completed=1 ORDER BY id").map_err(|e| e.to_string())?; let result = statement.query_map(params![date], row_to_plan).map_err(|e| e.to_string())?.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())?; result };
    let mut summary = Summary { completed, decisions: vec![], work: vec![], ideas: vec![], questions: vec![], feedback: vec![] };
    for note in notes { match note.category.as_str() { "결정" => summary.decisions.push(note), "아이디어" => summary.ideas.push(note), "질문" => summary.questions.push(note), "피드백" => summary.feedback.push(note), _ => summary.work.push(note) } }
    Ok(summary)
}
#[tauri::command]
fn weekly_summary(db: State<Db>) -> Result<Vec<String>, String> {
    let since = (Local::now().date_naive() - Duration::days(6)).format("%Y-%m-%d").to_string(); let conn = db.0.lock().map_err(|e| e.to_string())?;
    let notes = select_notes(&conn, "SELECT id, content, created_at, updated_at, tags, project, category FROM notes WHERE substr(created_at, 1, 10)>=?1 ORDER BY created_at DESC", &since)?;
    if notes.is_empty() { return Ok(vec![]); }
    let decisions = notes.iter().filter(|n| n.category == "결정").count(); let ideas = notes.iter().filter(|n| n.category == "아이디어").count();
    let mut projects: Vec<String> = notes.iter().filter_map(|n| n.project.clone()).collect(); projects.sort(); projects.dedup();
    Ok(vec![format!("이번 주에는 {}개의 생각과 작업 흔적을 남겼습니다.", notes.len()), format!("그중 중요한 결정은 {}개, 새 아이디어는 {}개였습니다.", decisions, ideas), if projects.is_empty() { "아직 반복해서 등장한 프로젝트는 없습니다.".into() } else { format!("자주 등장한 맥락: {}", projects.join(", ")) }])
}
fn settings_path(app: &tauri::AppHandle) -> Result<PathBuf, String> { app.path().app_config_dir().map(|path| path.join("settings.json")).map_err(|e| e.to_string()) }
#[tauri::command]
fn get_settings(app: tauri::AppHandle) -> Settings { fs::read_to_string(settings_path(&app).unwrap_or_default()).ok().and_then(|v| serde_json::from_str(&v).ok()).unwrap_or(Settings { shortcut: "CommandOrControl+;".into(), ai_provider: "off".into(), theme: "system".into() }) }
#[tauri::command]
fn save_settings(settings: Settings, app: tauri::AppHandle) -> Result<(), String> { let path = settings_path(&app)?; if let Some(parent) = path.parent() { fs::create_dir_all(parent).map_err(|e| e.to_string())?; } fs::write(path, serde_json::to_vec_pretty(&settings).map_err(|e| e.to_string())?).map_err(|e| e.to_string()) }

pub fn run() {
    tauri::Builder::default().plugin(tauri_plugin_global_shortcut::Builder::new().build()).setup(|app| {
        let dir = app.path().app_data_dir()?; fs::create_dir_all(&dir)?; let conn = Connection::open(dir.join("trace.db"))?;
        conn.execute_batch("CREATE TABLE IF NOT EXISTS notes (id INTEGER PRIMARY KEY AUTOINCREMENT, content TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, tags TEXT NOT NULL DEFAULT '[]', project TEXT, category TEXT NOT NULL DEFAULT '업무'); CREATE TABLE IF NOT EXISTS plans (id INTEGER PRIMARY KEY AUTOINCREMENT, date TEXT NOT NULL, priority TEXT NOT NULL CHECK(priority IN ('Must','Should','Could')), content TEXT NOT NULL, completed INTEGER NOT NULL DEFAULT 0); CREATE INDEX IF NOT EXISTS idx_plans_date ON plans(date); CREATE INDEX IF NOT EXISTS idx_notes_created_at ON notes(created_at); CREATE INDEX IF NOT EXISTS idx_notes_category ON notes(category);")?;
        app.manage(Db(Mutex::new(conn))); Ok(())
    }).invoke_handler(tauri::generate_handler![create_note, list_notes, update_note, delete_note, list_plans, create_plan, toggle_plan, delete_plan, daily_summary, weekly_summary, get_settings, save_settings]).run(tauri::generate_context!()).expect("failed to run Trace");
}

#[cfg(test)]
mod tests { use super::classify; #[test] fn classifies_unstructured_notes() { assert_eq!(classify("상품 태그 정책 변경").0, "결정"); assert_eq!(classify("AI 자동화 가능할 것 같음").0, "아이디어"); assert_eq!(classify("인스타 범위 질문").0, "질문"); } }
