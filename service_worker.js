const NO_GROUP = -1;
const SOURCE_TAB_WAIT_MS = 25;
const SOURCE_TAB_TTL_MS = 30000;
const TARGET_TAB_WAIT_ATTEMPTS = 8;
const GROUP_CLEANUP_WAIT_MS = 100;
const AUTO_GROUP_CHILD_THRESHOLD = 2;
const AUTO_GROUP_WINDOW_MS = 120000;
const AUTO_GROUP_FALLBACK_TITLE = "Related links";
const AUTO_GROUP_MAX_TITLE_LENGTH = 64;
const AUTO_GROUP_EMOJIS = [
  "🔎",
  "📌",
  "🧭",
  "🗂️",
  "💡",
  "📝",
  "⚙️",
  "📊",
  "🧪",
  "🚀",
  "🎯",
  "📚",
  "🛠️",
  "🧩",
  "🌐",
  "💬"
];
const AUTO_GROUP_COLORS = [
  "grey",
  "blue",
  "red",
  "yellow",
  "green",
  "pink",
  "purple",
  "cyan",
  "orange"
];
const NANO_PROMPT_TIMEOUT_MS = 6000;
const NANO_LANGUAGE_MODEL_OPTIONS = {
  expectedInputs: [{ type: "text", languages: ["en"] }],
  expectedOutputs: [{ type: "text", languages: ["en"] }]
};
const MAX_MOVE_ATTEMPTS = 12;
const RETRY_DELAY_MS = 75;
const CREATED_TAB_METADATA_SETTLE_MS = 100;
const ACTIVE_TAB_SETTLE_ATTEMPTS = 4;
const ACTIVE_TAB_SETTLE_MS = 40;
const STARTUP_RESTORE_GUARD_MS = 15000;
const STARTUP_RESTORE_GUARD_STORAGE_KEY = "startupRestoreGuardUntil";
const MOVE_TAB_TO_TOP_MENU_ID = "move-tab-to-top";

const navigationSources = new Map();
const handledNavigationTabs = new Set();
const extensionPlacedTabs = new Set();
const autoGroupCandidates = new Map();
const windowQueues = new Map();
let startupRestoreGuardUntil = 0;
let nanoSessionPromise;

chrome.runtime.onStartup.addListener(() => {
  setStartupRestoreGuard(Date.now() + STARTUP_RESTORE_GUARD_MS);
});

chrome.runtime.onInstalled.addListener(setupMoveTabToTopMenu);

// onInstalled alone can miss cases (e.g. the service worker restarting without a
// reinstall), so also ensure the menu exists every time the worker starts.
// Recreating is cheap and removeAll keeps it idempotent.
setupMoveTabToTopMenu();

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== MOVE_TAB_TO_TOP_MENU_ID) {
    return;
  }

  if (!tab || !Number.isInteger(tab.id) || !Number.isInteger(tab.windowId)) {
    return;
  }

  enqueueForWindow(tab.windowId, () => moveSelectedTabsToTop(tab.windowId));
});

chrome.webNavigation.onCreatedNavigationTarget.addListener((details) => {
  if (!Number.isInteger(details.tabId) || !Number.isInteger(details.sourceTabId)) {
    return;
  }

  navigationSources.set(details.tabId, details.sourceTabId);
  maybePlaceNavigationCreatedTab(details.tabId, details.sourceTabId);

  setTimeout(() => {
    navigationSources.delete(details.tabId);
  }, SOURCE_TAB_TTL_MS);
});

chrome.tabs.onCreated.addListener((tab) => {
  if (!Number.isInteger(tab.id) || !Number.isInteger(tab.windowId)) {
    return;
  }

  const createdAt = Date.now();
  const startupRestoreGuardActive = isStartupRestoreGuardActive(createdAt);

  enqueueForWindow(tab.windowId, async () => {
    const preserveAsStartupRestore = await startupRestoreGuardActive;

    if (navigationSources.has(tab.id)) {
      await delay(SOURCE_TAB_WAIT_MS);
    } else {
      await delay(CREATED_TAB_METADATA_SETTLE_MS);
    }

    await placeCreatedTab(tab, { preserveAsStartupRestore });
  });
});

