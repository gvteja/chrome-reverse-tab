const NANO_LANGUAGE_MODEL_OPTIONS = {
  expectedInputs: [{ type: "text", languages: ["en"] }],
  expectedOutputs: [{ type: "text", languages: ["en"] }]
};

const prepareModelButton = document.getElementById("prepare-model");
const checkStatusButton = document.getElementById("check-status");
const moveSelectedTabsButton = document.getElementById("move-selected-tabs");
const copySelectedTabUrlsButton = document.getElementById("copy-selected-tab-urls");
const modelStatusMessage = document.getElementById("model-status");
const tabActionStatusMessage = document.getElementById("tab-action-status");

checkAvailability();

prepareModelButton.addEventListener("click", async () => {
  const languageModel = getLanguageModelApi();
  if (!languageModel) {
    showStatus("Gemini Nano is not exposed in this Chrome build.");
    return;
  }

  setButtonsDisabled(true);

  try {
    const availability = await languageModel.availability(NANO_LANGUAGE_MODEL_OPTIONS);
    if (availability === "unavailable") {
      showStatus("Gemini Nano is unavailable on this device.");
      return;
    }

    const session = await languageModel.create({
      ...NANO_LANGUAGE_MODEL_OPTIONS,
      monitor(monitor) {
        monitor.addEventListener("downloadprogress", (event) => {
          showStatus(`Downloading local model: ${Math.round(event.loaded * 100)}%.`);
        });
      }
    });

    session.destroy();
    showStatus("Gemini Nano is ready.");
  } catch (error) {
    showStatus(`Unable to prepare Gemini Nano: ${error.message || error.name || error}`);
  } finally {
    setButtonsDisabled(false);
  }
});

checkStatusButton.addEventListener("click", checkAvailability);

moveSelectedTabsButton.addEventListener("click", () => {
  runSelectedTabAction("move-tab-to-top");
});

copySelectedTabUrlsButton.addEventListener("click", () => {
  runSelectedTabAction("copy-selected-tab-urls");
});

async function runSelectedTabAction(action) {
  setTabActionButtonsDisabled(true);

  try {
    const currentTab = await chrome.tabs.getCurrent();
    const response = await chrome.runtime.sendMessage({
      type: "run-selected-tab-action",
      action,
      windowId: currentTab?.windowId
    });

    if (!response?.ok) {
      throw new Error(response?.error || "The tab action failed.");
    }

    showTabActionStatus(response.message);
  } catch (error) {
    showTabActionStatus(`Unable to run tab action: ${error.message || error.name || error}`);
  } finally {
    setTabActionButtonsDisabled(false);
  }
}

async function checkAvailability() {
  const languageModel = getLanguageModelApi();
  if (!languageModel) {
    showStatus("Gemini Nano is not exposed in this Chrome build.");
    return;
  }

  try {
    const availability = await languageModel.availability(NANO_LANGUAGE_MODEL_OPTIONS);
    showStatus(`Gemini Nano status: ${availability}.`);
  } catch (error) {
    showStatus(`Unable to check Gemini Nano: ${error.message || error.name || error}`);
  }
}

function getLanguageModelApi() {
  const languageModel = globalThis.LanguageModel;
  return languageModel && typeof languageModel.availability === "function"
    ? languageModel
    : undefined;
}

function setButtonsDisabled(disabled) {
  prepareModelButton.disabled = disabled;
  checkStatusButton.disabled = disabled;
}

function setTabActionButtonsDisabled(disabled) {
  moveSelectedTabsButton.disabled = disabled;
  copySelectedTabUrlsButton.disabled = disabled;
}

function showStatus(message) {
  modelStatusMessage.textContent = message;
}

function showTabActionStatus(message) {
  tabActionStatusMessage.textContent = message;
}
