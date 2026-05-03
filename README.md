# Reverse Vertical Tab Placement

A small Chrome Manifest V3 extension that changes tab placement to fit a vertical-tab workflow:

- New tabs open at the top of the unpinned tab section.
- Links opened from pinned tabs also open at the top of the unpinned tab section.
- Links opened from unpinned tabs open immediately below the opener tab.
- Links opened from grouped tabs are added to the same tab group and placed immediately below the opener inside that group.

## Install locally

1. Open `chrome://extensions`.
2. Enable **Developer mode**.
3. Click **Load unpacked**.
4. Select this folder.

No host permissions are requested, and the extension does not read page content. The `webNavigation` permission is used only to receive the source tab ID for tabs created by link navigation.
