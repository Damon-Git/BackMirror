# BackMirror

BackMirror 是一个本地优先的 Web App，可以把手机变成私密摄像头，把电脑变成大屏实时预览器。它面向独自使用的场景，例如查看难以看见的皮肤区域、发型，或狭窄空间里的物体。

线上试用地址：https://backmirror-production.up.railway.app

BackMirror 只帮助你在本地拍摄图像。它不提供诊断、治疗，也不能替代专业医疗建议。

## 功能

- 通过二维码在同一局域网内配对。
- 手机后置摄像头通过 WebRTC 推流到电脑端。
- 电脑端实时预览，并支持镜像切换。
- 电脑端可发起拍照，手机端会从本地摄像头画面生成高清照片，避免直接截取 WebRTC 压缩预览流。
- 拍照后可以选择保存到电脑，也可以在手机端保存或分享，便于继续上传到其他 App。
- 显示手机摄像头实际分辨率和电脑端预览分辨率。
- 不上传云端，不在服务端保存图片或视频。
- 使用本地 HTTPS 服务，满足手机浏览器访问摄像头的要求。

## 环境要求

- Node.js 20 或更高版本。
- `openssl` 需要在 PATH 中可用，用于生成本地 HTTPS 证书。
- npm 需要可用，用于安装二维码生成依赖。
- 可选：`qrencode` 需要在 PATH 中可用。没有执行 `npm install` 时，服务端会尝试用它作为二维码生成降级方案。

安装依赖：

```bash
npm install
```

## 运行

```bash
node server.js
```

然后打开：

```text
https://localhost:7443
```

如果你的机器阻止绑定到所有网络接口，只想做本机开发测试，可以运行：

```bash
HOST=127.0.0.1 node server.js
```

服务启动后也会打印一个局域网 URL，例如：

```text
https://192.168.1.23:7443
```

在手机上打开这个局域网 URL，或扫描桌面端页面显示的二维码。

## 发布试用

最快的公网试用方式是部署到 Railway 这类支持 Node.js 和 WebSocket 的平台。生产环境下 BackMirror 会启动普通 HTTP 服务，由部署平台提供公网 HTTPS；本地运行仍然使用自签 HTTPS 证书。

### Railway 部署

1. 把仓库推到 GitHub。
2. 在 Railway 创建新的 Project，并选择从 GitHub 仓库部署。
3. 如果 Railway 自动识别 Node 项目，按提示创建服务即可；否则手动填写：
   - Build Command: `npm install`
   - Start Command: `npm start`
   - Environment Variable: `NODE_ENV=production`
4. 部署完成后，在 Railway 的 Networking / Public Networking 中生成公网域名。
5. 用手机扫描电脑端页面的二维码，允许摄像头权限后开始试用。

Railway 试用实例可能有额度限制。这个部署模式适合外部试用；如果你只想在同一局域网内完全本地使用，继续按“运行”章节启动即可。

### WebRTC 网络配置

生产环境默认使用 Google 的公开 STUN 服务：

```text
stun:stun.l.google.com:19302
```

如果试用用户处在更复杂的网络环境，点对点连接仍可能失败。可以通过环境变量覆盖 ICE 配置：

```bash
STUN_SERVERS=stun:stun.l.google.com:19302,stun:stun1.l.google.com:19302
```

或者传入完整 JSON，便于配置 TURN：

```bash
ICE_SERVERS='[{"urls":"stun:stun.l.google.com:19302"},{"urls":"turn:turn.example.com:3478","username":"user","credential":"pass"}]'
```

TURN 会中转媒体流，隐私和成本模型都不同；公开试用阶段可以先不用，等真实网络测试结果出来后再决定。

## 推荐浏览器

手机端需要浏览器稳定支持摄像头、WebRTC、WebRTC DataChannel 和本地 HTTPS。当前建议：

- Android：优先使用 Chrome。
- iPhone：优先使用 Safari。
- 不建议使用微信、QQ、夸克或部分手机厂商内置浏览器打开手机端页面；这些浏览器可能出现黑屏、无法调用摄像头、无法连接电脑端，或无法触发保存/分享。

如果手机端黑屏，请先确认：

- 手机和电脑处于同一局域网。
- 手机浏览器已允许摄像头权限。
- 手机端已接受本地 HTTPS 证书警告。
- 尝试改用 Chrome 或 Safari 后重新扫码打开。
- 手机端页面会显示基础兼容性提示；如果检测到疑似内置浏览器，建议复制链接后改用 Chrome 或 Safari 打开。

## 拍照与保存

电脑端的大屏画面主要用于取景。点击 `拍照` 后，电脑端和手机端会同时显示 3 秒倒计时；倒计时结束后，BackMirror 会让手机端从本地摄像头画面生成照片，再通过 WebRTC DataChannel 传回电脑端预览。

拍照完成后：

- 点击 `保存到电脑` 可以把照片下载到电脑。
- 点击 `发送到手机` 会在手机端显示这张照片和保存按钮。由于 iOS/Android 浏览器通常要求系统分享由手机上的用户点击触发，用户需要在手机端再点一次保存或分享。
- 支持 Web Share API 的浏览器可以直接分享到系统分享面板；不支持时会降级为浏览器下载。

图像质量取决于手机摄像头、对焦、光照和浏览器支持情况。桌面端会显示实际摄像头分辨率，方便判断当前设备是否真的提供了高清画面。

## HTTPS 证书

第一次运行时，BackMirror 会在 `.cert/` 目录中创建一个自签名证书。桌面端和手机端浏览器都会显示证书警告。你需要在两个设备上接受该警告，浏览器才会允许访问摄像头。

为了让后续使用更顺畅，你可以在开发机器上信任生成的证书，或用自己的本地证书替换 `.cert/cert.pem` 和 `.cert/key.pem`。

## 隐私说明

- 媒体流通过 WebRTC 在手机和电脑之间传输。
- Node 服务只处理静态文件和信令消息。
- 拍摄的图片在手机浏览器中生成，只在浏览器内存中短暂存在。
- 服务端不会把照片或视频帧写入磁盘。

## 当前限制

- 两台设备应处于同一局域网内。
- WebRTC 当前没有配置 STUN/TURN 服务，以保持本地优先；某些特殊网络环境可能会阻止点对点连接。
- 手电筒和对焦控制取决于手机浏览器支持情况。
- 手机端保存和分享到其他 App 取决于浏览器是否支持 Web Share API。
- 部分系统浏览器和 App 内置浏览器对本地 HTTPS、摄像头和 WebRTC 支持不稳定，可能出现黑屏或连接失败。
- 在称为生产可用之前，应在真实 iOS 和 Android 设备上验证摄像头行为。