chrome.commands.onCommand.addListener((command, tab) => {
  if (command !== "new-tab-at-top") {
    return;
  }

  const windowId = Number.isInteger(tab?.windowId) ? tab.windowId : undefined;
  if (Number.isInteger(windowId)) {
    enqueueForWindow(windowId, () => createNewTabAtTop(windowId));
    return;
  }

  createNewTabAtTop().catch((error) => {
    console.warn("Unable to create new tab at top:", error);
  });
});

chrome.tabs.onRemoved.addListener((tabId, removeInfo) => {
  navigationSources.delete(tabId);
  handledNavigationTabs.delete(tabId);
  extensionPlacedTabs.delete(tabId);
  autoGroupCandidates.delete(tabId);

  for (const candidate of autoGroupCandidates.values()) {
    candidate.childTabs.delete(tabId);
  }

  if (!removeInfo.isWindowClosing && Number.isInteger(removeInfo.windowId)) {
    enqueueForWindow(removeInfo.windowId, async () => {
      await delay(GROUP_CLEANUP_WAIT_MS);
      await ungroupSingletonTabGroups(removeInfo.windowId);
    });
  }
});

chrome.tabGroups.onRemoved.addListener((group) => {
  for (const [sourceTabId, candidate] of autoGroupCandidates) {
    if (candidate.groupId === group.id) {
      autoGroupCandidates.delete(sourceTabId);
    }
  }
});

function enqueueForWindow(windowId, task) {
  const previousTask = windowQueues.get(windowId) || Promise.resolve();

  const nextTask = previousTask
    .catch(() => {})
    .then(task)
    .catch((error) => {
      console.warn("Unable to place created tab:", error);
    })
    .finally(() => {
      if (windowQueues.get(windowId) === nextTask) {
        windowQueues.delete(windowId);
      }
    });

  windowQueues.set(windowId, nextTask);
}

async function placeCreatedTab(createdTab, options = {}) {
  if (extensionPlacedTabs.delete(createdTab.id)) {
    return;
  }

  const tab = await getTab(createdTab.id);
  if (!tab || tab.pinned) {
    return;
  }

  if (handledNavigationTabs.has(tab.id)) {
    return;
  }

  const sourceTabId = navigationSources.get(tab.id);
  if (Number.isInteger(sourceTabId)) {
    navigationSources.delete(tab.id);
    markNavigationTabHandled(tab.id);
    await placeLinkCreatedTab(tab.id, sourceTabId);
    return;
  }

  if (
    options.preserveAsStartupRestore &&
    await shouldPreserveStartupRestoreTab(tab, createdTab)
  ) {
    return;
  }

  const duplicateSourceTabId = await getDuplicateSourceTabId(tab);
  if (Number.isInteger(duplicateSourceTabId)) {
    await placeLinkCreatedTab(tab.id, duplicateSourceTabId);
    return;
  }

  if (shouldPreserveChromePlacedTab(tab)) {
    return;
  }

  await placeNewTabAtTop(tab.id, tab.windowId);
}

async function maybePlaceNavigationCreatedTab(tabId, sourceTabId) {
  await delay(SOURCE_TAB_WAIT_MS);

  const tab = await waitForTab(tabId);
  if (!tab) {
    navigationSources.delete(tabId);
    return;
  }

  enqueueForWindow(tab.windowId, async () => {
    if (handledNavigationTabs.has(tabId) || navigationSources.get(tabId) !== sourceTabId) {
      return;
    }

    navigationSources.delete(tabId);
    markNavigationTabHandled(tabId);
    await placeLinkCreatedTab(tabId, sourceTabId);
  });
}

function shouldPreserveChromePlacedTab(tab) {
  return !tab.active && (tab.status === "unloaded" || tab.discarded);
}

async function shouldPreserveStartupRestoreTab(tab, createdTab) {
  // External URLs that launch Chrome can arrive during the restore guard as active,
  // loading tabs appended at the end of the window. They still need normal placement.
  if (await isActiveChromeAppendedLoadingTab(tab, createdTab)) {
    return false;
  }

  return true;
}

async function isActiveChromeAppendedLoadingTab(tab, createdTab) {
  if (
    !tab.active ||
    tab.discarded ||
    !wasTabLoadingWhenCreatedOrChecked(tab, createdTab)
  ) {
    return false;
  }

  const tabs = await chrome.tabs.query({ windowId: tab.windowId });
  const unpinnedTabs = tabs
    .filter((candidate) => !candidate.pinned)
    .sort((a, b) => a.index - b.index);
  const lastUnpinnedTab = unpinnedTabs[unpinnedTabs.length - 1];

  return lastUnpinnedTab?.id === tab.id;
}

