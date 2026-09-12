# Safari MCP evaluation (`safaridriver --mcp`), 2026-09-02

Safari 27.0 (22625.1.29.11.26) on macOS 26; the server under test is Apple's
own `/usr/bin/safaridriver --mcp`. Exercised from Claude Code against a local
fixture page (forms, file input, dialogs, navigation, hover menus, shadow DOM,
an iframe, fetch, console) and against github.com, with a signed-in Safari
profile window open.

## What it is, structurally

- A WebDriver session. `list_tabs` shows ONLY tabs this server created; the
  user's open windows and tabs, in any profile, are invisible to it.
  `create_tab` opens an automation window that Safari titles with the
  DEFAULT profile's name ("Personal — ...") whatever profile is frontmost.
- The session is ISOLATED from the user's browsing: no cookies, no logins
  from either profile (github.com rendered signed out). It therefore cannot
  act "as you" in an existing session and cannot pick a profile. This is
  WebDriver's design, not a bug to fix.

## Tool by tool

| Tool | Verdict |
| --- | --- |
| `list_tabs`, `create_tab`, `switch_tab`, `close_tab` | Work. Tabs opened by `target=_blank` and `window.open` appear in the list; `active` can read false for every tab afterwards, so `switch_tab` explicitly. |
| `navigate_to_url`, `wait_for_navigation`, `page_info` | Work. A click that navigates returns the new page's content. |
| `get_page_content` | The strong half: `textTree` with UIDs for interactive nodes, including shadow-DOM children and same-origin iframe children (`6_1_393`-style ids), `markdown`/`plainText`, select options, listeners, `entire_page`. |
| `page_interactions` click | Works by UID, by page text, and by `point` coordinates. |
| `page_interactions` type | Works: append, `replaceAll`, `pressReturn` (fires the change). |
| `page_interactions` keyPress | Single keys only (`Escape`, `ArrowDown`). Chords (`cmd+k`, `shift+ArrowDown`) are NOT supported: the tool types the letters instead. |
| `page_interactions` hover | The hover fires, but text revealed only on hover (a CSS submenu) is not found by the next step's text search. |
| `page_interactions` selectMenuItem | Broken for a native `<select>`: it opens the popup and selects nothing (the select ended with value ""). |
| `page_interactions` scroll, selectText, highlightText, scrollToVisible | Work. |
| `evaluate_javascript` | Works, with `$uid()` and `frameId`. It is the workaround for selects, hidden menus, keyboard chords (dispatch a `KeyboardEvent`) and file upload. |
| File upload | No native file chooser: clicking "Choose Files" opens an NSOpenPanel nothing here can drive. VERIFIED workaround: build `File` objects in page JS, assign them through a `DataTransfer` to `input.files`, dispatch `change`, submit; the server received both test files. The bytes travel inside the script (base64), so a few MB is the practical ceiling. |
| `browser_dialogs` | Works (list/respond/dismiss, `inputText` for prompt), but a click that opens an alert BLOCKS `page_interactions` until the dialog is answered; run such a click alone, then respond. |
| Downloads | A download link saves to `~/Downloads` (the fixture file appeared) with no tool feedback; check the folder. |
| `list_network_requests`, `get_network_request` | Work, with headers, body and timing, but only for requests made after recording starts (the page-load requests were missing); call the list once before the action. |
| `browser_console_messages` | Works, with level filters, stack traces and clear. |
| `screenshot`, `set_viewport_size`, `set_emulated_media` | Work (verified through `innerWidth` and `matchMedia('print')`). |

## Shortcomings, and how each is solved on this fleet

1. **Existing session and profiles.** Structural (above). Three paths reach
   the REAL tabs:
   - The Claude for Safari extension + bridge in this repo (`claude_safari_*`:
     tabs, read, click, fill, navigate, eval, screenshot). It runs inside each
     profile's own extension instance, with that profile's cookies and logins,
     and the panel's Claude has these tools on the Mac hub and, since the
     Bearer-token fix, on a hosted hub as well, so on the phone too. Limits: a
     per-site website-access grant; tabs Safari has not loaded (fetched-copy
     fallback); one hub, so whichever profile's instance polls first answers a
     call. The next step is a profile tag in the panel's gear and a `profile`
     argument on the tools (roadmap in README.md).
   - AppleScript `do JavaScript` into a named window (a Safari window's name
     carries its profile) plus System Events for keystrokes and native panels:
     profile-exact and permission-free, but page-world only, and it needs
     Develop > Allow JavaScript from Apple Events. Safari's own AppleScript
     window list went stale during this session after every window had been
     closed (it reported 0 windows while System Events saw 4); a Safari
     restart clears that.
   - `safaridriver --mcp` itself for everything that does not need a login:
     clean-room browsing, testing a page as a stranger, scraping,
     screenshots, viewport and print emulation.
2. **Real files.** In a real tab the extension can take the DataTransfer
   route with bytes read by the Mac (a `claude_safari_upload` tool; roadmap),
   or System Events can drive the open panel after the file input is clicked
   (Cmd+Shift+G, the path, Return).
3. **Keyboard chords.** `evaluate_javascript` with a synthetic
   `KeyboardEvent` for page handlers; System Events `keystroke` for real
   browser shortcuts.
4. **Selects.** `evaluate_javascript`: set `.value`, dispatch `change`.
5. **Hover menus.** Hover, then click through JS or by `point`.
6. **Dialogs.** Sequence them: the triggering click alone, then
   `browser_dialogs`.
7. **Network capture.** Start the recording before the action.

Rule of thumb: `safaridriver --mcp` for clean-room work; the extension bridge
for "as me" work in the profile whose window is in front; AppleScript when a
page must not run the extension.
