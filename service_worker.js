const NO_GROUP = -1;
const SOURCE_TAB_WAIT_MS = 25;
const SOURCE_TAB_TTL_MS = 30000;
const TARGET_TAB_WAIT_ATTEMPTS = 8;
const GROUP_CLEANUP_WAIT_MS = 100;
const AUTO_GROUP_CHILD_THRESHOLD = 2;
const AUTO_GROUP_WINDOW_MS = 120000;
const AUTO_GROUP_TITLE = "Related links";
const AUTO_GROUP_COLOR = "blue";
const MAX_MOVE_ATTEMPTS = 12;
const RETRY_DELAY_MS = 75;
const CREATED_TAB_METADATA_SETTLE_MS = 100;
const STARTUP_RESTORE_GUARD_MS = 15000;
const STARTUP_RESTORE_GUARD_STORAGE_KEY = "startupRestoreGuardUntil";

const navigationSources = new Map();
const handledNavigationTabs = new Set();
const autoGroupCandidates = new Map();
const windowQueues = new Map();
let startupRestoreGuardUntil = 0;

chrome.runtime.onStartup.addListener(() => {
  setStartupRestoreGuard(Date.now() + STARTUP_RESTORE_GUARD_MS);
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
  const preserveAsStartupRestore = isStartupRestoreGuardActive(createdAt);

  enqueueForWindow(tab.windowId, async () => {
    if (await preserveAsStartupRestore) {
      return;
    }

    if (navigationSources.has(tab.id) || Number.isInteger(tab.openerTabId)) {
      await delay(SOURCE_TAB_WAIT_MS);
    } else {
      await delay(CREATED_TAB_METADATA_SETTLE_MS);
    }

    await placeCreatedTab(tab);
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

async function placeCreatedTab(createdTab) {
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

  if (shouldPreserveChromePlacedTab(tab)) {
    return;
  }

  await moveToTopOfUnpinnedTabs(tab.id, tab.windowId);
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
  return tab.status === "unloaded" || tab.discarded || tab.groupId !== NO_GROUP;
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

    await refocusTabIfActive(tabId);
  });
}

async function createNewTabAtTop(preferredWindowId) {
  const windowId = Number.isInteger(preferredWindowId)
    ? preferredWindowId
    : await getLastFocusedWindowId();

  if (!Number.isInteger(windowId)) {
    return;
  }

  const targetIndex = await getTopUnpinnedIndex(windowId);
  const tab = await chrome.tabs.create({
    active: true,
    index: targetIndex,
    windowId
  });

  if (Number.isInteger(tab.id)) {
    await refocusTabIfActive(tab.id);
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

    await refocusTabIfActive(tabId);
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
    await refocusTabIfActive(tabId);
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
      color: AUTO_GROUP_COLOR,
      title: AUTO_GROUP_TITLE
    });

    if (currentSourceTab.pinned) {
      await moveGroupToTopOfUnpinnedTabs(groupId, sourceTab.windowId);
    }

    return groupId;
  });
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

async function refocusTabIfActive(tabId) {
  const tab = await getTab(tabId);
  if (tab?.active) {
    await chrome.tabs.update(tabId, { active: true });
  }
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