function wasTabLoadingWhenCreatedOrChecked(tab, createdTab) {
  return isLoadingTab(tab) || isLoadingTab(createdTab);
}

function isLoadingTab(tab) {
  return tab.status === "loading" || Boolean(tab.pendingUrl);
}

async function getDuplicateSourceTabId(tab) {
  if (!Number.isInteger(tab.openerTabId)) {
    return undefined;
  }

  const opener = await getTab(tab.openerTabId);
  if (!opener || opener.windowId !== tab.windowId) {
    return undefined;
  }

  if (isDuplicateOfOpener(tab, opener) || isChromePlacedDuplicateOfOpener(tab, opener)) {
    return opener.id;
  }

  return undefined;
}

function isDuplicateOfOpener(tab, opener) {
  const tabUrl = getComparableTabUrl(tab);
  const openerUrl = getComparableTabUrl(opener);

  return Boolean(
    tabUrl &&
    openerUrl &&
    tabUrl === openerUrl &&
    !isBlankNewTabUrl(tabUrl)
  );
}

function isChromePlacedDuplicateOfOpener(tab, opener) {
  // Normal page URLs are unavailable without the "tabs" permission, but Chrome
  // initially creates duplicated tabs immediately after their opener.
  return tab.index === opener.index + 1;
}

function getComparableTabUrl(tab) {
  return tab.pendingUrl || tab.url || "";
}

function isBlankNewTabUrl(url) {
  return url === "chrome://newtab/" || url === "chrome://new-tab-page/" || url === "about:blank";
}

function setStartupRestoreGuard(guardUntil) {
  startupRestoreGuardUntil = guardUntil;

  chrome.storage.local.set({ [STARTUP_RESTORE_GUARD_STORAGE_KEY]: guardUntil }).catch((error) => {
    console.warn("Unable to persist startup restore guard:", error);
  });
}

async function isStartupRestoreGuardActive(referenceTime = Date.now()) {
  if (referenceTime < startupRestoreGuardUntil) {
    return true;
  }

  try {
    const stored = await chrome.storage.local.get(STARTUP_RESTORE_GUARD_STORAGE_KEY);
    startupRestoreGuardUntil = Number(stored[STARTUP_RESTORE_GUARD_STORAGE_KEY]) || 0;

    if (referenceTime < startupRestoreGuardUntil) {
      return true;
    }

    chrome.storage.local.remove(STARTUP_RESTORE_GUARD_STORAGE_KEY).catch(() => {});
    return false;
  } catch {
    return false;
  }
}

async function placeLinkCreatedTab(tabId, sourceTabId) {
  const tab = await getTab(tabId);
  if (!tab || tab.pinned) {
    return;
  }

  const opener = await getTab(sourceTabId);

  if (!opener || opener.windowId !== tab.windowId || opener.pinned) {
    await moveToTopOfUnpinnedTabs(tab.id, tab.windowId);

    if (opener?.pinned) {
      await maybeAddPinnedSourceTabToAutoGroup(opener.id, tab.id, tab.windowId);
      await maybeCreateAutoGroup(opener, tab.id);
    }

    return;
  }

  await moveNextToOpener(tab.id, opener.id);

  if (opener.groupId === NO_GROUP) {
    await maybeCreateAutoGroup(opener, tab.id);
  }
}

async function waitForTab(tabId) {
  for (let attempt = 0; attempt < TARGET_TAB_WAIT_ATTEMPTS; attempt += 1) {
    const tab = await getTab(tabId);
    if (tab) {
      return tab;
    }

    await delay(SOURCE_TAB_WAIT_MS);
  }

  return undefined;
}

// Tabs the extension creates itself fire onCreated like user-opened tabs, but
// they are already at their intended index. Re-placing them is normally a
// no-op, but when another tab is opened during placement the re-run would
// recreate the replacement at the top again and leapfrog the newer tab.
function markExtensionPlacedTab(tabId) {
  extensionPlacedTabs.add(tabId);

  setTimeout(() => {
    extensionPlacedTabs.delete(tabId);
  }, SOURCE_TAB_TTL_MS);
}

