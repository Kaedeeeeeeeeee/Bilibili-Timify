// Bilibili Timify — content script
// 在 B 站封面里找最大的人脸，盖上 Tim 的脸。
// 流水线：MutationObserver/初始扫描发现封面 → IntersectionObserver 进视口
//   → background fetch 拉原图（绕 CORS）→ face-api tiny detector 检脸
//   → canvas 合成 Tim → 替换 img.src 为 dataURL。

(function () {
  "use strict";

  if (typeof faceapi === "undefined") {
    console.warn("[timify] face-api not loaded, abort");
    return;
  }

  // ===== 常量 =====
  const TIM_URL = chrome.runtime.getURL("tim-face.png");
  const MODEL_URL = chrome.runtime.getURL("models");
  const COVER_HOST = "hdslb.com";
  // ====== 调参旋钮 ======
  // FACE_PADDING：Tim 的【脸宽】相对目标脸的大小（精确对齐：Tim 脸中心 → 目标脸中心）
  //   1.0 = 同宽；>1 = Tim 脸更大盖出去一些；<1 = 留点目标原脸的边
  const FACE_PADDING = 1.0;
  // FACE_VOFFSET：精确对齐后再做的垂直微调（占目标脸高比例）。一般 0 即可
  const FACE_VOFFSET = 0;
  // YAW_FORWARD_THRESH：鼻尖偏离 bbox 中心的归一化阈值，小于此值视为正脸不参与镜像
  const YAW_FORWARD_THRESH = 0.04;
  const SCORE_THRESHOLD = 0.5;      // tinyFaceDetector 置信度阈值
  const INPUT_SIZE = 320;           // 模型输入尺寸，越小越快
  const MIN_NATURAL = 100;          // 太小的图（占位 / 头像）跳过
  const COVER_SELECTORS = [
    ".bili-video-card__cover img",
    ".bili-video-card__image img",
    ".bili-video-card__image--wrap img",
    ".video-page-card-small img",
    ".v-card-cover img",
    ".bpx-player-ending-related-item-image img"
  ];

  // ===== 状态 =====
  let timImage = null;
  let timFaceBox = null;            // Tim 自己脸在他图里的 bbox（用于精确对齐）
  let timNativeYaw = 0;             // Tim 自然朝向：-1 / +1 / 0
  let modelsReady = false;
  let _initPromise = null;
  const cache = new Map();          // url -> dataURL | null（null 代表没脸，不重试）
  const inFlight = new Map();       // url -> Promise<dataURL|null>
  const seen = new WeakSet();
  let io = null;
  let mo = null;
  const stats = { found: 0, hit: 0, miss: 0, err: 0, faces: 0 };

  // ===== 初始化 =====
  function init() {
    if (_initPromise) return _initPromise;
    _initPromise = (async () => {
      console.log("[timify] init…");
      timImage = await loadImage(TIM_URL);
      console.log(`[timify] tim image loaded ${timImage.naturalWidth}x${timImage.naturalHeight}`);
      await faceapi.nets.tinyFaceDetector.loadFromUri(MODEL_URL);
      await faceapi.nets.faceLandmark68TinyNet.loadFromUri(MODEL_URL);
      modelsReady = true;
      console.log("[timify] tinyFaceDetector + landmark68Tiny loaded");
      // 检测 Tim 自己脸：bbox 用于精确对齐，landmarks 用于判断自然朝向
      const timDet = pickLargest(await detectFaces(timImage));
      if (timDet) {
        timFaceBox = timDet.detection.box;
        const yaw = computeYawNorm(timDet);
        timNativeYaw = Math.abs(yaw) > YAW_FORWARD_THRESH ? Math.sign(yaw) : 0;
        console.log(
          `[timify] tim face bbox=${Math.round(timFaceBox.width)}x${Math.round(timFaceBox.height)} ` +
          `at (${Math.round(timFaceBox.x)},${Math.round(timFaceBox.y)}) | ` +
          `yaw=${yaw.toFixed(3)} → sign=${timNativeYaw}`
        );
      } else {
        console.warn("[timify] couldn't detect tim's face — falling back to image-center alignment");
      }
      startObserving();
    })();
    _initPromise.catch((e) => console.error("[timify] init failed", e));
    return _initPromise;
  }

  // ===== Helpers =====
  function loadImage(url) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error("image load failed: " + url));
      img.src = url;
    });
  }

  function fetchAsDataURL(url) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({ type: "fetchImage", url }, (res) => {
        if (chrome.runtime.lastError) {
          return reject(new Error(chrome.runtime.lastError.message));
        }
        if (!res) return reject(new Error("no response from background"));
        if (!res.ok) return reject(new Error(res.error || "fetch failed"));
        resolve(res.dataURL);
      });
    });
  }

  // ===== 检测 =====
  async function detectFaces(img) {
    const opts = new faceapi.TinyFaceDetectorOptions({
      inputSize: INPUT_SIZE,
      scoreThreshold: SCORE_THRESHOLD
    });
    return await faceapi.detectAllFaces(img, opts).withFaceLandmarks(true);
  }

  // 取最大脸（init 时给 Tim 自己的图用）
  function pickLargest(dets) {
    if (!dets.length) return null;
    let best = dets[0];
    for (const d of dets) {
      if (d.detection.box.area > best.detection.box.area) best = d;
    }
    return best;
  }

  // 平均一组点
  function avgPoint(points) {
    let sx = 0, sy = 0;
    for (const p of points) { sx += p.x; sy += p.y; }
    return { x: sx / points.length, y: sy / points.length };
  }

  // 从两眼连线算 roll 角度（弧度）
  function rollAngleFromLandmarks(landmarks) {
    try {
      const lc = avgPoint(landmarks.getLeftEye());
      const rc = avgPoint(landmarks.getRightEye());
      return Math.atan2(rc.y - lc.y, rc.x - lc.x);
    } catch (_) {
      return 0;
    }
  }

  // 用下颌不对称性当 yaw 信号：鼻尖到左下颌端 vs 右下颌端的距离差，归一化
  // 范围大致 [-0.5, +0.5]。正负号代表脸朝哪边（具体方向不重要，只要 Tim 和目标一致即可比较）
  function computeYawNorm(det) {
    try {
      const pos = det.landmarks.positions;
      const noseTip = pos[30];
      const jawL = pos[0];   // 一侧下颌端点
      const jawR = pos[16];  // 另一侧下颌端点
      const dL = Math.hypot(noseTip.x - jawL.x, noseTip.y - jawL.y);
      const dR = Math.hypot(noseTip.x - jawR.x, noseTip.y - jawR.y);
      return (dL - dR) / (dL + dR);
    } catch (_) {
      return 0;
    }
  }

  // 在 ctx 上画一个 Tim 头到给定的目标脸 detection 上
  function drawTimOnFace(ctx, det) {
    const box = det.detection.box;
    const angle = rollAngleFromLandmarks(det.landmarks);
    const targetYaw = computeYawNorm(det);
    const targetYawSign = Math.abs(targetYaw) > YAW_FORWARD_THRESH ? Math.sign(targetYaw) : 0;
    const shouldMirror = timNativeYaw !== 0 && targetYawSign !== 0 && timNativeYaw !== targetYawSign;

    // 精确对齐：以 Tim 脸 bbox 为基准缩放，让 Tim 脸宽 = 目标脸宽 × FACE_PADDING
    let scale, timFaceCx, timFaceCy;
    if (timFaceBox) {
      scale = (box.width * FACE_PADDING) / timFaceBox.width;
      timFaceCx = timFaceBox.x + timFaceBox.width / 2;
      timFaceCy = timFaceBox.y + timFaceBox.height / 2;
    } else {
      // Fallback：把整张图当成脸
      scale = (box.width * FACE_PADDING) / timImage.naturalWidth;
      timFaceCx = timImage.naturalWidth / 2;
      timFaceCy = timImage.naturalHeight / 2;
    }
    const drawW = timImage.naturalWidth * scale;
    const drawH = timImage.naturalHeight * scale;

    const targetCx = box.x + box.width / 2;
    const targetCy = box.y + box.height / 2 + box.height * FACE_VOFFSET;

    // 关键：drawImage 偏移 (-timFaceCx*scale, -timFaceCy*scale)，
    // 让 Tim 图里的脸中心点 (timFaceCx, timFaceCy) 对齐到 (targetCx, targetCy)
    ctx.save();
    ctx.translate(targetCx, targetCy);
    ctx.rotate(angle);
    if (shouldMirror) ctx.scale(-1, 1);
    ctx.drawImage(timImage, -timFaceCx * scale, -timFaceCy * scale, drawW, drawH);
    ctx.restore();

    return {
      box: { w: Math.round(box.width), h: Math.round(box.height) },
      roll: (angle * 180 / Math.PI).toFixed(1),
      yaw: targetYaw.toFixed(2),
      mirror: shouldMirror
    };
  }

  // ===== 合成（多脸）=====
  function composite(srcImg, dets) {
    const canvas = document.createElement("canvas");
    canvas.width = srcImg.naturalWidth;
    canvas.height = srcImg.naturalHeight;
    const ctx = canvas.getContext("2d");
    ctx.drawImage(srcImg, 0, 0);

    const infos = dets.map((det) => drawTimOnFace(ctx, det));
    console.debug(`[timify] composed ${dets.length} face(s):`, infos);

    return canvas.toDataURL("image/jpeg", 0.85);
  }

  // ===== 单图处理 =====
  async function processImg(img) {
    if (img.dataset.timified) return;
    if (!modelsReady) {
      try { await init(); } catch { return; }
    }
    const url = img.currentSrc || img.src;
    if (!url || url.startsWith("data:") || !url.includes(COVER_HOST)) return;

    // 缓存命中
    if (cache.has(url)) {
      const cached = cache.get(url);
      if (cached) apply(img, cached);
      return;
    }

    // 同 URL 合并请求
    let promise;
    if (inFlight.has(url)) {
      promise = inFlight.get(url);
    } else {
      promise = (async () => {
        const dataURL = await fetchAsDataURL(url);
        const sourceImg = await loadImage(dataURL);
        if (sourceImg.naturalWidth < MIN_NATURAL) {
          cache.set(url, null);
          return null;
        }
        const dets = await detectFaces(sourceImg);
        if (!dets.length) {
          cache.set(url, null);
          stats.miss++;
          return null;
        }
        const composed = composite(sourceImg, dets);
        cache.set(url, composed);
        stats.hit++;
        stats.faces += dets.length;
        return composed;
      })();
      inFlight.set(url, promise);
      promise.finally(() => inFlight.delete(url));
    }

    try {
      const result = await promise;
      if (result) apply(img, result);
    } catch (e) {
      stats.err++;
      console.debug("[timify] failed", url, e.message);
    }
  }

  function apply(img, dataURL) {
    if (img.dataset.timified) return;
    img.dataset.timified = "1"; // 先打标记，防 src 触发的 load 回调重入
    img.removeAttribute("srcset");
    img.srcset = "";
    // B站 封面常套在 <picture><source srcset="...webp"><img></picture> 里，
    // 浏览器会优先用 <source>，必须把所有 <source> 的 srcset 清掉
    const picture = img.closest("picture");
    if (picture) {
      for (const source of picture.querySelectorAll("source")) {
        source.removeAttribute("srcset");
        source.srcset = "";
      }
    }
    img.src = dataURL;
  }

  // ===== 发现封面 =====
  function findCovers(root) {
    const out = new Set();
    const scope = (root && root.querySelectorAll) ? root : document.body;
    for (const sel of COVER_SELECTORS) {
      try {
        for (const img of scope.querySelectorAll(sel)) out.add(img);
      } catch (_) { /* invalid selector or detached node */ }
    }
    return [...out];
  }

  function watchImg(img) {
    if (seen.has(img)) return;
    seen.add(img);
    stats.found++;
    io.observe(img);
  }

  function tryProcess(img) {
    if (img.dataset.timified) {
      io.unobserve(img);
      return;
    }
    const url = img.currentSrc || img.src;
    if (url && url.includes(COVER_HOST)) {
      processImg(img).finally(() => io.unobserve(img));
      return;
    }
    // src 还没好（懒加载占位）— 挂个 load 监听等真 src
    if (!img.dataset.timifyLoadHook) {
      img.dataset.timifyLoadHook = "1";
      img.addEventListener("load", () => {
        if (img.dataset.timified) return;
        const u = img.currentSrc || img.src;
        if (u && u.includes(COVER_HOST)) processImg(img);
      });
    }
  }

  function startObserving() {
    io = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) tryProcess(entry.target);
      }
    }, { rootMargin: "200px" });

    mo = new MutationObserver((mutations) => {
      for (const m of mutations) {
        for (const node of m.addedNodes) {
          if (node.nodeType !== 1) continue;
          if (node.tagName === "IMG") {
            for (const sel of COVER_SELECTORS) {
              try { if (node.matches(sel)) { watchImg(node); break; } } catch (_) {}
            }
          } else {
            for (const img of findCovers(node)) watchImg(img);
          }
        }
      }
    });
    mo.observe(document.body, { childList: true, subtree: true });

    // 初始扫描
    for (const img of findCovers(document.body)) watchImg(img);

    // 周期性日志（开发期）
    setInterval(() => {
      console.log(
        `[timify] found=${stats.found} hit=${stats.hit} miss=${stats.miss} faces=${stats.faces} err=${stats.err} cache=${cache.size}`
      );
    }, 10000);

    console.log("[timify] observing covers");
  }

  // 暴露调试入口
  window.__timify = {
    stats: () => ({ ...stats, cacheSize: cache.size }),
    selectors: COVER_SELECTORS,
    rescan: () => findCovers(document.body).forEach(watchImg)
  };

  init();
})();
