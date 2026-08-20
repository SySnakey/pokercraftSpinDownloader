(() => {
  let capturedIv = "";
  
  function notifyIv(value) {
      if (value && typeof value === "string" && value.length >= 16 && value !== capturedIv) {
          capturedIv = value;
          window.postMessage({ source: "bulk-downloader-hook", type: "IV_CAPTURED", value }, "*");
      }
  }

  Object.defineProperty(Object.prototype, "iv", {
    set(value) {
      notifyIv(value);
      this._iv = value;
    },
    get() { return this._iv; },
    configurable: true,
  });
  
  // Also try to find it in localStorage
  setInterval(() => {
      try {
          for (let i = 0; i < localStorage.length; i++) {
              let key = localStorage.key(i);
              let val = localStorage.getItem(key);
              if (val && typeof val === 'string' && val.includes('"iv":"')) {
                  let match = val.match(/"iv":"([^"]+)"/);
                  if (match && match[1]) notifyIv(match[1]);
              }
          }
      } catch(e) {}
  }, 2000);
  
  // Recursively search the window object in case the setter was missed
  function findIvInObject(o, depth = 0, visited = new Set()) {
      if (!o || typeof o !== 'object' || depth > 4 || visited.has(o)) return;
      visited.add(o);
      try {
          for (let key in o) {
              if (key === 'iv' && typeof o[key] === 'string' && o[key].length >= 16) {
                  notifyIv(o[key]);
                  return;
              }
              findIvInObject(o[key], depth + 1, visited);
          }
      } catch(e) {}
  }
  
  setTimeout(() => findIvInObject(window), 3000);
  setTimeout(() => findIvInObject(window), 8000);

  console.log("Bulk Downloader hook injected.");
})();