function markNavigationTabHandled(tabId) {
  handledNavigationTabs.add(tabId);

  setTimeout(() => {
    handledNavigationTabs.delete(tabId);
  }, SOURCE_TAB_TTL_MS);
}

async function moveToTopOfUnpinnedTabs(tabId, windowId) {
  await moveWithRetry(async () => {
    const tab = await getTab(tabId);
    if (!tab || tab.pinned) {
      return;
    }

    const targetIndex = await getTopUnpinnedIndex(windowId);

    if (tab.index !== targetIndex) {
      await chrome.tabs.move(tabId, { index: targetIndex });
    }
  });
}

function setupMoveTabToTopMenu() {
  // removeAll first so re-running this (on restart/update) can't fail with a
  // duplicate-id error for an entry that already exists.
  chrome.contextMenus.removeAll(() => {
    void chrome.runtime.lastError;

    chrome.contextMenus.create(
      {
        id: MOVE_TAB_TO_TOP_MENU_ID,
        title: "Move selected tabs to top",
        // "tab" attaches to the native tab strip, but some (e.g. managed) Chrome
        // setups never render tab-strip items. "page" reliably shows on the page
        // body and the click handler resolves the same tab either way.
        contexts: ["page", "tab"]
      },
      () => {
        if (chrome.runtime.lastError) {
          console.warn(
            "Unable to create the move-tab-to-top context menu:",
            chrome.runtime.lastError.message
          );
        }
      }
    );
  });
}

// Moves the user's currently selected (highlighted) tabs to the top of the
// unpinned section, keeping their relative order. The highlighted set is
// whatever was multi-selected in the tab strip (Cmd/Shift-click), or just the
// active tab when nothing else is selected. Existing tabs hold live page state,
// so they are moved in place rather than recreated (recreating would reload
// them and lose that state); a plain move does not scroll the tab strip, which
// is fine for a user-initiated action.
async function moveSelectedTabsToTop(windowId) {
  const highlightedTabs = await chrome.tabs.query({ windowId, highlighted: true });
  const movableTabs = highlightedTabs
    .filter((tab) => !tab.pinned)
    .sort((a, b) => a.index - b.index);

  if (movableTabs.length === 0) {
    return;
  }

  const tabIds = movableTabs.map((tab) => tab.id);

  await moveWithRetry(async () => {
    for (const tabId of tabIds) {
      await ungroupTabIfGrouped(tabId);
    }

    const targetIndex = await getTopUnpinnedIndex(windowId);
    await chrome.tabs.move(tabIds, { index: targetIndex });
  });
}

async function placeNewTabAtTop(tabId, windowId) {
  const tab = await getTab(tabId);
  if (!tab || tab.pinned || shouldPreserveChromePlacedTab(tab)) {
    return;
  }

  // Moving an already-active tab to the top does not make Chrome scroll the tab
  // strip, so the strip stays parked at the bottom even though the new active
  // tab is now at the top. Recreating the tab directly at the top index instead
  // makes Chrome scroll to it the same way it scrolls to any freshly created
  // tab. Only the active tab needs this; background tabs don't need a scroll and
  // recreating them would steal focus.
  if (await maybeRecreateActiveTabAtTop(tab, windowId)) {
    return;
  }

  await moveWithRetry(async () => {
    const currentTab = await getTab(tabId);
    if (!currentTab || currentTab.pinned || shouldPreserveChromePlacedTab(currentTab)) {
      return;
    }

    await ungroupTabIfGrouped(currentTab.id);
    await moveToTopOfUnpinnedTabs(currentTab.id, windowId);
  });
}

// External app launches (e.g. opening a link from Slack) create the tab a beat
// before Chrome marks it active and brings it to the foreground. The metadata
// settle delay can run during that gap, leaving tab.active false even though
// Chrome is about to focus the tab. Only the recreate-at-top path scrolls the
// tab strip, and it is gated on the tab being active, so without this the tab
// lands at the top via a plain move and the strip never scrolls to it. Poll
// briefly for the active state to settle so these tabs still scroll. Genuine
// background tabs stay inactive through the poll and keep their no-scroll move;
// recreating them would steal focus.
async function waitForActiveTabToSettle(tab, windowId) {
  if (tab.active) {
    return tab;
  }

  if (!isLoadingTab(tab)) {
    return undefined;
  }

  for (let attempt = 0; attempt < ACTIVE_TAB_SETTLE_ATTEMPTS; attempt += 1) {
    await delay(ACTIVE_TAB_SETTLE_MS);

    const refreshedTab = await getTab(tab.id);
    if (!refreshedTab || refreshedTab.windowId !== windowId) {
      return undefined;
    }

    if (refreshedTab.active) {
      return refreshedTab;
    }

    if (!isLoadingTab(refreshedTab)) {
      return undefined;
    }
  }

  return undefined;
}

