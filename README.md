# Tim 占领 B 站

> 把 B 站封面里**所有**的人脸都换成「影视飓风 Tim」的脸。

一个让你打开 B 站首页就能笑出声的 Chrome 扩展。

---

## 这是什么

打开 [bilibili.com](https://www.bilibili.com)，扩展会自动扫描每张视频封面，找到里面的人脸，把每一张脸都替换成 Tim 的脸——尺寸、旋转角度、左右镜像都会自动跟着原脸调整。多人封面所有人都会变成 Tim。

> _截图位置_——装上后随便刷一下 B 站首页，截一张发给朋友就懂了。

## 安装

### 方式 1：Chrome Web Store
> _即将上架_

### 方式 2：手动加载（推荐给等不及的）

1. 下载本仓库：[Download ZIP](https://github.com/Kaedeeeeeeeeee/Bilibili-Timify/archive/refs/heads/main.zip)
2. 解压到任意目录
3. 打开 Chrome，地址栏输入 `chrome://extensions/`
4. 右上角打开「**开发者模式**」开关
5. 点击「**加载已解压的扩展程序**」，选中刚才解压的文件夹
6. 打开 [bilibili.com](https://www.bilibili.com)，欢迎来到全是 Tim 的世界

## 工作原理

```
B 站封面 <img>  →  发现 → 取像素 → 检脸 + landmark → 合成 Tim → 替换 src
```

- **[face-api.js](https://github.com/justadudewhohacks/face-api.js)** 在浏览器本地跑 TinyFaceDetector + faceLandmark68Tiny 模型
- Service worker 代理 fetch B 站 CDN 图片，绕过 canvas tainted 限制
- 合成时按"Tim 脸 bbox 中心对齐目标脸 bbox 中心"做精确缩放
- 两眼连线算 roll 角度 → 旋转 Tim
- 鼻尖到左/右下颌的距离差算 yaw 朝向 → 朝向相反就镜像 Tim
- IntersectionObserver 懒处理 + URL → dataURL 缓存，同一封面只算一次

所有计算都在你本地浏览器里完成。**不上传任何图片或数据到任何服务器。**

## 调参

`content.js` 顶部有几个常量旋钮：

| 常量 | 作用 | 默认 |
|---|---|---|
| `FACE_PADDING` | Tim 脸宽 / 目标脸宽。1.0 = 同宽，>1 = 盖出去一些，<1 = 留白 | `1.0` |
| `FACE_VOFFSET` | 精确对齐后再做的垂直微调（占脸高比例） | `0` |
| `SCORE_THRESHOLD` | 人脸检测置信度阈值 | `0.5` |
| `YAW_FORWARD_THRESH` | yaw 小于此值视为正脸不参与镜像 | `0.04` |
| `COVER_SELECTORS` | B 站封面的 CSS 选择器列表，按需加 | 详见代码 |

改完去 `chrome://extensions/` 点扩展卡片右下角的 🔄 刷新，再刷 B 站 Tab。

## 已知限制

- 只处理静态封面 `<img>`。鼠标 hover 后 B 站会切到动图（webp）预览，那个不动
- B 站前端改版后 selector 可能失效，到时候去 `COVER_SELECTORS` 加新的
- face-api 模型首次加载约 1-2 秒，期间封面是原图
- 偶尔会把云彩、logo 之类的误判为脸（置信度阈值能调）

## 调试

打开 DevTools Console，扩展会打日志：

```
[timify] tim face bbox=... | yaw=... → sign=±1
[timify] composed N face(s): [{box, roll, yaw, mirror}, ...]
[timify] found=82 hit=13 miss=45 faces=14 err=0 cache=58
```

也可以在 console 里跑：

```js
__timify.stats()         // 当前累计统计
__timify.selectors       // 当前生效的封面选择器
__timify.rescan()        // 强制重新扫描页面
```

## Credits

- 人脸检测：[face-api.js](https://github.com/justadudewhohacks/face-api.js) by Vincent Mühler
- Tim 的图：他本人的脸，仅作个人爱好用途，请勿商用
