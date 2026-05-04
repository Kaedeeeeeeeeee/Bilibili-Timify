# Privacy Policy — Tim 占领 B 站

**Last updated: 2026-05-04**

This Chrome extension ("the extension") does **not** collect, store, transmit, or share any personal data of any kind.

## What the extension does

The extension runs entirely in your browser. When you visit `bilibili.com`, it:

1. Reads the URLs of video thumbnail images on the page
2. Fetches those images (from Bilibili's own CDN, `*.hdslb.com`) via the extension's service worker
3. Runs face detection locally using [face-api.js](https://github.com/justadudewhohacks/face-api.js) — a JavaScript library that performs all computation in your browser
4. Composites a replacement face onto detected faces, in a local `<canvas>` element
5. Updates the thumbnail's `src` attribute to the composited result

## What data is sent to third parties

**None.** The extension makes no network requests other than fetching images from Bilibili's own CDN, which the page would have loaded anyway. No data — neither the original images, the detection results, nor any user information — is sent to any external server, including the extension author.

## What data is stored

**None.** The extension keeps a small in-memory cache of processed image URLs that is cleared when you close the tab. Nothing is persisted to disk via `chrome.storage`, cookies, or any other storage mechanism.

## Permissions

| Permission | Reason |
|---|---|
| `host_permissions: *://*.bilibili.com/*` | Inject the content script that finds and replaces face images |
| `host_permissions: *://*.hdslb.com/*` | Fetch original cover images from Bilibili's CDN to bypass canvas tainted-image restrictions |
| `storage` | Reserved for future use; no data is currently stored |

## Contact

For questions about this policy, open an issue at https://github.com/Kaedeeeeeeeeee/Bilibili-Timify