async function maybeRecreateActiveTabAtTop(tab, windowId) {
  const activeTab = await waitForActiveTabToSettle(tab, windowId);
  if (!activeTab) {
    return false;
  }

  tab = activeTab;

  const targetIndex = await getTopUnpinnedIndex(windowId);
  if (tab.index === targetIndex) {
    return false;
  }

  const url = getRecreatableTabUrl(tab);
  if (url === undefined) {
    return false;
  }

  // Create the replacement before removing the original so the active tab never
  // briefly flips to a neighbor (which would flash that tab's content).
  let createdTab;
  try {
    createdTab = await moveWithRetry(() =>
      chrome.tabs.create(buildTopTabCreateProperties(url, targetIndex, windowId))
    );
  } catch (error) {
    console.warn("Unable to recreate new tab at top:", error);
    return false;
  }

  if (!Number.isInteger(createdTab?.id)) {
    return false;
  }

  markExtensionPlacedTab(createdTab.id);

  try {
    await moveWithRetry(() => chrome.tabs.remove(tab.id));
  } catch (error) {
    console.warn("Unable to remove original tab after recreating at top:", error);
  }

  return true;
}

function getRecreatableTabUrl(tab) {
  const url = getComparableTabUrl(tab);

  // A blank new tab is recreated as the user's default new tab page (no url).
  if (!url || isBlankNewTabUrl(url)) {
    return "";
  }

  // Only http(s) URLs can be safely reopened by the extension. Privileged URLs
  // (chrome://, file://, etc.) can't, so signal the caller to fall back to a
  // move instead of removing a tab we couldn't recreate.
  if (/^https?:\/\//i.test(url)) {
    return url;
  }

  return undefined;
}

function buildTopTabCreateProperties(url, index, windowId) {
  const properties = { active: true, index, windowId };
  if (url) {
    properties.url = url;
  }

  return properties;
}

async function ungroupTabIfGrouped(tabId) {
  const tab = await getTab(tabId);
  if (tab && tab.groupId !== NO_GROUP) {
    await chrome.tabs.ungroup(tabId);
  }
}

async function createNewTabAtTop(preferredWindowId) {
  const windowId = Number.isInteger(preferredWindowId)
    ? preferredWindowId
    : await getLastFocusedWindowId();

  if (!Number.isInteger(windowId)) {
    return;
  }

  const targetIndex = await getTopUnpinnedIndex(windowId);
  const createdTab = await chrome.tabs.create(buildTopTabCreateProperties("", targetIndex, windowId));

  if (Number.isInteger(createdTab?.id)) {
    markExtensionPlacedTab(createdTab.id);
  }
}

async function moveNextToOpener(tabId, openerTabId) {
  await moveWithRetry(async () => {
    const opener = await getTab(openerTabId);
    const tab = await getTab(tabId);

    if (!opener || !tab || opener.windowId !== tab.windowId || tab.pinned) {
      return;
    }

    if (opener.groupId !== NO_GROUP && tab.groupId !== opener.groupId) {
      await chrome.tabs.group({ tabIds: tabId, groupId: opener.groupId });
    }

    const refreshedOpener = await getTab(openerTabId);
    const refreshedTab = await getTab(tabId);

    if (
      !refreshedOpener ||
      !refreshedTab ||
      refreshedOpener.windowId !== refreshedTab.windowId ||
      refreshedTab.pinned
    ) {
      return;
    }

    const targetIndex = indexImmediatelyAfter(refreshedTab.index, refreshedOpener.index);

    if (refreshedTab.index !== targetIndex) {
      await chrome.tabs.move(tabId, { index: targetIndex });
    }
  });
}

