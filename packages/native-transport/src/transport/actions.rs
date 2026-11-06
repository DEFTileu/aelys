//! `aelys-desktop --action`: three fixed commands for macOS Shortcuts. Requests
//! go through the same signed broker and typed allowlist as the MCP tools.
use super::{err, mcp::forward};
use chrono::{DateTime, Local, NaiveDate, SecondsFormat, TimeZone, Utc};
use ring::rand::{SecureRandom, SystemRandom};
use serde::{de::DeserializeOwned, Deserialize};
use serde_json::{json, Value};
use std::fmt::Display;
use std::io::Read;

const USAGE: &str = "Usage: aelys-desktop --action task <title> [--due <ISO-8601 with offset>] [--notes <text>] | note <title> [<body> | -] | today";
const MAX_BODY: usize = 500_000;

#[derive(Debug, PartialEq)]
enum Body {
    Text(String),
    /// `-` in the note body position: read the body from stdin (Shortcut input).
    Stdin,
}

#[derive(Debug, PartialEq)]
enum Action {
    Task {
        title: String,
        due: Option<String>,
        notes: String,
    },
    Note {
        title: String,
        body: Body,
    },
    Today,
}

#[derive(Deserialize)]
struct Occurrence {
    title: String,
    starts_at: String,
    ends_at: String,
    all_day: bool,
}

#[derive(Deserialize)]
struct TaskRow {
    title: String,
    status: String,
    due_at: Option<String>,
}

fn title(arg: Option<&String>) -> Result<String, String> {
    let title = arg.map_or("", |s| s.trim());
    let len = title.chars().count();
    if (1..=300).contains(&len) && !title.starts_with("--") && !title.chars().any(char::is_control)
    {
        Ok(title.to_owned())
    } else {
        Err(USAGE.into())
    }
}

fn normalize_due(value: &str) -> Result<String, String> {
    DateTime::parse_from_rfc3339(value.trim())
        .map(|at| {
            at.with_timezone(&Utc)
                .to_rfc3339_opts(SecondsFormat::Secs, true)
        })
        .map_err(|_| USAGE.into())
}

fn parse(args: &[String]) -> Result<Action, String> {
    let rest = args.get(2..).unwrap_or_default();
    match args.first().map(String::as_str) {
        Some("task") => {
            let (mut due, mut notes) = (None, String::new());
            let mut flags = rest.iter();
            while let Some(flag) = flags.next() {
                let value = flags.next().ok_or(USAGE)?;
                match flag.as_str() {
                    "--due" => due = Some(normalize_due(value)?),
                    "--notes" => notes = value.clone(),
                    _ => return Err(USAGE.into()),
                }
            }
            Ok(Action::Task {
                title: title(args.get(1))?,
                due,
                notes,
            })
        }
        Some("note") if rest.len() <= 1 => Ok(Action::Note {
            title: title(args.get(1))?,
            body: match rest.first().map(String::as_str) {
                None => Body::Text(String::new()),
                Some("-") => Body::Stdin,
                Some(text) => Body::Text(text.to_owned()),
            },
        }),
        Some("today") if args.len() == 1 => Ok(Action::Today),
        _ => Err(USAGE.into()),
    }
}

/// Exit code and the only text shown for a broker/runtime error code.
fn exit_for(code: &str) -> (i32, String) {
    match code {
        "AELYS_NOT_RUNNING" | "SIGN_IN_REQUIRED" => (3, "Open Aelys and sign in first.".into()),
        "MCP_DISABLED" => (
            4,
            "Run: aelys-mcp enable (once) to allow local actions.".into(),
        ),
        other => (1, other.into()),
    }
}

fn new_request_id() -> Result<String, String> {
    let mut bytes = [0u8; 16];
    SystemRandom::new()
        .fill(&mut bytes)
        .map_err(|_| err("STORAGE_ERROR"))?;
    Ok(bytes.iter().map(|b| format!("{b:02x}")).collect())
}

fn write(operation: Value) -> Result<(), String> {
    let request_id = new_request_id()?;
    forward(
        &json!({"operation":operation,"request_id":request_id}),
        true,
    )
    .map(|_| ())
}

fn read<T: DeserializeOwned>(operation: Value) -> Result<T, String> {
    serde_json::from_value(forward(&json!({ "operation": operation }), false)?)
        .map_err(|_| err("INVALID_RESPONSE"))
}

