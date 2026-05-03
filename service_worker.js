const NO_GROUP = -1;
const SOURCE_TAB_WAIT_MS = 100;
const SOURCE_TAB_TTL_MS = 30000;
const MAX_MOVE_ATTEMPTS = 12;
const RETRY_DELAY_MS = 75;

const navigationSources = new Map();
const windowQueues = new Map();

chrome.webNavigation.onCreatedNavigationTarget.addListener((details) => {
  if (!Number.isInteger(details.tabId) || !Number.isInteger(details.sourceTabId)) {
    return;
  }

  navigationSources.set(details.tabId, details.sourceTabId);

  setTimeout(() => {
    navigationSources.delete(details.tabId);
  }, SOURCE_TAB_TTL_MS);
});

chrome.tabs.onCreated.addListener((tab) => {
  if (!Number.isInteger(tab.id) || !Number.isInteger(tab.windowId)) {
    return;
  }

  enqueueForWindow(tab.windowId, async () => {
    await delay(SOURCE_TAB_WAIT_MS);
    await placeCreatedTab(tab);
  });
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

  const opener = await getNavigationSource(tab.id, tab.windowId);

  if (!opener || opener.pinned) {
    await moveToTopOfUnpinnedTabs(tab.id, tab.windowId);
    return;
  }

  await moveNextToOpener(tab.id, opener.id);
}

async function getNavigationSource(tabId, windowId) {
  const sourceTabId = navigationSources.get(tabId);
  navigationSources.delete(tabId);

  if (!Number.isInteger(sourceTabId)) {
    return undefined;
  }

  const opener = await getTab(sourceTabId);
  if (!opener || opener.windowId !== windowId) {
    return undefined;
  }

  return opener;
}

async function moveToTopOfUnpinnedTabs(tabId, windowId) {
  await moveWithRetry(async () => {
    const tab = await getTab(tabId);
    if (!tab || tab.pinned) {
      return;
    }

    const tabs = await chrome.tabs.query({ windowId });
    tabs.sort((a, b) => a.index - b.index);

    const firstUnpinned = tabs.find((candidate) => !candidate.pinned);
    const targetIndex = firstUnpinned ? firstUnpinned.index : 0;

    if (tab.index !== targetIndex) {
      await chrome.tabs.move(tabId, { index: targetIndex });
    }
  });
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

function indexImmediatelyAfter(sourceIndex, openerIndex) {
  return sourceIndex < openerIndex ? openerIndex : openerIndex + 1;
}

async function moveWithRetry(operation, attempt = 1) {
  try {
    await operation();
  } catch (error) {
    if (attempt < MAX_MOVE_ATTEMPTS && isTransientTabEditError(error)) {
      await delay(RETRY_DELAY_MS);
      await moveWithRetry(operation, attempt + 1);
      return;
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