async function maybeAddPinnedSourceTabToAutoGroup(sourceTabId, tabId, windowId) {
  const groupId = await getExistingAutoGroupId(sourceTabId);
  if (!Number.isInteger(groupId)) {
    return;
  }

  await moveWithRetry(async () => {
    const tab = await getTab(tabId);
    if (!tab || tab.windowId !== windowId || tab.pinned) {
      return;
    }

    if (tab.groupId !== groupId) {
      await chrome.tabs.group({ tabIds: tabId, groupId });
    }

    await moveTabToTopOfGroup(tabId, groupId, windowId);
    await moveGroupToTopOfUnpinnedTabs(groupId, windowId);
  });
}

async function maybeCreateAutoGroup(sourceTab, childTabId) {
  const candidate = getAutoGroupCandidate(sourceTab);
  candidate.childTabs.set(childTabId, Date.now());

  if (Number.isInteger(await getExistingAutoGroupId(sourceTab.id))) {
    return;
  }

  const childTabIds = await getOpenRecentChildTabIds(candidate);
  if (childTabIds.length < AUTO_GROUP_CHILD_THRESHOLD) {
    return;
  }

  const groupId = await createAutoGroup(sourceTab);
  if (Number.isInteger(groupId) && sourceTab.pinned) {
    candidate.groupId = groupId;
  } else {
    autoGroupCandidates.delete(sourceTab.id);
  }
}

function getAutoGroupCandidate(sourceTab) {
  const existingCandidate = autoGroupCandidates.get(sourceTab.id);
  if (existingCandidate) {
    return existingCandidate;
  }

  const candidate = {
    sourceTabId: sourceTab.id,
    windowId: sourceTab.windowId,
    sourcePinned: sourceTab.pinned,
    childTabs: new Map(),
    groupId: undefined
  };

  autoGroupCandidates.set(sourceTab.id, candidate);
  return candidate;
}

async function getOpenRecentChildTabIds(candidate) {
  const cutoff = Date.now() - AUTO_GROUP_WINDOW_MS;
  const childTabIds = [];

  for (const [tabId, createdAt] of candidate.childTabs) {
    if (createdAt < cutoff) {
      candidate.childTabs.delete(tabId);
      continue;
    }

    const tab = await getTab(tabId);
    if (!tab || tab.windowId !== candidate.windowId || tab.pinned) {
      candidate.childTabs.delete(tabId);
      continue;
    }

    childTabIds.push(tabId);
  }

  return childTabIds;
}

async function createAutoGroup(sourceTab) {
  return moveWithRetry(async () => {
    const currentSourceTab = await getTab(sourceTab.id);
    const openChildTabIds = await getOpenRecentChildTabIds(getAutoGroupCandidate(sourceTab));

    if (!currentSourceTab || currentSourceTab.windowId !== sourceTab.windowId) {
      return undefined;
    }

    if (openChildTabIds.length < AUTO_GROUP_CHILD_THRESHOLD) {
      return undefined;
    }

    if (!currentSourceTab.pinned && currentSourceTab.groupId !== NO_GROUP) {
      await chrome.tabs.group({
        tabIds: openChildTabIds,
        groupId: currentSourceTab.groupId
      });

      return currentSourceTab.groupId;
    }

    const tabIds = currentSourceTab.pinned
      ? openChildTabIds
      : [currentSourceTab.id, ...openChildTabIds];

    const groupId = await chrome.tabs.group({ tabIds });
    await chrome.tabGroups.update(groupId, {
      color: getRandomAutoGroupColor(),
      title: getFallbackAutoGroupTitle(currentSourceTab)
    });

    if (currentSourceTab.pinned) {
      await moveGroupToTopOfUnpinnedTabs(groupId, sourceTab.windowId);
    }

    await maybeRenameAutoGroupWithNano(groupId, currentSourceTab, openChildTabIds);

    return groupId;
  });
}

function getRandomAutoGroupColor() {
  return AUTO_GROUP_COLORS[Math.floor(Math.random() * AUTO_GROUP_COLORS.length)];
}

async function maybeRenameAutoGroupWithNano(groupId, sourceTab, childTabIds) {
  const nanoTitle = await generateNanoAutoGroupTitle(sourceTab, childTabIds);
  if (!nanoTitle) {
    return;
  }

  try {
    await chrome.tabGroups.update(groupId, { title: nanoTitle });
  } catch (error) {
    console.warn("Unable to update Gemini Nano tab group title:", error);
  }
}

