use crate::Db;
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use tauri::State;

/// One row of a day's manual order. A day mixes its own plans with task items due that day.
#[derive(Debug, Serialize, Deserialize, PartialEq)]
pub struct DayOrderEntry {
    kind: String,
    item_id: i64,
}

pub fn initialize(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch("CREATE TABLE IF NOT EXISTS day_order (date TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('plan', 'task_item')), item_id INTEGER NOT NULL, position INTEGER NOT NULL, PRIMARY KEY (date, kind, item_id));")
}

fn select_order(conn: &Connection, date: &str) -> Result<Vec<DayOrderEntry>, String> {
    let mut statement = conn
        .prepare("SELECT kind, item_id FROM day_order WHERE date=?1 ORDER BY position")
        .map_err(|e| e.to_string())?;
    let entries = statement
        .query_map([date], |row| {
            Ok(DayOrderEntry {
                kind: row.get(0)?,
                item_id: row.get(1)?,
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string());
    entries
}

fn replace_order(
    conn: &mut Connection,
    date: &str,
    entries: &[DayOrderEntry],
) -> Result<(), String> {
    if chrono::NaiveDate::parse_from_str(date, "%Y-%m-%d").is_err() {
        return Err("올바른 날짜를 선택하세요.".into());
    }
    // Rows left over from deleted or unscheduled items are dropped by replacing the whole day.
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    tx.execute("DELETE FROM day_order WHERE date=?1", [date])
        .map_err(|e| e.to_string())?;
    for (position, entry) in entries.iter().enumerate() {
        tx.execute(
            "INSERT INTO day_order (date, kind, item_id, position) VALUES (?1, ?2, ?3, ?4)",
            params![date, entry.kind, entry.item_id, position as i64],
        )
        .map_err(|e| e.to_string())?;
    }
    tx.commit().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn list_day_order(date: String, db: State<Db>) -> Result<Vec<DayOrderEntry>, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    select_order(&conn, &date)
}

#[tauri::command]
pub fn set_day_order(
    date: String,
    entries: Vec<DayOrderEntry>,
    db: State<Db>,
) -> Result<(), String> {
    let mut conn = db.0.lock().map_err(|e| e.to_string())?;
    replace_order(&mut conn, &date, &entries)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(kind: &str, item_id: i64) -> DayOrderEntry {
        DayOrderEntry {
            kind: kind.into(),
            item_id,
        }
    }

    #[test]
    fn replaces_a_days_order_without_touching_other_days() {
        let mut conn = Connection::open_in_memory().unwrap();
        initialize(&conn).unwrap();
        replace_order(
            &mut conn,
            "2026-09-17",
            &[entry("plan", 1), entry("task_item", 1)],
        )
        .unwrap();
        replace_order(&mut conn, "2026-09-18", &[entry("plan", 2)]).unwrap();
        replace_order(
            &mut conn,
            "2026-09-17",
            &[entry("task_item", 1), entry("plan", 1)],
        )
        .unwrap();
        assert_eq!(
            select_order(&conn, "2026-09-17").unwrap(),
            vec![entry("task_item", 1), entry("plan", 1)]
        );
        assert_eq!(
            select_order(&conn, "2026-09-18").unwrap(),
            vec![entry("plan", 2)]
        );
        assert!(replace_order(&mut conn, "9월 17일", &[]).is_err());
        assert!(replace_order(&mut conn, "2026-09-17", &[entry("note", 1)]).is_err());
        assert_eq!(select_order(&conn, "2026-09-17").unwrap().len(), 2);
    }
}
