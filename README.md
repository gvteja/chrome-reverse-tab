# Reverse Vertical Tab Placement

A small Chrome extension that changes tab placement behavior inspired by Arc and Dia.

Tab placement
- New tabs open at the top of the unpinned tab section. This includes externally opened URLs
- Links opened from pinned tabs start at the top of the unpinned tab section; subsequent links follow the existing child tabs in opening order.
- Links opened from unpinned tabs appear below the opener in opening order: opener, first link, second link, third link.
- Links opened from grouped tabs are added to the same tab group, after the opener's existing child tabs in that group.
- Duplicated tabs open immediately below the tab being duplicated.

Automatic tab group creation:
- If you open 2 or more links from the same ungrouped tab within 2 minutes, those tabs are treated as related and grouped automatically, similar to Dia's auto tab grouping behavior.
- If closing a tab leaves only one tab in a tab group, that remaining tab is automatically ungrouped and left open.
- The tab group name is automatically set based on the source tab and prefixed with a random emoji.
-- If the local Gemini Nano model is downloaded, it creates the tab group emoji and name.
- If the source tab is pinned, the pinned tab stays pinned and only the related child tabs are grouped.

During Chrome startup/session restore, the extension preserves Chrome's restored tab order and restored tab groups instead of applying new-tab placement to those restored tabs.

New tabs are moved in place with `chrome.tabs.move()`. The original tab, its page state, and any text already entered in the address bar are preserved. Externally opened URLs are not reopened or reloaded. Current Chrome scrolls moved active tabs into view; background tabs are moved without activating them. Older Chrome versions may move the tab without scrolling to it.

The previous recreation workaround is no longer needed: Chromium added scrolling for moved active tabs in [commit 6499f8b (June 12, 2026)](https://chromium.googlesource.com/chromium/src/+/6499f8b00a4fc469228d0b7cc21be7d02eeea9b4). This behavior was checked on Chrome 156.

For the smoothest new-tab behavior, use the extension command:
- Default: `Alt+Shift+T`
- macOS: `Option+Shift+T`

That command creates the tab at the top index directly in one step, with no reposition or reload. Chrome does not allow extensions to override the built-in `Cmd+T` shortcut, but you can change extension shortcuts at `chrome://extensions/shortcuts`.

The extension adds these actions to the toolbar popup, tab-strip/page right-click menu, and extension options page:
- **Move selected tabs to top** moves the currently highlighted tabs to the top of the unpinned section.
- **Copy selected tab links** copies the currently highlighted tabs in tab-strip order, one per line, in one of three formats:
  - **as title formatted md**: `- [Tab title](url)`, with each tab group's title as its own bullet and its tabs indented beneath it.
  - **as bullets**: `- url`, grouped and indented the same way.
  - **plain**: just the URL.

## Install locally
1. Open `chrome://extensions`.
2. Enable **Developer mode**.
3. Click **Load unpacked**.
4. Select this folder.
5. Open the extension's **Details** page and click **Extension options** to run selected-tab actions or check and prepare the local Gemini Nano model.

Permissions
- No host permissions are requested, and the extension does not read page content. 
- The `webNavigation` permission is used only to receive the source tab ID for tabs created by link navigation. 
- The `tabs` permission is used only to read tab metadata for naming automatically created groups and detecting duplicated tabs. 
- The `tabGroups` permission is used only to name and color automatically created groups, and to read group titles when copying selected tabs as Markdown. 
- The `storage` permission is used only to remember one expiring timestamp for the brief startup/session-restore guard. 
- The `clipboardWrite` and `offscreen` permissions are used only to copy selected tab links to the clipboard.
- Gemini Nano naming uses Chrome's local Prompt API; tab titles and hostnames are not sent to the Gemini web API. Chrome may download the local model once if it is supported but not already installed.

Source code is public. So you can read yourself/have your agent investigate. 
