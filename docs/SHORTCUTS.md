# macOS Shortcuts

Three actions for the macOS Shortcuts app, using its built-in **Run Shell Script**
action:

- create a task
- create a note
- read today's agenda (events and open tasks due today)

They run through the desktop app's local broker, the same path as the MCP
tools. Aelys must be **open and signed in**; otherwise the action exits with
a message asking you to open it.

## One-time enable

```sh
"$HOME/Applications/Aelys.app/Contents/MacOS/aelys-desktop" --mcp enable
```

This stores a local key in the macOS Keychain. Any local process that can run
the signed app can then read and write your Aelys data while it is open. Revoke
with `--mcp disable`.

## Shortcuts

In the Shortcuts editor, add **Ask for Input** actions where you need text, then
add **Run Shell Script** (Shell: `zsh`). Insert the input values into the script
by tapping their variable chips (for example "Title"), not by typing them.
Use a double-quoted chip for each value and avoid `"` in titles.

### Create a task

1. Add **Ask for Input** (Text), prompt "Task title".
2. Add **Run Shell Script**, Input: **as arguments**:

   ```sh
   "$HOME/Applications/Aelys.app/Contents/MacOS/aelys-desktop" --action task "$1"
   ```

   For a due date or notes, add more Ask for Input actions and use chips:

   ```sh
   "$HOME/Applications/Aelys.app/Contents/MacOS/aelys-desktop" --action task "<Title>" --due "<Due>" --notes "<Notes>"
   ```

   Due must be ISO-8601 with an offset, e.g. `2026-11-06T18:00:00+05:00`.
   Output: `Task created: <title>`.

### Create a note

1. Add **Ask for Input** (Text), prompt "Note title".
2. Add **Run Shell Script**, Input: **to stdin** (the note body is the Shortcut
   input, so it can be long text from any action):

   ```sh
   "$HOME/Applications/Aelys.app/Contents/MacOS/aelys-desktop" --action note "<Note title>" -
   ```

   Output: `Note created: <title>`.

### Today's agenda

1. Add **Run Shell Script**, no input needed:

   ```sh
   "$HOME/Applications/Aelys.app/Contents/MacOS/aelys-desktop" --action today
   ```

2. Add **Show Result** (or **Speak Text**) to read the output.

Output is one line per item in local time, for example:

```text
All day Holiday
09:30–10:20 Lecture
17:00 Task: Essay
```

If nothing is scheduled: `No events today.`

## Command reference

```text
aelys-desktop --action task <title> [--due <ISO-8601 with offset>] [--notes <text>]
aelys-desktop --action note <title> [<body> | -]
aelys-desktop --action today
```

- Title: 1 to 300 characters, single line, must not start with `--`.
- `-` as the note body reads the body from stdin (up to 500 KB).
- `scripts/aelys-action <command>` runs the same command through the app at
  `AELYS_APP_PATH` (default `~/Applications/Aelys.app`).

Exit codes: `0` success; `2` usage error; `3` Aelys not running or not signed in;
`4` actions not enabled (run the enable step above); `1` other error, printed
as a short error code. Output is plain UTF-8 on stdout; errors go to stderr.

## Security

Actions have the same trust as MCP: only typed owner operations (create task,
create note, read calendar occurrences and tasks) are allowed, and each write
gets a unique request ID. Anything else is refused by the broker. The key is
never printed.
