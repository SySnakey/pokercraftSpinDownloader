document.addEventListener("DOMContentLoaded", () => {
  // Default to last 7 days
  const today = new Date();
  const lastWeek = new Date(today);
  lastWeek.setDate(lastWeek.getDate() - 7);

  document.getElementById("start-date").valueAsDate = lastWeek;
  document.getElementById("end-date").valueAsDate = today;
  
  function checkIvStatus() {
      chrome.storage.local.get("capturedIv", (res) => {
          const statusEl = document.getElementById("iv-status");
          if (res.capturedIv && res.capturedIv.length >= 16) {
              statusEl.style.color = "#4CAF50";
              statusEl.innerText = "IV Status: Captured OK";
          } else {
              statusEl.style.color = "#f44336";
              statusEl.innerText = "IV Status: Not Captured (Refresh Pokercraft page or Login again)";
          }
      });
  }
  
  checkIvStatus();
  chrome.storage.onChanged.addListener((changes, area) => {
      if (area === "local" && changes.capturedIv) checkIvStatus();
  });

  document.getElementById("btn-start").addEventListener("click", () => {
    const startDate = document.getElementById("start-date").value;
    const endDate = document.getElementById("end-date").value;
    const doSummary = document.getElementById("chk-summary").checked;
    const doHistory = document.getElementById("chk-history").checked;

    if (!startDate || !endDate) {
      alert("Please select both start and end dates.");
      return;
    }

    document.getElementById("btn-start").disabled = true;
    document.getElementById("log").innerText = "Starting download process...";

    chrome.runtime.sendMessage({
      type: "START_BATCH_DOWNLOAD",
      payload: { startDate, endDate, doSummary, doHistory }
    });
  });
});

chrome.runtime.onMessage.addListener((message) => {
  const logEl = document.getElementById("log");
  if (message.type === "BATCH_PROGRESS") {
    logEl.innerText += "\n" + message.payload.message;
  } else if (message.type === "BATCH_ERROR") {
    logEl.innerText += "\nError: " + message.error;
    document.getElementById("btn-start").disabled = false;
  } else if (message.type === "BATCH_COMPLETE") {
    logEl.innerText += "\nBatch complete!";
    document.getElementById("btn-start").disabled = false;
  }
  logEl.scrollTop = logEl.scrollHeight;
});
