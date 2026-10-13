# Screenshot fixtures

`chat-panel.png` and `settings.png` are 1200 x 800 screenshots made from the
real extension source. `fixture.html` loads `extension/content.js`; the panel
is opened through its normal `togglePanel` message. The settings image opens
`extension/options.html` and runs `extension/options.js` directly.

The fixtures replace only Safari extension APIs with deterministic test doubles.
Their tab titles, page text, profile name, hub status, chat prompt, and reply
are clearly fictional sample data. They do not open Safari, access a user
profile, include a real token, or contain browsing history.

To regenerate the images, install Playwright's Chromium in a temporary
directory (so the extension remains dependency-free) and run:

```sh
fixture_dir=$(mktemp -d)
npm install --prefix "$fixture_dir" playwright
(cd "$fixture_dir" && npx playwright install chromium)
cp docs/images/capture.mjs "$fixture_dir/capture.mjs"
CFS_SCREENSHOT_ROOT="$PWD" node "$fixture_dir/capture.mjs"
```
