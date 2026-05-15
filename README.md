# Reverse Vertical Tab Placement

A small Chrome extension that changes tab placement behavior inspired by Arc and Dia:
- New tabs open at the top of the unpinned tab section.
- Links opened from pinned tabs also open at the top of the unpinned tab section.
- Links opened from unpinned tabs open immediately below the opener tab.
- Links opened from grouped tabs are added to the same tab group and placed immediately below the opener inside that group.
- Duplicated tabs open immediately below the tab being duplicated.
- If you open 2 or more links from the same ungrouped tab within 2 minutes, those tabs are treated as related and grouped automatically, similar to Dia's auto tab grouping behavior.
- If closing a tab leaves only one tab in a tab group, that remaining tab is automatically ungrouped and left open.

For automatic group creation:
- If the source tab is unpinned, the source tab and the related child tabs are grouped together.
- If the source tab is pinned, the pinned tab stays pinned and only the related child tabs are grouped.
- The group is named from the source tab title, with `Related links` used only when a source title is unavailable.
- No AI or page-content analysis is used. The grouping signal is only tab-open frequency from the same source tab.

Chrome does not expose a browser-extension API for detecting whether a window is currently using vertical tabs, so this ordering is applied in every tab-strip mode.

During Chrome startup/session restore, the extension preserves Chrome's restored tab order and restored tab groups instead of applying new-tab placement to those restored tabs.

Chrome also does not expose an API to scroll the tab strip after an existing tab is moved. The extension does a best-effort active-tab refocus after moving a tab, but native `Cmd+T` still has to be corrected after Chrome creates the tab.

For the smoothest new-tab behavior, use the extension command:
- Default: `Alt+Shift+T`
- macOS: `Option+Shift+T`

That command creates the tab at the top index directly instead of creating it elsewhere and moving it afterward. Chrome does not allow extensions to override the built-in `Cmd+T` shortcut, but you can change extension shortcuts at `chrome://extensions/shortcuts`.

## Install locally
1. Open `chrome://extensions`.
2. Enable **Developer mode**.
3. Click **Load unpacked**.
4. Select this folder.

No host permissions are requested, and the extension does not read page content. The `webNavigation` permission is used only to receive the source tab ID for tabs created by link navigation. The `tabs` permission is used only to read tab metadata for naming automatically created groups and detecting duplicated tabs. The `tabGroups` permission is used only to name and color automatically created groups. The `storage` permission is used only to remember one expiring timestamp for the brief startup/session-restore guard.
