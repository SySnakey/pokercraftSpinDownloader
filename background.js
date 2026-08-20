const POKERCRAFT_URLS = [
  "https://my.pokercraft.com/*",
  "https://wsop-my.pokercraft.com/*"
];

function getHeader(headers, name) {
  return headers.find(h => h.name.toLowerCase() === name.toLowerCase())?.value;
}

chrome.webRequest.onBeforeSendHeaders.addListener(
  (details) => {
    const authHeader = getHeader(details.requestHeaders, "authorization");
    if (authHeader) {
      chrome.storage.local.set({ authorization: authHeader, baseUrl: new URL(details.url).origin });
    }
  },
  { urls: POKERCRAFT_URLS },
  ["requestHeaders", "extraHeaders"]
);

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "IV_CAPTURED") {
    chrome.storage.local.set({ capturedIv: message.payload.value });
    if (sender && sender.tab && sender.tab.id) {
        chrome.storage.local.set({ activeTabId: sender.tab.id });
    }
  } else if (message.type === "START_BATCH_DOWNLOAD") {
    startBatchDownload(message.payload).then(() => {
      chrome.runtime.sendMessage({ type: "BATCH_COMPLETE" });
    }).catch(err => {
      console.error(err);
      chrome.runtime.sendMessage({ type: "BATCH_ERROR", error: err.message });
    });
  }
});

function requestDpopProof(method, url) {
  return new Promise((resolve, reject) => {
    chrome.storage.local.get(["activeTabId"], (result) => {
        const queryOptions = { url: POKERCRAFT_URLS };
        chrome.tabs.query(queryOptions, async (tabs) => {
          let targetTabs = tabs;
          if (result.activeTabId) {
              const activeTab = tabs.find(t => t.id === result.activeTabId);
              if (activeTab) {
                  targetTabs = [activeTab]; // Prioritize the tab that sent IV
              } else {
                  // If not found in query, try it anyway
                  targetTabs = [{ id: result.activeTabId }, ...tabs];
              }
          }
          
          if (targetTabs.length === 0) return reject(new Error("No Pokercraft tab open. Please keep it open!"));
      
      let lastError = null;
      for (const tab of targetTabs) {
          try {
              const result = await new Promise((res, rej) => {
                  chrome.tabs.sendMessage(tab.id, {
                    type: "REQUEST_DPOP",
                    payload: { method, url }
                  }, (response) => {
                    if (chrome.runtime.lastError) return rej(chrome.runtime.lastError);
                    if (!response) return rej(new Error("Empty response"));
                    if (response.error) return rej(new Error(response.error));
                    res(response.proof);
                  });
              });
              return resolve(result); // Success on this tab!
          } catch(e) {
              lastError = e;
          }
      }
      reject(new Error("Failed to get DPoP proof from any tab: " + (lastError ? lastError.message : "Unknown error")));
    });
  });
});
}

const delay = ms => new Promise(res => setTimeout(res, ms));

async function fetchWithDpop(url, method, body, authorization, capturedIv) {
  const dpop = await requestDpopProof(method, url);
  const headers = {
    "Authorization": authorization,
    "DPoP": dpop,
    "Accept": "application/json, text/plain, */*"
  };
  if (body) headers["Content-Type"] = "application/json";

  const options = { method, headers };
  if (body) options.body = JSON.stringify(body);

  const res = await fetch(url, options);
  if (!res.ok) throw new Error(`HTTP Error ${res.status} on ${url}`);
  
  const contentType = res.headers.get("content-type");
  if (contentType && contentType.includes("application/json")) {
     const json = await res.json();
     
     if (json && typeof json.data === 'string' && json.data.length > 32) {
         let debugIv = "unknown";
         let debugKeyLen = 0;
         try {
             // 1. Get the dynamic AES key from the response header 'A'
             const headerA = res.headers.get("A");
             if (!headerA || headerA.length <= 16) throw new Error("Missing or invalid A header");
             
             // The key is surrounded by 8 garbage characters on each side (learned from decompiled source)
             const rawKeyString = headerA.substring(8, headerA.length - 8);
             const keyBytes = new TextEncoder().encode(rawKeyString);
             debugKeyLen = keyBytes.length;
             const cryptoKey = await crypto.subtle.importKey("raw", keyBytes, { name: "AES-CBC" }, false, ["decrypt"]);
             
             // 2. Prepare the IV (fallback or captured)
             let ivString = "tE5_yR0~uI2-oP4aL6kS8jD1fG3hH9z1"; // Fallback IV
             if (capturedIv && capturedIv.length >= 16) {
                 ivString = capturedIv;
             }
             debugIv = ivString.substring(0, 16);
             // Java backend truncates the string to 16 bytes, then gets UTF-8 bytes
             const ivBytes = new TextEncoder().encode(ivString.substring(0, 16));
             
             // 3. Decode the encrypted data (it's hex)
             const hexToBytes = (hex) => new Uint8Array(hex.match(/.{1,2}/g).map(byte => parseInt(byte, 16)));
             const dataBytes = hexToBytes(json.data);
             
             // 4. Decrypt!
             const decryptedBuffer = await crypto.subtle.decrypt({ name: "AES-CBC", iv: ivBytes }, cryptoKey, dataBytes);
             const decryptedText = new TextDecoder().decode(decryptedBuffer);
             return JSON.parse(decryptedText);
         } catch (err) {
             console.error("Decryption failed", err);
             throw new Error(`Decryption failed (iv=${debugIv}, keyLen=${debugKeyLen}): ` + err.message);
         }
     }
     
     return json;
  }
  return res.text();
}