async function generateNanoAutoGroupTitle(sourceTab, childTabIds) {
  const childTabs = await getTabs(childTabIds);
  const prompt = buildNanoGroupNamePrompt(sourceTab, childTabs);
  const response = await promptNanoLanguageModel(prompt);

  return sanitizeAutoGroupTitle(response);
}

function buildNanoGroupNamePrompt(sourceTab, childTabs) {
  const tabSummaries = [
    `Source tab: ${formatTabForPrompt(sourceTab)}`,
    ...childTabs.map((tab, index) => `Opened tab ${index + 1}: ${formatTabForPrompt(tab)}`)
  ];

  return [
    "Name this Chrome tab group by extracting the shared topic behind these tabs.",
    "Return only the group name, no quotes, no punctuation-only labels.",
    "Start with one relevant emoji, then a space, then the group name.",
    "Keep the words after the emoji short: 2 to 5 words.",
    "",
    ...tabSummaries
  ].join("\n");
}

function formatTabForPrompt(tab) {
  const title = normalizeTabTitle(tab?.title) || "Untitled";
  const host = getTabUrlHost(tab);
  return host ? `${title} (${host})` : title;
}

async function promptNanoLanguageModel(prompt) {
  const session = await getNanoLanguageModelSession();
  if (!session) {
    return "";
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => {
    controller.abort();
  }, NANO_PROMPT_TIMEOUT_MS);

  try {
    return await session.prompt(prompt, { signal: controller.signal });
  } catch (error) {
    if (error.name !== "AbortError") {
      console.warn("Unable to generate Gemini Nano tab group title:", error);
      resetNanoLanguageModelSession();
    }

    return "";
  } finally {
    clearTimeout(timeoutId);
  }
}

async function getNanoLanguageModelSession() {
  const languageModel = getNanoLanguageModelApi();
  if (!languageModel) {
    return undefined;
  }

  try {
    const availability = await languageModel.availability(NANO_LANGUAGE_MODEL_OPTIONS);
    if (availability !== "available") {
      return undefined;
    }

    if (!nanoSessionPromise) {
      nanoSessionPromise = languageModel.create(NANO_LANGUAGE_MODEL_OPTIONS);
    }

    return await nanoSessionPromise;
  } catch (error) {
    console.warn("Unable to create Gemini Nano language model session:", error);
    resetNanoLanguageModelSession();
    return undefined;
  }
}

function getNanoLanguageModelApi() {
  const languageModel = globalThis.LanguageModel;
  return languageModel && typeof languageModel.availability === "function"
    ? languageModel
    : undefined;
}

function resetNanoLanguageModelSession() {
  if (!nanoSessionPromise) {
    return;
  }

  nanoSessionPromise
    .then((session) => {
      session.destroy();
    })
    .catch(() => {});

  nanoSessionPromise = undefined;
}

