const COPY_MESSAGE_TARGET = "offscreen-clipboard";

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.target !== COPY_MESSAGE_TARGET || message.type !== "copy-text") {
    return;
  }

  try {
    const textarea = document.createElement("textarea");
    textarea.value = message.text;
    document.body.append(textarea);
    textarea.select();

    const copied = document.execCommand("copy");
    textarea.remove();

    sendResponse({
      ok: copied,
      error: copied ? undefined : "Chrome rejected the clipboard operation."
    });
  } catch (error) {
    sendResponse({
      ok: false,
      error: error instanceof Error ? error.message : String(error)
    });
  }
});
