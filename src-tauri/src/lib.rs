use chrono::{Duration, Local};
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use std::{fs, path::PathBuf, sync::Mutex};
use tauri::{Manager, State};
mod day_order;
mod tasks;
mod window_blur;

struct Db(Mutex<Connection>);

#[derive(Debug, Serialize)]
struct Note {
    id: i64,
    content: String,
    created_at: String,
    updated_at: String,
    tags: Vec<String>,
    project: Option<String>,
    category: String,
}
#[derive(Debug, Serialize)]
struct Plan {
    id: i64,
    date: String,
    priority: String,
    content: String,
    memo: String,
    completed: bool,
}
#[derive(Debug, Serialize)]
struct DayActivity {
    date: String,
    total: i64,
    completed: i64,
}
#[derive(Serialize)]
struct Summary {
    completed: Vec<Plan>,
    pending: Vec<Plan>,
    decisions: Vec<Note>,
    work: Vec<Note>,
    ideas: Vec<Note>,
    questions: Vec<Note>,
    feedback: Vec<Note>,
}
#[derive(Debug, Serialize, Deserialize)]
struct Settings {
    shortcut: String,
    theme: String,
}

#[derive(Serialize)]
struct WorkspaceExport {
    schema_version: u8,
    exported_at: String,
    notes: Vec<Note>,
    plans: Vec<Plan>,
    tasks: Vec<tasks::Task>,
}

fn classify(content: &str) -> (String, Vec<String>, Option<String>) {
    let lower = content.to_lowercase();
    let category = if ["결정", "변경", "확정", "정책"]
        .iter()
        .any(|v| lower.contains(v))
    {
        "결정"
    } else if ["아이디어", "실험", "가능", "자동화"]
        .iter()
        .any(|v| lower.contains(v))
    {
        "아이디어"
    } else if ["질문", "문의", "어떻게", "?"]
        .iter()
        .any(|v| lower.contains(v))
    {
        "질문"
    } else if ["피드백", "수정", "요청"].iter().any(|v| lower.contains(v)) {
        "피드백"
    } else {
        "업무"
    };
    let mut tags: Vec<String> = content
        .split_whitespace()
        .filter_map(|word| word.strip_prefix('#'))
        .map(|tag| tag.trim_matches(|c: char| !c.is_alphanumeric() && c != '-' && c != '_'))
        .filter(|tag| !tag.is_empty())
        .map(str::to_string)
        .collect();
    let project = tags.first().cloned();
    tags.sort();
    tags.dedup();
    (category.to_string(), tags, project)
}

fn row_to_note(row: &rusqlite::Row<'_>) -> rusqlite::Result<Note> {
    let tags: String = row.get(4)?;
    Ok(Note {
        id: row.get(0)?,
        content: row.get(1)?,
        created_at: row.get(2)?,
        updated_at: row.get(3)?,
        tags: serde_json::from_str(&tags).unwrap_or_default(),
        project: row.get(5)?,
        category: row.get(6)?,
    })
}
fn select_notes(conn: &Connection, sql: &str, value: &str) -> Result<Vec<Note>, String> {
    let mut statement = conn.prepare(sql).map_err(|e| e.to_string())?;
    if statement.parameter_count() == 0 {
        statement
            .query_map([], row_to_note)
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())
    } else {
        statement
            .query_map(params![value], row_to_note)
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())
    }
}