async function downloadZipWithDpop(url, authorization) {
  const dpop = await requestDpopProof('GET', url);
  const headers = {
    "Authorization": authorization,
    "DPoP": dpop,
    "Accept": "application/json, text/plain, */*"
  };
  
  const res = await fetch(url, { method: 'GET', headers });
  if (!res.ok) throw new Error(`HTTP Error ${res.status} on ${url}`);
  
  const blob = await res.blob();
  return blob;
}

async function startBatchDownload({ startDate, endDate, doSummary, doHistory }) {
  const { authorization, capturedIv, baseUrl } = await chrome.storage.local.get([
    "authorization", "capturedIv", "baseUrl"
  ]);
  
  if (!authorization || !baseUrl) throw new Error("Missing Authorization token. Please open the Pokercraft tab.");

  // GG Poker operates on UTC-8 (Pacific Time).
  // A GG Poker day starts at 00:00 UTC-8, which is 08:00 UTC.
  const SEARCH_ENDPOINT = `${baseUrl}/api/session/list/SpinAndGold`;
  let start = new Date(startDate + "T08:00:00Z"); 
  
  // The end day should cover up to 23:59:59 UTC-8, which is 07:59:59 UTC the next day.
  let end = new Date(endDate + "T08:00:00Z");
  end.setDate(end.getDate() + 1);
  end.setMilliseconds(end.getMilliseconds() - 1); // 07:59:59.999 UTC
  
  const startStr = startDate;
  const endStr = endDate;
  
  chrome.runtime.sendMessage({ type: "BATCH_PROGRESS", payload: { message: `Fetching games for GG Poker Time: ${startStr} to ${endStr}...` } });
  
  const fromEpoch = start.getTime();
  const toEpoch = end.getTime();
  const searchUrl = `${SEARCH_ENDPOINT}?from=${fromEpoch}&to=${toEpoch}&currency=USD&vipRoomCondition=NONE_VIP&isSpinAndGoldWinsOnly=false`;
  let games = [];
  
  try {
     const searchRes = await fetchWithDpop(searchUrl, 'GET', null, authorization, capturedIv);
     chrome.runtime.sendMessage({ type: "BATCH_PROGRESS", payload: { message: `Search decrypted successfully!` } });
     if (Array.isArray(searchRes)) games = searchRes;
     else if (searchRes.data && Array.isArray(searchRes.data)) games = searchRes.data;
     else if (searchRes.items && Array.isArray(searchRes.items)) games = searchRes.items;
     else if (searchRes.vm && Array.isArray(searchRes.vm)) games = searchRes.vm;
     
     if (games.length === 0) {
         chrome.runtime.sendMessage({ type: "BATCH_PROGRESS", payload: { message: `No games array found. Data preview: ${JSON.stringify(searchRes).substring(0,250)}` } });
     }
  } catch (e) {
     throw new Error(`Failed to fetch games list: ${e.message}`);
  }

  if (games.length === 0) {
      chrome.runtime.sendMessage({ type: "BATCH_PROGRESS", payload: { message: `No games found in this period.` } });
      return;
  }

  const MAX_HANDS = 19500;
  const MAX_GAMES = 490;

  const typesToDownload = [];
  if (doSummary) typesToDownload.push("summary");
  if (doHistory) typesToDownload.push("history");

  for (const type of typesToDownload) {
      chrome.runtime.sendMessage({ type: "BATCH_PROGRESS", payload: { message: `Preparing batches for ${type}...` } });

      let chunks = [];
      let currentChunk = [];
      let currentHands = 0;

      for (const game of games) {
         const hands = parseInt(game.hands || game.handCount || 0, 10);
         const gameId = (type === "summary") ? (game.tourneyId || game.id) : (game.sessionId || game.id);
         
         if (!gameId) continue;

         if (type === "history") {
             if (currentHands + hands > MAX_HANDS) {
                 chunks.push(currentChunk);
                 currentChunk = [];
                 currentHands = 0;
             }
             currentChunk.push(gameId);
             currentHands += hands;
         } else {
             if (currentChunk.length >= MAX_GAMES) {
                 chunks.push(currentChunk);
                 currentChunk = [];
             }
             currentChunk.push(gameId);
         }
      }
      if (currentChunk.length > 0) chunks.push(currentChunk);

      chrome.runtime.sendMessage({ type: "BATCH_PROGRESS", payload: { message: `Downloading ${type} in ${chunks.length} batches.` } });

      const endpointType = type === 'summary' ? 'summaries' : 'hands';
      const genUrl = `${baseUrl}/api/download/${endpointType}`;
      
      for (let i = 0; i < chunks.length; i++) {
         const chunk = chunks[i];
         chrome.runtime.sendMessage({ type: "BATCH_PROGRESS", payload: { message: `[${type}] Requesting batch ${i+1}/${chunks.length}...` } });

         const genBody = type === 'summary' ? { tourneyIdList: chunk } : { sessionlist: chunk }; 
         
         let genRes;
         try {
            genRes = await fetchWithDpop(genUrl, 'POST', genBody, authorization, capturedIv);
         } catch(e) {
             chrome.runtime.sendMessage({ type: "BATCH_PROGRESS", payload: { message: `Batch ${i+1} failed: ${e.message}` } });
             continue;
         }
         
         let jobId = null;
         if (typeof genRes === 'string') jobId = genRes.replace(/"/g, ''); 
         else if (genRes.vm && genRes.vm.code) jobId = genRes.vm.code;
         else if (genRes.result && genRes.result.code) jobId = genRes.result.code;
         else if (genRes.id) jobId = genRes.id;
         else if (genRes.jobId) jobId = genRes.jobId;
         else if (genRes.downloadId) jobId = genRes.downloadId;
         else if (genRes.data) jobId = genRes.data; 
         
         if (!jobId || typeof jobId === 'object') {
            chrome.runtime.sendMessage({ type: "BATCH_PROGRESS", payload: { message: `Could not parse Job ID for batch ${i+1}. Raw: ${JSON.stringify(genRes).substring(0,100)}` } });
            continue;
         }

         const progressUrl = `${baseUrl}/api/download/${endpointType}/progress/${jobId}`;
         const finalUrl = `${baseUrl}/api/download/${endpointType}/file/${jobId}`;
         
         chrome.runtime.sendMessage({ type: "BATCH_PROGRESS", payload: { message: `[${type}] Waiting for file to prepare on server...` } });
         
         let isReady = false;
         let attempts = 0;
         while (!isReady && attempts < 30) { // 30 attempts * 5s = 2.5 minutes
             await delay(5000); // 5 seconds interval
             attempts++;
             try {
                 const progRes = await fetchWithDpop(progressUrl, 'GET', null, authorization, capturedIv);
                 if (progRes.vm && progRes.vm.result === 'ready-to-download') {
                     isReady = true;
                     chrome.runtime.sendMessage({ type: "BATCH_PROGRESS", payload: { message: `[${type}] File ready! Starting download...` } });
                 } else {
                     chrome.runtime.sendMessage({ type: "BATCH_PROGRESS", payload: { message: `[${type}] Still preparing (attempt ${attempts}/30)...` } });
                 }
             } catch(e) {
                 // Ignore errors during polling and try again
             }
         }
         
         if (isReady) {
             try {
                 const blob = await downloadZipWithDpop(finalUrl, authorization);
                 const reader = new FileReader();
                 reader.onload = function() {
                     chrome.downloads.download({ 
                         url: reader.result, 
                         filename: `Pokercraft_${type}_batch_${i+1}.zip` 
                     });
                 };
                 reader.readAsDataURL(blob);
             } catch (e) {
                 chrome.runtime.sendMessage({ type: "BATCH_PROGRESS", payload: { message: `[${type}] Failed to download ZIP: ${e.message}` } });
             }
         } else {
             chrome.runtime.sendMessage({ type: "BATCH_PROGRESS", payload: { message: `[${type}] Timeout waiting for file to prepare.` } });
         }

         await delay(3000); // Wait 3 seconds between chunks
      }
  }
}