function sanitizeAutoGroupTitle(title) {
  const normalizedTitle = normalizeTabTitle(title)
    .replace(/^(tab group name|group name|name|emoji):\s*/i, "")
    .replace(/^["'`]+|["'`]+$/g, "")
    .replace(/[.]+$/g, "")
    .trim();

  return normalizedTitle ? formatAutoGroupTitleWithEmojiIfMissing(normalizedTitle) : "";
}

function getFallbackAutoGroupTitle(sourceTab) {
  const sourceTitle = normalizeTabTitle(sourceTab?.title);
  if (sourceTitle) {
    return formatAutoGroupTitleWithEmoji(sourceTitle);
  }

  const sourceHost = getTabUrlHost(sourceTab);
  if (sourceHost) {
    return formatAutoGroupTitleWithEmoji(sourceHost);
  }

  return formatAutoGroupTitleWithEmoji(AUTO_GROUP_FALLBACK_TITLE);
}

function formatAutoGroupTitleWithEmoji(title) {
  return truncateAutoGroupTitle(`${getRandomAutoGroupEmoji()} ${title}`);
}

function formatAutoGroupTitleWithEmojiIfMissing(title) {
  if (startsWithEmoji(title)) {
    return truncateAutoGroupTitle(title);
  }

  return formatAutoGroupTitleWithEmoji(title);
}

function startsWithEmoji(title) {
  return /^\p{Extended_Pictographic}/u.test(title);
}

function getRandomAutoGroupEmoji() {
  return AUTO_GROUP_EMOJIS[Math.floor(Math.random() * AUTO_GROUP_EMOJIS.length)];
}

async function getTabs(tabIds) {
  const tabs = [];

  for (const tabId of tabIds) {
    const tab = await getTab(tabId);
    if (tab) {
      tabs.push(tab);
    }
  }

  return tabs;
}

function normalizeTabTitle(title) {
  return typeof title === "string" ? title.replace(/\s+/g, " ").trim() : "";
}

function getTabUrlHost(tab) {
  const tabUrl = getComparableTabUrl(tab);
  if (!tabUrl || isBlankNewTabUrl(tabUrl)) {
    return "";
  }

  try {
    const parsedUrl = new URL(tabUrl);
    return parsedUrl.hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

function truncateAutoGroupTitle(title) {
  if (title.length <= AUTO_GROUP_MAX_TITLE_LENGTH) {
    return title;
  }

  return `${title.slice(0, AUTO_GROUP_MAX_TITLE_LENGTH - 3).trimEnd()}...`;
}

async function moveTabToTopOfGroup(tabId, groupId, windowId) {
  const tabs = await chrome.tabs.query({ groupId, windowId });
  tabs.sort((a, b) => a.index - b.index);

  const tab = tabs.find((candidate) => candidate.id === tabId);
  const firstGroupTab = tabs[0];

  if (tab && firstGroupTab && tab.index !== firstGroupTab.index) {
    await chrome.tabs.move(tabId, { index: firstGroupTab.index });
  }
}

async function moveGroupToTopOfUnpinnedTabs(groupId, windowId) {
  const tabs = await chrome.tabs.query({ windowId });
  tabs.sort((a, b) => a.index - b.index);

  const firstUnpinned = tabs.find((tab) => !tab.pinned);
  if (firstUnpinned) {
    await chrome.tabGroups.move(groupId, { index: firstUnpinned.index });
  }
}

async function getTopUnpinnedIndex(windowId) {
  const tabs = await chrome.tabs.query({ windowId });
  tabs.sort((a, b) => a.index - b.index);

  const firstUnpinned = tabs.find((tab) => !tab.pinned);
  return firstUnpinned ? firstUnpinned.index : tabs.length;
}

async function getLastFocusedWindowId() {
  try {
    const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (Number.isInteger(tabs[0]?.windowId)) {
      return tabs[0].windowId;
    }
  } catch {
    return undefined;
  }

  return undefined;
}

async function ungroupSingletonTabGroups(windowId) {
  await moveWithRetry(async () => {
    const tabs = await chrome.tabs.query({ windowId });
    const tabsByGroupId = new Map();

    for (const tab of tabs) {
      if (tab.groupId === NO_GROUP) {
        continue;
      }

      const groupedTabs = tabsByGroupId.get(tab.groupId) || [];
      groupedTabs.push(tab);
      tabsByGroupId.set(tab.groupId, groupedTabs);
    }

    for (const groupedTabs of tabsByGroupId.values()) {
      if (groupedTabs.length === 1 && Number.isInteger(groupedTabs[0].id)) {
        await chrome.tabs.ungroup(groupedTabs[0].id);
      }
    }
  });
}

async function getExistingAutoGroupId(sourceTabId) {
  const candidate = autoGroupCandidates.get(sourceTabId);
  if (!Number.isInteger(candidate?.groupId)) {
    return undefined;
  }

  try {
    await chrome.tabGroups.get(candidate.groupId);
    return candidate.groupId;
  } catch {
    candidate.groupId = undefined;
    return undefined;
  }
}

function indexImmediatelyAfter(sourceIndex, openerIndex) {
  return sourceIndex < openerIndex ? openerIndex : openerIndex + 1;
}

async function moveWithRetry(operation, attempt = 1) {
  try {
    return await operation();
  } catch (error) {
    if (attempt < MAX_MOVE_ATTEMPTS && isTransientTabEditError(error)) {
      await delay(RETRY_DELAY_MS);
      return await moveWithRetry(operation, attempt + 1);
    }

    throw error;
  }
}

function isTransientTabEditError(error) {
  return String(error).includes("Tabs cannot be edited right now");
}

async function getTab(tabId) {
  try {
    return await chrome.tabs.get(tabId);
  } catch {
    return undefined;
  }
}

function delay(milliseconds) {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}
