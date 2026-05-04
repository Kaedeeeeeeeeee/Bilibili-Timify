// Service worker: 代理跨域 fetch B 站 CDN 图片，绕开 canvas tainted 限制。
// content script 通过 sendMessage 请求图片，这里用 host_permissions 拿到的权限拉取，
// 转成 dataURL 回传，content script 再用同源 dataURL 创建 Image 喂给 face-api。

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.type === "fetchImage" && typeof msg.url === "string") {
    fetchAsDataURL(msg.url)
      .then((dataURL) => sendResponse({ ok: true, dataURL }))
      .catch((err) => sendResponse({ ok: false, error: String(err && err.message || err) }));
    return true; // 异步响应
  }
});

async function fetchAsDataURL(url) {
  const res = await fetch(url, { credentials: "omit", cache: "force-cache" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const blob = await res.blob();
  return await blobToDataURL(blob);
}

function blobToDataURL(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}