fn body(source: Body) -> Result<String, String> {
    match source {
        Body::Text(text) => Ok(text),
        Body::Stdin => {
            let mut text = String::new();
            std::io::stdin()
                .take(MAX_BODY as u64 + 1)
                .read_to_string(&mut text)
                .map_err(|_| err("STDIN_ERROR"))?;
            if text.len() > MAX_BODY {
                Err(err("BODY_TOO_LARGE"))
            } else {
                Ok(text)
            }
        }
    }
}

/// [start, end) of a calendar day in `tz`, as UTC instants.
fn day_bounds<Tz: TimeZone>(tz: &Tz, date: NaiveDate) -> Option<(DateTime<Utc>, DateTime<Utc>)> {
    // shortcut: a midnight that falls inside a DST gap fails with TIME_ERROR, upgrade if reported.
    let start = tz
        .from_local_datetime(&date.and_hms_opt(0, 0, 0)?)
        .earliest()?;
    let end = tz
        .from_local_datetime(&date.succ_opt()?.and_hms_opt(0, 0, 0)?)
        .earliest()?;
    Some((start.with_timezone(&Utc), end.with_timezone(&Utc)))
}

fn one_line(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// Same terminal set as backend briefings.py and task_clock.py; compared case-insensitively.
fn is_terminal(status: &str) -> bool {
    const TERMINAL: [&str; 5] = ["done", "completed", "complete", "closed", "cancelled"];
    let status = status.trim().to_ascii_lowercase();
    TERMINAL.contains(&status.as_str())
}

fn agenda<Tz: TimeZone>(
    tz: &Tz,
    (start, end): (DateTime<Utc>, DateTime<Utc>),
    events: &[Occurrence],
    tasks: &[TaskRow],
) -> Result<String, String>
where
    Tz::Offset: Display,
{
    let at = |s: &str| {
        DateTime::parse_from_rfc3339(s)
            .map(|t| t.with_timezone(&Utc))
            .map_err(|_| err("INVALID_RESPONSE"))
    };
    let mut lines = Vec::new();
    for event in events {
        let (from, to) = (at(&event.starts_at)?, at(&event.ends_at)?);
        let title = one_line(&event.title);
        let text = if event.all_day {
            format!("All day {title}")
        } else {
            format!(
                "{}–{} {title}",
                from.with_timezone(tz).format("%H:%M"),
                to.with_timezone(tz).format("%H:%M")
            )
        };
        lines.push((from, text));
    }
    for task in tasks {
        let Some(due_at) = task.due_at.as_deref() else {
            continue;
        };
        let due = at(due_at)?;
        if (start..end).contains(&due) && !is_terminal(&task.status) {
            lines.push((
                due,
                format!(
                    "{} Task: {}",
                    due.with_timezone(tz).format("%H:%M"),
                    one_line(&task.title)
                ),
            ));
        }
    }
    if lines.is_empty() {
        return Ok("No events today.".into());
    }
    lines.sort_by_key(|(at, _)| *at);
    Ok(lines
        .into_iter()
        .map(|(_, line)| line)
        .collect::<Vec<_>>()
        .join("\n"))
}

fn today<Tz: TimeZone>(tz: &Tz, date: NaiveDate) -> Result<String, String>
where
    Tz::Offset: Display,
{
    let bounds = day_bounds(tz, date).ok_or_else(|| err("TIME_ERROR"))?;
    let (starts_at, ends_at) = (
        bounds.0.to_rfc3339_opts(SecondsFormat::Secs, true),
        bounds.1.to_rfc3339_opts(SecondsFormat::Secs, true),
    );
    let events: Vec<Occurrence> =
        read(json!({"type":"calendar_occurrences","starts_at":starts_at,"ends_at":ends_at}))?;
    let tasks: Vec<TaskRow> = read(json!({"type":"tasks","project_id":null}))?;
    agenda(tz, bounds, &events, &tasks)
}

fn execute(action: Action) -> Result<String, String> {
    match action {
        Action::Task { title, due, notes } => {
            write(
                json!({"type":"task_create","task":{"title":title,"description":notes,"project_id":null,"parent_task_id":null,"status":"todo","priority":0,"due_at":due,"due_timezone":null,"rrule":null}}),
            )?;
            Ok(format!("Task created: {title}"))
        }
        Action::Note {
            title,
            body: source,
        } => {
            let markdown_body = body(source)?;
            write(
                json!({"type":"note_create","note":{"title":title,"markdown_body":markdown_body}}),
            )?;
            Ok(format!("Note created: {title}"))
        }
        Action::Today => today(&Local, Local::now().date_naive()),
    }
}

pub fn run_action(args: Vec<String>) -> i32 {
    let action = match parse(&args) {
        Ok(action) => action,
        Err(usage) => {
            eprintln!("{usage}");
            return 2;
        }
    };
    match execute(action) {
        Ok(text) => {
            println!("{text}");
            0
        }
        Err(code) => {
            let (exit, message) = exit_for(&code);
            eprintln!("{message}");
            exit
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::FixedOffset;

    fn args(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn parses_task_with_due_and_notes() {
        assert_eq!(
            parse(&args(&[
                "task",
                "  Buy milk ",
                "--due",
                "2026-11-06T18:00:00+05:00",
                "--notes",
                "2 l"
            ]))
            .unwrap(),
            Action::Task {
                title: "Buy milk".into(),
                due: Some("2026-11-06T13:00:00Z".into()),
                notes: "2 l".into()
            }
        );
    }

    #[test]
    fn rejects_bad_task_input() {
        let long = "x".repeat(301);
        let cases: [&[&str]; 7] = [
            &["task"],
            &["task", "   "],
            &["task", "a\nb"],
            &["task", "--due"],
            &["task", "x", "--due", "tomorrow"],
            &["task", "x", "--bogus", "1"],
            &["task", long.as_str()],
        ];
        for case in cases {
            assert!(parse(&args(case)).is_err(), "{case:?}");
        }
    }

    #[test]
    fn parses_note_body_forms_and_today() {
        assert_eq!(
            parse(&args(&["note", "T"])).unwrap(),
            Action::Note {
                title: "T".into(),
                body: Body::Text(String::new())
            }
        );
        assert_eq!(
            parse(&args(&["note", "T", "-"])).unwrap(),
            Action::Note {
                title: "T".into(),
                body: Body::Stdin
            }
        );
        assert!(parse(&args(&["note", "T", "a", "b"])).is_err());
        assert_eq!(parse(&args(&["today"])).unwrap(), Action::Today);
        assert!(parse(&args(&["today", "x"])).is_err());
        assert!(parse(&args(&[])).is_err());
    }

    #[test]
    fn maps_error_codes_to_exit_codes() {
        assert_eq!(exit_for("AELYS_NOT_RUNNING").0, 3);
        assert_eq!(exit_for("SIGN_IN_REQUIRED").0, 3);
        assert_eq!(exit_for("MCP_DISABLED").0, 4);
        assert_eq!(
            exit_for("MCP_POLICY_DENIED"),
            (1, "MCP_POLICY_DENIED".into())
        );
    }

    #[test]
    fn request_ids_are_valid_and_fresh() {
        let (a, b) = (new_request_id().unwrap(), new_request_id().unwrap());
        assert_eq!(a.len(), 32);
        assert!(a.bytes().all(|c| c.is_ascii_hexdigit()));
        assert_ne!(a, b);
    }

    #[test]
    fn agenda_formats_local_day_and_skips_done_tasks() {
        let tz = FixedOffset::east_opt(5 * 3600).unwrap();
        let bounds = day_bounds(&tz, NaiveDate::from_ymd_opt(2026, 11, 6).unwrap()).unwrap();
        assert_eq!(
            bounds.0.to_rfc3339_opts(SecondsFormat::Secs, true),
            "2026-11-05T19:00:00Z"
        );
        let events = vec![
            Occurrence {
                title: "Lecture".into(),
                starts_at: "2026-11-06T04:30:00Z".into(),
                ends_at: "2026-11-06T05:20:00Z".into(),
                all_day: false,
            },
            Occurrence {
                title: "Holiday".into(),
                starts_at: "2026-11-05T19:00:00Z".into(),
                ends_at: "2026-11-06T19:00:00Z".into(),
                all_day: true,
            },
        ];
        let task = |title: &str, status: &str, due: &str| TaskRow {
            title: title.into(),
            status: status.into(),
            due_at: Some(due.into()),
        };
        let tasks = vec![
            task("Essay", "planned", "2026-11-06T12:00:00Z"),
            task("Old", "done", "2026-11-06T12:00:00Z"),
            task("Finished", "Completed", "2026-11-06T13:00:00Z"),
            task("Later", "planned", "2026-11-07T12:00:00Z"),
        ];
        assert_eq!(
            agenda(&tz, bounds, &events, &tasks).unwrap(),
            "All day Holiday\n09:30–10:20 Lecture\n17:00 Task: Essay"
        );
        assert_eq!(agenda(&tz, bounds, &[], &[]).unwrap(), "No events today.");
    }
}
