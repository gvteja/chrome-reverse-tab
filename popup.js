const moveSelectedTabsButton = document.getElementById("move-selected-tabs");
const copySelectedTabUrlsButton = document.getElementById("copy-selected-tab-urls");
const openOptionsButton = document.getElementById("open-options");
const statusMessage = document.getElementById("status");

moveSelectedTabsButton.addEventListener("click", () => {
  runSelectedTabAction("move-tab-to-top");
});

copySelectedTabUrlsButton.addEventListener("click", () => {
  runSelectedTabAction("copy-selected-tab-urls");
});

openOptionsButton.addEventListener("click", () => {
  chrome.runtime.openOptionsPage();
});

async function runSelectedTabAction(action) {
  setActionButtonsDisabled(true);

  try {
    const activeTabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    const windowId = activeTabs.find((tab) => Number.isInteger(tab.windowId))?.windowId;

    if (!Number.isInteger(windowId)) {
      throw new Error("Unable to determine which Chrome window to use.");
    }

    const response = await chrome.runtime.sendMessage({
      type: "run-selected-tab-action",
      action,
      windowId
    });

    if (!response?.ok) {
      throw new Error(response?.error || "The tab action failed.");
    }

    showStatus(response.message);
  } catch (error) {
    showStatus(`Unable to run tab action: ${error.message || error.name || error}`);
  } finally {
    setActionButtonsDisabled(false);
  }
}

function setActionButtonsDisabled(disabled) {
  moveSelectedTabsButton.disabled = disabled;
  copySelectedTabUrlsButton.disabled = disabled;
}

function showStatus(message) {
  statusMessage.textContent = message;
}
