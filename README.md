# simple-http-video-server

局域网 / Tailscale 内使用的简易 HTTP 视频目录服务。无鉴权，目录索引 + 直链，支持 HTTP Range（播放器可拖动进度）。不做转码。

## 要求

- Node.js >= 18

## 安装

```bash
npm install
```

## 启动

```bash
# 默认目录 D:/Video，端口 8080
npm start

# 指定目录与端口
node server.js --dir "D:/Video" --port 8080

# 环境变量
set VIDEO_DIR=D:\Video
set PORT=8080
npm start
```

## 参数

| 参数 | 环境变量 | 默认 | 说明 |
|------|----------|------|------|
| `-d, --dir` | `VIDEO_DIR` | `D:/Video` | 视频根目录 |
| `-p, --port` | `PORT` | `8080` | 监听端口 |
| `-h, --host` | `HOST` | `0.0.0.0` | 绑定地址 |

## 使用

1. 浏览器打开 `http://<本机Tailscale IP>:8080/` 浏览目录
2. 点击文件获得直链，例如 `http://100.x.x.x:8080/电影/xxx.mkv`
3. 将直链粘贴到 PotPlayer / VLC / Infuse 等播放器

## 说明

- 仅服务 `VIDEO_DIR` 下的文件，路径做了越界校验
- 支持 `Range` / `HEAD` / `OPTIONS`，便于 seek 与探测
- 网页为缩略图网格；视频/图片缩略图由 **ffmpeg** 生成并缓存（非转码）
- 缩略图缓存默认：系统临时目录 `simple-http-video-server-thumbs`，可用 `--thumb-dir` / `THUMB_DIR` 指定
- 无登录、无 HTTPS（假定 Tailscale 内网）
- 不转码正片流
