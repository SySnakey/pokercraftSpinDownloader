// Inject script into page main world.
(() => {
  const script = document.createElement("script");
  script.src = chrome.runtime.getURL("hook.js");
  script.onload = () => script.remove();
  (document.head || document.documentElement).appendChild(script);
})();

// Listen for messages from the injected hook.js
window.addEventListener("message", (event) => {
  if (event.source !== window) return;
  const data = event.data;
  if (!data || data.source !== "bulk-downloader-hook") return;

  if (data.type === "IV_CAPTURED") {
    chrome.runtime.sendMessage({
      type: "IV_CAPTURED",
      payload: { value: data.value, capturedAt: Date.now() },
    });
  }
});

// Access page's IndexedDB to extract DPoP keys (Reused from Spinhub)
function getDpopKeyId() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open("pokercraft", 1);
    request.onerror = () => reject("Failed to open IndexedDB");
    request.onsuccess = (event) => {
      const db = event.target.result;
      const tx = db.transaction("keys", "readonly");
      const store = tx.objectStore("keys");
      let latestKeyId = null;
      let latestLastUsed = -Infinity;
      const cursorRequest = store.openCursor();
      cursorRequest.onsuccess = (e) => {
        const cursor = e.target.result;
        if (cursor) {
          const { meta } = cursor.value;
          if (meta?.lastUsed && meta.lastUsed > latestLastUsed) {
            latestLastUsed = meta.lastUsed;
            latestKeyId = cursor.key;
          }
          cursor.continue();
        }
      };
      cursorRequest.onerror = () => reject("Cursor error");
      tx.oncomplete = () => { db.close(); resolve(latestKeyId); };
      tx.onerror = () => reject("Transaction error");
    };
  });
}

function loadKey(keyId) {
  return new Promise((resolve, reject) => {
    if (!keyId) { resolve(null); return; }
    const request = indexedDB.open("pokercraft", 1);
    request.onerror = () => reject("Failed to open IndexedDB");
    request.onsuccess = (event) => {
      const db = event.target.result;
      const tx = db.transaction("keys", "readonly");
      const store = tx.objectStore("keys");
      const getRequest = store.get(keyId);
      getRequest.onsuccess = () => resolve(getRequest.result || null);
      getRequest.onerror = () => reject("Failed to load key");
      tx.oncomplete = () => db.close();
    };
  });
}

async function getOrCreateDpopKey() {
  const keyId = await getDpopKeyId();
  return await loadKey(keyId);
}

function saveKey(keyId, keyEntry) {
  return new Promise((resolve, reject) => {
    if (!keyId || !keyEntry) { resolve(); return; }
    const request = indexedDB.open("pokercraft", 1);
    request.onerror = () => reject("Failed to open IndexedDB");
    request.onsuccess = (event) => {
      const db = event.target.result;
      const tx = db.transaction("keys", "readwrite");
      const store = tx.objectStore("keys");
      const putRequest = store.put(keyEntry, keyId);
      putRequest.onerror = () => reject("Failed to save key");
      tx.oncomplete = () => { db.close(); resolve(); };
      tx.onerror = () => reject("Transaction error");
    };
  });
}

function generateUUID() {
  return crypto.randomUUID();
}

async function createDpopProof(method, url) {
  const keyEntry = await getOrCreateDpopKey();
  if (keyEntry.meta) {
    keyEntry.meta.lastUsed = Date.now();
    const keyId = await getDpopKeyId();
    saveKey(keyId, keyEntry);
  }

  const header = { typ: "dpop+jwt", alg: "ES256", jwk: keyEntry.pubJwk };
  const urlClean = new URL(url);
  urlClean.search = ""; // Important: DPoP is only for the base URL, ignoring query parameters!
  const payload = {
    htm: method.toUpperCase(),
    htu: new URL(urlClean.toString(), location.origin).toString(),
    iat: Math.floor(Date.now() / 1000),
    jti: generateUUID(),
  };

  const encodedHeader = base64url(header);
  const encodedPayload = base64url(payload);
  const data = new TextEncoder().encode(`${encodedHeader}.${encodedPayload}`);
  const signature = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    keyEntry.kp.privateKey,
    data
  );

  return `${encodedHeader}.${encodedPayload}.${base64UInt(signature)}`;
}

function base64url(obj) {
  return btoa(JSON.stringify(obj))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function base64UInt(obj) {
  return btoa(String.fromCharCode(...new Uint8Array(obj)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

// Handle requests from background.js for DPoP generation
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "REQUEST_DPOP") {
    createDpopProof(message.payload.method, message.payload.url)
      .then((proof) => sendResponse({ proof }))
      .catch((err) => sendResponse({ error: err.message }));
    return true; // Keep sendResponse channel open
  }
});
