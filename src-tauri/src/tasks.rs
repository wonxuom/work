use crate::Db;
use rusqlite::{params, Connection};
use serde::Serialize;
use tauri::State;

#[derive(Debug, Serialize)]
pub struct TaskItem {
    id: i64,
    content: String,
    completed: bool,
    due_date: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct Task {
    id: i64,
    title: String,
    goal: String,
    completed: bool,
    items: Vec<TaskItem>,
}

pub fn initialize(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch("PRAGMA foreign_keys=ON;
        CREATE TABLE IF NOT EXISTS tasks (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, goal TEXT NOT NULL, completed INTEGER NOT NULL DEFAULT 0 CHECK(completed IN (0, 1)));
        CREATE TABLE IF NOT EXISTS task_items (id INTEGER PRIMARY KEY AUTOINCREMENT, task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE, content TEXT NOT NULL, completed INTEGER NOT NULL DEFAULT 0 CHECK(completed IN (0, 1)));
        CREATE INDEX IF NOT EXISTS idx_task_items_task ON task_items(task_id);")?;
    // Scheduling a checklist item for a date is what puts it on that day's todo list.
    conn.execute("ALTER TABLE task_items ADD COLUMN due_date TEXT", [])
        .or_else(|e| {
            if e.to_string().contains("duplicate column name") {
                Ok(0)
            } else {
                Err(e)
            }
        })?;
    conn.execute_batch("CREATE INDEX IF NOT EXISTS idx_task_items_due ON task_items(due_date);")
}

fn text(value: &str) -> Result<&str, String> {
    let value = value.trim();
    if value.is_empty() || value.chars().count() > 10_000 {
        return Err("내용을 1–10,000자 이내로 입력하세요.".into());
    }
    Ok(value)
}

fn goal_text(value: &str) -> Result<&str, String> {
    let value = value.trim();
    if value.chars().count() > 10_000 {
        return Err("목표를 10,000자 이내로 입력하세요.".into());
    }
    Ok(value)
}

fn valid_date(value: Option<String>) -> Result<Option<String>, String> {
    match value {
        Some(date) if chrono::NaiveDate::parse_from_str(&date, "%Y-%m-%d").is_err() => {
            Err("올바른 날짜를 선택하세요.".into())
        }
        value => Ok(value),
    }
}

pub fn select_tasks(conn: &Connection) -> Result<Vec<Task>, String> {
    let mut parents = conn
        .prepare("SELECT id, title, goal, completed FROM tasks ORDER BY completed, id DESC")
        .map_err(|e| e.to_string())?;
    let mut tasks = parents
        .query_map([], |row| {
            Ok(Task {
                id: row.get(0)?,
                title: row.get(1)?,
                goal: row.get(2)?,
                completed: row.get(3)?,
                items: vec![],
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    let mut children = conn
        .prepare(
            "SELECT id, content, completed, due_date FROM task_items WHERE task_id=?1 ORDER BY id",
        )
        .map_err(|e| e.to_string())?;
    for task in &mut tasks {
        task.items = children
            .query_map([task.id], |row| {
                Ok(TaskItem {
                    id: row.get(0)?,
                    content: row.get(1)?,
                    completed: row.get(2)?,
                    due_date: row.get(3)?,
                })
            })
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?;
    }
    Ok(tasks)
}

fn insert_task(conn: &Connection, title: &str, goal: &str) -> Result<i64, String> {
    conn.execute(
        "INSERT INTO tasks (title, goal) VALUES (?1, ?2)",
        params![text(title)?, goal_text(goal)?],
    )
    .map_err(|e| e.to_string())?;
    Ok(conn.last_insert_rowid())
}

fn insert_item(conn: &Connection, task_id: i64, content: &str) -> Result<(), String> {
    conn.execute(
        "INSERT INTO task_items (task_id, content) VALUES (?1, ?2)",
        params![task_id, text(content)?],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

fn changed(result: rusqlite::Result<usize>) -> Result<(), String> {
    if result.map_err(|e| e.to_string())? == 0 {
        return Err("이미 삭제된 항목입니다. 목록을 다시 확인하세요.".into());
    }
    Ok(())
}

#[tauri::command]
pub fn list_tasks(db: State<Db>) -> Result<Vec<Task>, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    select_tasks(&conn)
}

#[tauri::command]
pub fn create_task(title: String, goal: String, db: State<Db>) -> Result<i64, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    insert_task(&conn, &title, &goal)
}

#[tauri::command]
pub fn update_task(
    id: i64,
    title: String,
    goal: String,
    completed: bool,
    db: State<Db>,
) -> Result<(), String> {
    changed(db.0.lock().map_err(|e| e.to_string())?.execute(
        "UPDATE tasks SET title=?1, goal=?2, completed=?3 WHERE id=?4",
        params![text(&title)?, goal_text(&goal)?, completed, id],
    ))
}

#[tauri::command]
pub fn delete_task(id: i64, db: State<Db>) -> Result<(), String> {
    changed(
        db.0.lock()
            .map_err(|e| e.to_string())?
            .execute("DELETE FROM tasks WHERE id=?1", [id]),
    )
}

#[tauri::command]
pub fn create_task_item(task_id: i64, content: String, db: State<Db>) -> Result<(), String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    insert_item(&conn, task_id, &content)
}

#[tauri::command]
pub fn update_task_item(
    id: i64,
    content: String,
    completed: bool,
    due_date: Option<String>,
    db: State<Db>,
) -> Result<(), String> {
    changed(db.0.lock().map_err(|e| e.to_string())?.execute(
        "UPDATE task_items SET content=?1, completed=?2, due_date=?3 WHERE id=?4",
        params![text(&content)?, completed, valid_date(due_date)?, id],
    ))
}

#[tauri::command]
pub fn delete_task_item(id: i64, db: State<Db>) -> Result<(), String> {
    changed(
        db.0.lock()
            .map_err(|e| e.to_string())?
            .execute("DELETE FROM task_items WHERE id=?1", [id]),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tasks_survive_dates_and_reload_without_changing_daily_plans() {
        let path = std::env::temp_dir().join(format!("trace-tasks-test-{}.db", std::process::id()));
        let conn = Connection::open(&path).unwrap();
        conn.execute_batch("CREATE TABLE plans (id INTEGER PRIMARY KEY, date TEXT, content TEXT); INSERT INTO plans VALUES (1, '2026-09-17', '오늘 할 일');").unwrap();
        initialize(&conn).unwrap();
        initialize(&conn).unwrap();
        assert!(insert_task(&conn, " ", "목표").is_err());
        assert!(insert_task(&conn, "업무", " ").is_ok());
        let id = insert_task(&conn, " 출시 준비 ", " 고객에게 새 제품 공개 ").unwrap();
        insert_item(&conn, id, " 요구사항 정리 ").unwrap();
        assert!(insert_item(&conn, id, " ").is_err());
        assert!(insert_item(&conn, id + 1, "잘못된 태스크").is_err());
        assert!(valid_date(Some("9월 17일".into())).is_err());
        conn.execute(
            "UPDATE task_items SET completed=1, due_date=?1 WHERE task_id=?2",
            params![valid_date(Some("2026-09-17".into())).unwrap(), id],
        )
        .unwrap();
        drop(conn);
        let conn = Connection::open(&path).unwrap();
        initialize(&conn).unwrap();
        let tasks = select_tasks(&conn).unwrap();
        assert_eq!(
            (&tasks[0].title[..], &tasks[0].goal[..]),
            ("출시 준비", "고객에게 새 제품 공개")
        );
        assert_eq!(tasks[0].items[0].content, "요구사항 정리");
        assert!(tasks[0].items[0].completed);
        assert_eq!(tasks[0].items[0].due_date.as_deref(), Some("2026-09-17"));
        conn.execute("UPDATE tasks SET completed=1 WHERE id=?1", [id])
            .unwrap();
        assert!(select_tasks(&conn).unwrap().iter().any(|task| task.id == id && task.completed));
        conn.execute("DELETE FROM tasks WHERE id=?1", [id]).unwrap();
        assert_eq!(
            conn.query_row("SELECT COUNT(*) FROM task_items", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            0
        );
        assert_eq!(
            conn.query_row("SELECT content FROM plans WHERE id=1", [], |r| r
                .get::<_, String>(0))
                .unwrap(),
            "오늘 할 일"
        );
        drop(conn);
        std::fs::remove_file(path).unwrap();
    }
}
