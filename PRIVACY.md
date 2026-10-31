# Reverse Vertical Tab Placement Privacy Policy

Effective date: October 30, 2026

Reverse Vertical Tab Placement uses information about your open Chrome tabs to arrange tabs, create groups, and copy selected tab links. This information is processed on your device. The extension does not send it to the developer or an external server.

## Information used

The extension reads tab titles, URLs, hostnames, tab and window identifiers, tab positions, selection and pinned states, opener relationships, and tab group information. It uses this information to place related tabs together, detect duplicate tabs, name groups, and format links that you choose to copy.

The extension receives events about newly opened tabs and their source tabs. It does not read the contents of web pages, forms, passwords, cookies, or your saved browsing history. It does not use advertising, analytics, or tracking services.

## Local storage and retention

The extension keeps temporary tab relationships and grouping information in memory while its background worker runs. It removes records as tabs close or as its related operations finish or expire.

The extension stores one timestamp in Chrome's local extension storage. This timestamp controls a brief guard that helps preserve restored tabs when Chrome starts. The extension removes the expired timestamp when it next checks the guard. It does not store a separate browsing history or a persistent list of tab titles and URLs.

Tab positions and group names created by the extension remain part of your Chrome session. Chrome manages their storage and any browser sync under your Chrome settings.

## Clipboard

When you select a copy command, the extension writes the selected tabs' URLs, and optionally their titles and group names, to your system clipboard. It does not read the existing clipboard. Clipboard content can remain after the extension stops. Your operating system and clipboard tools control its retention and any clipboard sync. You decide where to paste or share the copied information.

## Optional local AI

On supported devices, the extension can use Chrome's local Gemini Nano model to name tab groups. It provides tab titles and hostnames to Chrome's local Prompt API. It does not send these prompts to the Gemini web API or another external AI service.

If you select Prepare local model, Chrome may download the model. Chrome controls model downloads, storage, and availability. Tab placement and grouping work without the model.

## Sharing and sale

The extension does not transmit tab data to the developer or third parties. It does not sell user data or use it for advertising, credit decisions, or purposes unrelated to its tab management features. Copying selected links to the clipboard happens only when you request it.

## Your controls

You can disable or remove the extension at chrome://extensions to stop its processing. Removing it clears its local extension storage. Existing tabs, group names, and clipboard content can remain; you can change or remove those through Chrome and your operating system.

## Contact and changes

For questions, use the developer contact shown on the Chrome Web Store listing or the [project support page](https://github.com/gvteja/chrome-reverse-tab/issues). GitHub issues are public. Do not include private tab information in an issue.

Changes to this policy will be published here with an updated effective date. The [source code](https://github.com/gvteja/chrome-reverse-tab) is available for inspection.