#[tauri::command]
fn create_note(content: String, db: State<Db>) -> Result<Note, String> {
    let content = content.trim();
    if content.is_empty() {
        return Err("내용이 비어 있습니다.".into());
    }
    let (category, tags, project) = classify(content);
    let now = Local::now().to_rfc3339();
    let tags_json = serde_json::to_string(&tags).map_err(|e| e.to_string())?;
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    conn.execute("INSERT INTO notes (content, created_at, updated_at, tags, project, category) VALUES (?1, ?2, ?2, ?3, ?4, ?5)", params![content, now, tags_json, project, category]).map_err(|e| e.to_string())?;
    Ok(Note {
        id: conn.last_insert_rowid(),
        content: content.into(),
        created_at: now.clone(),
        updated_at: now,
        tags,
        project,
        category,
    })
}
#[tauri::command]
fn list_notes(query: String, db: State<Db>) -> Result<Vec<Note>, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    if query.trim().is_empty() {
        select_notes(&conn, "SELECT id, content, created_at, updated_at, tags, project, category FROM notes ORDER BY created_at DESC", "")
    } else {
        let cleaned = query
            .replace("보여줘", "")
            .replace("찾아줘", "")
            .replace("모아줘", "")
            .replace("정리해줘", "");
        let keyword = cleaned.trim();
        select_notes(&conn, "SELECT id, content, created_at, updated_at, tags, project, category FROM notes WHERE content LIKE '%' || ?1 || '%' OR tags LIKE '%' || ?1 || '%' OR COALESCE(project, '') LIKE '%' || ?1 || '%' OR category LIKE '%' || ?1 || '%' ORDER BY created_at DESC", keyword)
    }
}
#[tauri::command]
fn update_note(
    id: i64,
    content: String,
    tags: Vec<String>,
    project: Option<String>,
    category: String,
    db: State<Db>,
) -> Result<Note, String> {
    let content = content.trim().to_string();
    if content.is_empty() {
        return Err("내용이 비어 있습니다.".into());
    }
    let (inferred_category, inferred_tags, inferred_project) = classify(&content);
    let category = if ["업무", "결정", "아이디어", "질문", "피드백"].contains(&category.as_str())
    {
        category
    } else {
        inferred_category
    };
    let tags = if tags.is_empty() { inferred_tags } else { tags };
    let project = project
        .filter(|value| !value.trim().is_empty())
        .map(|value| value.trim().to_string())
        .or(inferred_project);
    let now = Local::now().to_rfc3339();
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    conn.execute(
        "UPDATE notes SET content=?1, updated_at=?2, tags=?3, project=?4, category=?5 WHERE id=?6",
        params![
            content,
            now,
            serde_json::to_string(&tags).unwrap_or("[]".into()),
            project,
            category,
            id
        ],
    )
    .map_err(|e| e.to_string())?;
    let created_at = conn
        .query_row(
            "SELECT created_at FROM notes WHERE id=?1",
            params![id],
            |row| row.get(0),
        )
        .map_err(|e| e.to_string())?;
    Ok(Note {
        id,
        content,
        created_at,
        updated_at: now,
        tags,
        project,
        category,
    })
}
#[tauri::command]
fn delete_note(id: i64, db: State<Db>) -> Result<(), String> {
    db.0.lock()
        .map_err(|e| e.to_string())?
        .execute("DELETE FROM notes WHERE id=?1", params![id])
        .map_err(|e| e.to_string())?;
    Ok(())
}
fn row_to_plan(row: &rusqlite::Row<'_>) -> rusqlite::Result<Plan> {
    Ok(Plan {
        id: row.get(0)?,
        date: row.get(1)?,
        priority: row.get(2)?,
        content: row.get(3)?,
        completed: row.get::<_, i64>(4)? != 0,
        memo: row.get(5)?,
    })
}
fn select_plans(conn: &Connection, date: &str) -> Result<Vec<Plan>, String> {
    let mut statement = conn.prepare("SELECT id, date, priority, content, completed, memo FROM plans WHERE date=?1 ORDER BY CASE priority WHEN 'Must' THEN 1 WHEN 'Should' THEN 2 ELSE 3 END, id").map_err(|e| e.to_string())?;
    let result = statement
        .query_map(params![date], row_to_plan)
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string());
    result
}
#[tauri::command]
fn list_plans(date: Option<String>, db: State<Db>) -> Result<Vec<Plan>, String> {
    let date = date.unwrap_or_else(|| Local::now().format("%Y-%m-%d").to_string());
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    select_plans(&conn, &date)
}
fn select_plan_activity(conn: &Connection, month: &str) -> Result<Vec<DayActivity>, String> {
    let mut statement = conn
        .prepare("SELECT date, COUNT(*), SUM(completed) FROM (SELECT date, completed FROM plans UNION ALL SELECT due_date, completed FROM task_items WHERE due_date IS NOT NULL) WHERE substr(date, 1, 7)=?1 GROUP BY date ORDER BY date")
        .map_err(|e| e.to_string())?;
    let result = statement
        .query_map(params![month], |row| {
            Ok(DayActivity {
                date: row.get(0)?,
                total: row.get(1)?,
                completed: row.get(2)?,
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string());
    result
}
#[tauri::command]
fn plan_activity(month: String, db: State<Db>) -> Result<Vec<DayActivity>, String> {
    if month.len() != 7
        || !month.as_bytes()[..]
            .iter()
            .enumerate()
            .all(|(index, byte)| index == 4 && *byte == b'-' || index != 4 && byte.is_ascii_digit())
    {
        return Err("올바른 달을 선택하세요.".into());
    }
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    select_plan_activity(&conn, &month)
}
#[tauri::command]
fn create_plan(
    priority: String,
    content: String,
    date: Option<String>,
    db: State<Db>,
) -> Result<Plan, String> {
    if !["Must", "Should", "Could"].contains(&priority.as_str()) || content.trim().is_empty() {
        return Err("올바른 계획을 입력하세요.".into());
    }
    let date = date.unwrap_or_else(|| Local::now().format("%Y-%m-%d").to_string());
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    conn.execute(
        "INSERT INTO plans (date, priority, content, completed, memo) VALUES (?1, ?2, ?3, 0, '')",
        params![date, priority, content.trim()],
    )
    .map_err(|e| e.to_string())?;
    Ok(Plan {
        id: conn.last_insert_rowid(),
        date,
        priority,
        content: content.trim().into(),
        memo: String::new(),
        completed: false,
    })
}
#[tauri::command]
fn update_plan(id: i64, content: String, memo: String, db: State<Db>) -> Result<Plan, String> {
    if content.trim().is_empty() {
        return Err("올바른 계획을 입력하세요.".into());
    }
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    conn.execute(
        "UPDATE plans SET content=?1, memo=?2 WHERE id=?3",
        params![content.trim(), memo.trim(), id],
    )
    .map_err(|e| e.to_string())?;
    conn.query_row(
        "SELECT id, date, priority, content, completed, memo FROM plans WHERE id=?1",
        params![id],
        row_to_plan,
    )
    .map_err(|e| e.to_string())
}
#[tauri::command]
fn toggle_plan(id: i64, completed: bool, db: State<Db>) -> Result<(), String> {
    db.0.lock()
        .map_err(|e| e.to_string())?
        .execute(
            "UPDATE plans SET completed=?1 WHERE id=?2",
            params![completed as i64, id],
        )
        .map_err(|e| e.to_string())?;
    Ok(())
}
#[tauri::command]
fn delete_plan(id: i64, db: State<Db>) -> Result<(), String> {
    db.0.lock()
        .map_err(|e| e.to_string())?
        .execute("DELETE FROM plans WHERE id=?1", params![id])
        .map_err(|e| e.to_string())?;
    Ok(())
}
#[tauri::command]
fn daily_summary(date: Option<String>, db: State<Db>) -> Result<Summary, String> {
    let date = date.unwrap_or_else(|| Local::now().format("%Y-%m-%d").to_string());
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    let notes = select_notes(&conn, "SELECT id, content, created_at, updated_at, tags, project, category FROM notes WHERE substr(created_at, 1, 10)=?1 ORDER BY created_at DESC", &date)?;
    let (completed, pending) = select_plans(&conn, &date)?
        .into_iter()
        .partition(|plan| plan.completed);
    let mut summary = Summary {
        completed,
        pending,
        decisions: vec![],
        work: vec![],
        ideas: vec![],
        questions: vec![],
        feedback: vec![],
    };
    for note in notes {
        match note.category.as_str() {
            "결정" => summary.decisions.push(note),
            "아이디어" => summary.ideas.push(note),
            "질문" => summary.questions.push(note),
            "피드백" => summary.feedback.push(note),
            _ => summary.work.push(note),
        }
    }
    Ok(summary)
}
#[tauri::command]
fn weekly_summary(db: State<Db>) -> Result<Vec<String>, String> {
    let since = (Local::now().date_naive() - Duration::days(6))
        .format("%Y-%m-%d")
        .to_string();
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    let notes = select_notes(&conn, "SELECT id, content, created_at, updated_at, tags, project, category FROM notes WHERE substr(created_at, 1, 10)>=?1 ORDER BY created_at DESC", &since)?;
    if notes.is_empty() {
        return Ok(vec![]);
    }
    let decisions = notes.iter().filter(|n| n.category == "결정").count();
    let ideas = notes.iter().filter(|n| n.category == "아이디어").count();
    let mut projects: Vec<String> = notes.iter().filter_map(|n| n.project.clone()).collect();
    projects.sort();
    projects.dedup();
    Ok(vec![
        format!("최근 7일간 업무 기록은 {}개입니다.", notes.len()),
        format!(
            "주요 결정 {}개, 아이디어 {}개가 기록됐습니다.",
            decisions, ideas
        ),
        if projects.is_empty() {
            "프로젝트 태그가 지정된 기록은 없습니다.".into()
        } else {
            format!("활성 프로젝트: {}", projects.join(", "))
        },
    ])
}
fn settings_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_config_dir()
        .map(|path| path.join("settings.json"))
        .map_err(|e| e.to_string())
}
#[tauri::command]
fn get_settings(app: tauri::AppHandle) -> Settings {
    fs::read_to_string(settings_path(&app).unwrap_or_default())
        .ok()
        .and_then(|v| serde_json::from_str(&v).ok())
        .unwrap_or(Settings {
            shortcut: "CommandOrControl+;".into(),
            theme: "system".into(),
        })
}
#[tauri::command]
fn save_settings(settings: Settings, app: tauri::AppHandle) -> Result<(), String> {
    let path = settings_path(&app)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    fs::write(
        path,
        serde_json::to_vec_pretty(&settings).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())
}

#[tauri::command]
fn export_data(app: tauri::AppHandle, db: State<Db>) -> Result<String, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    let notes = select_notes(&conn, "SELECT id, content, created_at, updated_at, tags, project, category FROM notes ORDER BY created_at DESC", "")?;
    let mut statement = conn
        .prepare(
            "SELECT id, date, priority, content, completed, memo FROM plans ORDER BY date DESC, id",
        )
        .map_err(|e| e.to_string())?;
    let plans = statement
        .query_map([], row_to_plan)
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    let export = WorkspaceExport {
        schema_version: 2,
        exported_at: Local::now().to_rfc3339(),
        notes,
        plans,
        tasks: tasks::select_tasks(&conn)?,
    };
    let dir = app
        .path()
        .download_dir()
        .or_else(|_| app.path().app_data_dir())
        .map_err(|e| e.to_string())?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = dir.join(format!(
        "trace-export-{}.json",
        Local::now().format("%Y%m%d-%H%M%S")
    ));
    fs::write(
        &path,
        serde_json::to_vec_pretty(&export).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;
    Ok(path.to_string_lossy().into_owned())
}

pub fn run() {
    tauri::Builder::default().plugin(tauri_plugin_global_shortcut::Builder::new().build()).setup(|app| {
        let dir = app.path().app_data_dir()?; fs::create_dir_all(&dir)?; let conn = Connection::open(dir.join("trace.db"))?;
        conn.execute_batch("CREATE TABLE IF NOT EXISTS notes (id INTEGER PRIMARY KEY AUTOINCREMENT, content TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, tags TEXT NOT NULL DEFAULT '[]', project TEXT, category TEXT NOT NULL DEFAULT '업무'); CREATE TABLE IF NOT EXISTS plans (id INTEGER PRIMARY KEY AUTOINCREMENT, date TEXT NOT NULL, priority TEXT NOT NULL CHECK(priority IN ('Must','Should','Could')), content TEXT NOT NULL, completed INTEGER NOT NULL DEFAULT 0);")?;
        conn.execute("ALTER TABLE plans ADD COLUMN memo TEXT NOT NULL DEFAULT ''", []).or_else(|e| if e.to_string().contains("duplicate column name") { Ok(0) } else { Err(e) })?;
        conn.execute_batch("CREATE INDEX IF NOT EXISTS idx_plans_date ON plans(date); CREATE INDEX IF NOT EXISTS idx_notes_created_at ON notes(created_at); CREATE INDEX IF NOT EXISTS idx_notes_category ON notes(category);")?;
        tasks::initialize(&conn)?;
        day_order::initialize(&conn)?;
        app.manage(Db(Mutex::new(conn))); Ok(())
    }).invoke_handler(tauri::generate_handler![day_order::list_day_order, day_order::set_day_order, tasks::list_tasks, tasks::create_task, tasks::update_task, tasks::delete_task, tasks::create_task_item, tasks::update_task_item, tasks::delete_task_item, window_blur::set_window_blur, create_note, list_notes, update_note, delete_note, list_plans, plan_activity, create_plan, update_plan, toggle_plan, delete_plan, daily_summary, weekly_summary, get_settings, save_settings, export_data]).run(tauri::generate_context!()).expect("failed to run Trace");
}

#[cfg(test)]
mod tests {
    use super::{classify, select_notes, select_plan_activity, select_plans};
    use rusqlite::Connection;

    #[test]
    fn classifies_unstructured_notes() {
        assert_eq!(classify("가격 정책 변경 #런칭").0, "결정");
        assert_eq!(classify("자동화 아이디어 #운영").0, "아이디어");
        assert_eq!(
            classify("요구사항 범위 질문 #고객포털").2.as_deref(),
            Some("고객포털")
        );
    }

    #[test]
    fn lists_notes_without_a_search_parameter() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("CREATE TABLE notes (id INTEGER PRIMARY KEY, content TEXT, created_at TEXT, updated_at TEXT, tags TEXT, project TEXT, category TEXT); INSERT INTO notes VALUES (1, '기록', '2026-07-01', '2026-07-01', '[]', NULL, '업무');").unwrap();
        let notes = select_notes(&conn, "SELECT id, content, created_at, updated_at, tags, project, category FROM notes ORDER BY created_at DESC", "").unwrap();
        assert_eq!(notes.len(), 1);
    }

    #[test]
    fn lists_completed_and_pending_plans() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("CREATE TABLE plans (id INTEGER PRIMARY KEY, date TEXT, priority TEXT, content TEXT, completed INTEGER, memo TEXT); INSERT INTO plans VALUES (1, '2026-07-03', 'Must', '완료', 1, ''), (2, '2026-07-03', 'Should', '미완료', 0, '');").unwrap();
        let plans = select_plans(&conn, "2026-07-03").unwrap();
        assert_eq!(plans.iter().filter(|plan| plan.completed).count(), 1);
        assert_eq!(plans.iter().filter(|plan| !plan.completed).count(), 1);
    }

    #[test]
    fn groups_plan_activity_by_day() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("CREATE TABLE plans (id INTEGER PRIMARY KEY, date TEXT, priority TEXT, content TEXT, completed INTEGER, memo TEXT); INSERT INTO plans VALUES (1, '2026-09-01', 'Must', '완료', 1, ''), (2, '2026-09-01', 'Must', '진행', 0, ''), (3, '2026-09-02', 'Must', '완료', 1, ''); CREATE TABLE task_items (id INTEGER PRIMARY KEY, completed INTEGER, due_date TEXT); INSERT INTO task_items VALUES (1, 1, '2026-09-01'), (2, 0, NULL);").unwrap();
        let days = select_plan_activity(&conn, "2026-09").unwrap();
        assert_eq!((days[0].total, days[0].completed), (3, 2));
        assert_eq!((days[1].total, days[1].completed), (1, 1));
    }
}
