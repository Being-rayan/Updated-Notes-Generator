const profileForm = document.querySelector("#profile-form");
const formatForm = document.querySelector("#format-form");
const profileOutput = document.querySelector("#profile-output");
const formatOutput = document.querySelector("#format-output");
const formatResult = document.querySelector("#format-result");
const formatResultText = document.querySelector("#format-result-text");
const downloadLink = document.querySelector("#download-link");

function renderJson(target, value) {
  target.textContent =
    typeof value === "string" ? value : JSON.stringify(value, null, 2);
}

function hideDownloadResult() {
  formatResult.hidden = true;
  formatResultText.textContent = "";
  downloadLink.href = "#";
  downloadLink.removeAttribute("download");
}

function showDownloadResult(data) {
  const absoluteUrl = new URL(data.downloadUrl, window.location.origin).toString();
  downloadLink.href = absoluteUrl;
  downloadLink.setAttribute("download", data.outputName || "formatted-notes.pdf");
  const ocrSummary = data.usedImageOcr
    ? ` OCR converted ${data.ocrTextImages || 0} image${(data.ocrTextImages || 0) === 1 ? "" : "s"}.`
    : "";
  formatResultText.textContent = `Formatted PDF ready: ${data.outputName}.${ocrSummary}`.trim();
  formatResult.hidden = false;
  downloadLink.click();
}

async function postForm(url, formElement) {
  const formData = new FormData(formElement);
  let response;

  try {
    response = await fetch(url, {
      method: "POST",
      body: formData,
    });
  } catch {
    throw new Error(
      "Server connection failed. Refresh the page and make sure the local formatter server is still running.",
    );
  }

  const rawBody = await response.text();
  let data = {};

  try {
    data = rawBody ? JSON.parse(rawBody) : {};
  } catch {
    throw new Error(rawBody || `Request failed with status ${response.status}`);
  }

  if (!response.ok) {
    throw new Error(data.error || "Request failed");
  }

  return data;
}

profileForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  renderJson(profileOutput, "Rebuilding profile...");

  try {
    const data = await postForm("/api/profile/rebuild", profileForm);
    renderJson(profileOutput, data);
  } catch (error) {
    renderJson(profileOutput, error.message);
  }
});

formatForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  hideDownloadResult();
  renderJson(formatOutput, "Formatting PDF...");

  try {
    const data = await postForm("/api/format", formatForm);
    showDownloadResult(data);
    renderJson(formatOutput, {
      ...data,
      downloadUrl: downloadLink.href,
    });
  } catch (error) {
    hideDownloadResult();
    renderJson(formatOutput, error.message);
  }
});

fetch("/api/profile")
  .then((response) => response.json())
  .then((data) => renderJson(profileOutput, data))
  .catch(() => renderJson(profileOutput, "Profile not ready yet"));
