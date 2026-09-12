"use strict";

const path = require("path");
const express = require("express");

const config = require("../config");
const api = require("../api");
const { updateEnvFile } = require("../envStore");
const botControl = require("../botControl");
const oauthClient = require("../official/oauthClient");
const { botLog } = require("../utils");
const commandStore = require("../commandStore");
const banwordStore = require("../banwordStore");
const systemCommandStore = require("../systemCommandStore");
const { getSystemCommands } = require("./systemCommands");

// package.json의 버전을 관리 페이지에 그대로 보여주기 위해 읽어둠 (빌드 시점 값 그대로,
// 매 요청마다 파일을 다시 읽을 필요 없어서 시작할 때 한 번만 읽음)
let appVersion = "";
try {
  appVersion = require("../../package.json").version || "";
} catch (_err) {
  appVersion = "";
}

// 로그 확인 창은 크롬 새 탭이 아니라 이 앱과 똑같은 Electron 창으로 띄웁니다.
// (server.js는 electron-main.js가 시작한 메인 프로세스 안에서 그대로 실행되므로
// 여기서 바로 BrowserWindow를 만들 수 있어요. CLI(node index.js)로 실행 중이면
// Electron 자체가 없으니 그 환경에서는 브라우저 탭으로 대체하도록 안내만 함.)
let electronMod = null;
try {
  electronMod = require("electron");
} catch (_err) {
  electronMod = null;
}
const isElectron = !!(electronMod && typeof electronMod === "object");
const BrowserWindow = isElectron ? electronMod.BrowserWindow : null;
let logWindow = null;

// 채널 프로필(이름/이미지) 캐시 — 매 요청마다 CHZZK API를 부르지 않도록 잠깐 기억해둠
let channelProfileCache = null;
let channelProfileCacheAt = 0;
const CHANNEL_PROFILE_TTL_MS = 60_000;

async function getChannelProfile() {
  if (!config.channelId) return { channelName: null, channelImageUrl: null };
  const now = Date.now();
  if (channelProfileCache && now - channelProfileCacheAt < CHANNEL_PROFILE_TTL_MS) {
    return channelProfileCache;
  }
  try {
    const result = await api.getChannels([config.channelId]);
    const ch = (result && result.data && result.data[0]) || null;
    channelProfileCache = {
      channelName: (ch && ch.channelName) || null,
      channelImageUrl: (ch && ch.channelImageUrl) || null,
    };
  } catch (err) {
    console.warn("[web] 채널 정보 조회 실패 (치명적이지 않음):", err.message);
    channelProfileCache = channelProfileCache || { channelName: null, channelImageUrl: null };
  }
  channelProfileCacheAt = now;
  return channelProfileCache;
}

function invalidateChannelProfileCache() {
  channelProfileCacheAt = 0;
}

function commandsToArray() {
  return Object.entries(commandStore.all()).map(([name, cmd]) => ({ name, ...cmd }));
}

function ok(res, data) {
  res.json({ ok: true, data });
}

function fail(res, status, message) {
  res.status(status).json({ ok: false, error: message });
}

function wrap(handler) {
  return (req, res) => {
    try {
      Promise.resolve(handler(req, res)).catch((err) => {
        console.error("[web] 처리 중 오류:", err);
        fail(res, 500, err.message || "서버 오류");
      });
    } catch (err) {
      console.error("[web] 처리 중 오류:", err);
      fail(res, 500, err.message || "서버 오류");
    }
  };
}

function createApp() {
  const app = express();
  app.use(express.json());
  app.use(express.static(path.join(__dirname, "public")));

  // ---- 상태 ----
  app.get(
    "/api/status",
    wrap(async (req, res) => {
      const profile = await getChannelProfile();
      ok(res, {
        channelId: config.channelId,
        commandPrefix: config.commandPrefix,
        channelName: profile.channelName,
        channelImageUrl: profile.channelImageUrl,
        appVersion,
      });
    })
  );

  // ---- 시스템 명령어 (응답 로직은 고정, 필요 권한만 조정 가능) ----
  app.get(
    "/api/system-commands",
    wrap((req, res) => {
      ok(res, getSystemCommands());
    })
  );

  app.patch(
    "/api/system-commands/:key/permission",
    wrap((req, res) => {
      const { permission } = req.body || {};
      const updated = systemCommandStore.setPermission(req.params.key, permission);
      if (!updated) return fail(res, 400, "잘못된 권한 값이거나 알 수 없는 명령어예요.");
      ok(res, { key: req.params.key, ...updated });
    })
  );

  app.patch(
    "/api/system-commands/:key/cooldown",
    wrap((req, res) => {
      const { cooldownSec } = req.body || {};
      const updated = systemCommandStore.setCooldownSec(req.params.key, cooldownSec);
      if (!updated) return fail(res, 400, "쿨타임은 0 이상의 숫자여야 해요.");
      ok(res, { key: req.params.key, ...updated });
    })
  );

  app.patch(
    "/api/system-commands/:key/enabled",
    wrap((req, res) => {
      const { enabled } = req.body || {};
      const updated = systemCommandStore.setEnabled(req.params.key, !!enabled);
      ok(res, { key: req.params.key, ...updated });
    })
  );

  // ---- 유저(커스텀) 명령어 ----
  app.get(
    "/api/commands",
    wrap((req, res) => {
      ok(res, commandsToArray());
    })
  );

  app.post(
    "/api/commands",
    wrap((req, res) => {
      const { name, response, permission, cooldownSec, userCooldownSec, listed, description } =
        req.body || {};
      if (!name || !name.trim()) return fail(res, 400, "명령어 이름을 입력해주세요.");
      if (!response || !response.trim()) return fail(res, 400, "응답 메시지를 입력해주세요.");

      const key = name.trim().replace(new RegExp(`^\\${config.commandPrefix}`), "");
      if (commandStore.has(key)) return fail(res, 400, `'${key}' 명령어가 이미 있어요.`);

      const created = commandStore.add(key, response, {
        permission,
        cooldownSec: cooldownSec !== undefined ? Number(cooldownSec) : undefined,
        userCooldownSec: userCooldownSec !== undefined ? Number(userCooldownSec) : undefined,
        listed,
        description,
      });
      ok(res, { name: key, ...created });
    })
  );

  app.put(
    "/api/commands/:name",
    wrap((req, res) => {
      const { name } = req.params;
      const { response, permission, cooldownSec, userCooldownSec, listed, description } =
        req.body || {};

      if (!commandStore.has(name)) return fail(res, 404, `'${name}' 명령어를 찾을 수 없어요.`);

      if (response !== undefined) commandStore.update(name, response);
      commandStore.setMeta(name, {
        ...(permission !== undefined ? { permission } : {}),
        ...(cooldownSec !== undefined ? { cooldownSec: Number(cooldownSec) } : {}),
        ...(userCooldownSec !== undefined ? { userCooldownSec: Number(userCooldownSec) } : {}),
        ...(listed !== undefined ? { listed } : {}),
        ...(description !== undefined ? { description } : {}),
      });

      ok(res, { name, ...commandStore.get(name) });
    })
  );

  app.patch(
    "/api/commands/:name/enabled",
    wrap((req, res) => {
      const { name } = req.params;
      const { enabled } = req.body || {};
      const updated = commandStore.setEnabled(name, !!enabled);
      if (!updated) return fail(res, 404, `'${name}' 명령어를 찾을 수 없어요.`);
      ok(res, { name, ...updated });
    })
  );

  app.delete(
    "/api/commands/:name",
    wrap((req, res) => {
      const removed = commandStore.remove(req.params.name);
      if (!removed) return fail(res, 404, `'${req.params.name}' 명령어를 찾을 수 없어요.`);
      ok(res, { name: req.params.name });
    })
  );

  // ---- 금칙어 ----
  app.get(
    "/api/banwords",
    wrap((req, res) => {
      ok(res, banwordStore.all());
    })
  );

  app.post(
    "/api/banwords",
    wrap((req, res) => {
      const { word, action } = req.body || {};
      if (!word || !word.trim()) return fail(res, 400, "금칙어를 입력해주세요.");
      const entry = banwordStore.add(word.trim(), action);
      ok(res, entry);
    })
  );

  app.patch(
    "/api/banwords/:id/enabled",
    wrap((req, res) => {
      const { enabled } = req.body || {};
      const updated = banwordStore.setEnabled(req.params.id, !!enabled);
      if (!updated) return fail(res, 404, "해당 금칙어를 찾을 수 없어요.");
      ok(res, updated);
    })
  );

  app.delete(
    "/api/banwords/:id",
    wrap((req, res) => {
      const removed = banwordStore.remove(req.params.id);
      if (!removed) return fail(res, 404, "해당 금칙어를 찾을 수 없어요.");
      ok(res, { id: req.params.id });
    })
  );

  // ---- 계정 연동 (치지직 애플리케이션 설정 — 채널 프로필 조회용 Client ID/Secret) ----
  app.get(
    "/api/auth/status",
    wrap((req, res) => {
      ok(res, {
        clientId: config.clientId || "",
        hasClientSecret: !!config.clientSecret,
        channelId: config.channelId || "",
        redirectUri: config.redirectUri || "",
        bot: botControl.getStatus(),
      });
    })
  );

  app.post(
    "/api/auth/config",
    wrap((req, res) => {
      const { clientId, clientSecret, channelId, redirectUri } = req.body || {};
      const updates = {};
      let redirectUriChanged = false;

      if (clientId !== undefined) {
        config.clientId = String(clientId).trim();
        updates.CLIENT_ID = config.clientId;
      }
      if (clientSecret !== undefined && String(clientSecret).trim() !== "") {
        // 빈 값으로 보내면(= 화면에서 안 건드림) 기존 값을 유지함 (마스킹된 값을 실수로 덮어쓰지 않도록)
        config.clientSecret = String(clientSecret).trim();
        updates.CLIENT_SECRET = config.clientSecret;
      }
      if (channelId !== undefined) {
        config.channelId = String(channelId).trim();
        updates.CHANNEL_ID = config.channelId;
      }
      // Redirect URI는 사람마다(포트나 도메인이 다르면) 다르게 등록돼있을 수 있어서,
      // 치지직 개발자 센터에 등록해둔 값을 그대로 붙여넣으면 되게 함. 그 값에서 포트를
      // 추출해서 WEB_PORT도 같이 맞춰줌 — 관리 페이지랑 콜백을 같은 포트에서 받아야 하거든요.
      // (실제로 적용되려면 이미 그 포트로 켜져있는 웹서버를 재시작해야 해서, 앱을 껐다 켜야 함)
      if (redirectUri !== undefined && String(redirectUri).trim() !== "") {
        const trimmed = String(redirectUri).trim();
        let parsed;
        try {
          parsed = new URL(trimmed);
        } catch (err) {
          return fail(res, 400, "Redirect URI 형식이 올바르지 않아요. http://localhost:포트/callback 형태여야 해요.");
        }
        if (trimmed !== config.redirectUri) {
          redirectUriChanged = true;
          config.redirectUri = trimmed;
          updates.REDIRECT_URI = trimmed;
          if (parsed.port) {
            config.webPort = Number(parsed.port);
            updates.WEB_PORT = String(config.webPort);
          }
        }
      }

      if (Object.keys(updates).length) {
        updateEnvFile(config.envFilePath, updates);
        invalidateChannelProfileCache();
      }

      ok(res, {
        clientId: config.clientId || "",
        hasClientSecret: !!config.clientSecret,
        channelId: config.channelId || "",
        redirectUri: config.redirectUri || "",
        redirectUriChanged,
      });
    })
  );

  app.post(
    "/api/bot/restart-session",
    wrap(async (req, res) => {
      const result = await botControl.restartSession();
      invalidateChannelProfileCache();
      ok(res, { ...result, bot: botControl.getStatus() });
    })
  );

  // ---- 치지직 공식 OAuth 인가 ----
  // 방송인(또는 매니저 계정)이 "치지직 인가 페이지"에서 한 번 로그인/허용해주면
  // 그 계정 권한으로 채팅 읽기/쓰기/제재를 대신 수행하는 방식이에요.
  app.get(
    "/api/oauth/status",
    wrap((req, res) => {
      const tokens = oauthClient.getTokens();
      ok(res, {
        authorized: oauthClient.isAuthorized(),
        scope: (tokens && tokens.scope) || "",
        obtainedAt: (tokens && tokens.obtainedAt) || null,
      });
    })
  );

  // 인가 페이지 URL을 새로 발급해서 돌려줌 (프론트에서 이 URL을 시스템 브라우저나
  // 별도 창으로 열어서 방송인이 로그인/허용하도록 안내함)
  app.get(
    "/api/oauth/authorize-url",
    wrap((req, res) => {
      ok(res, { url: oauthClient.buildAuthorizeUrl() });
    })
  );

  // 인가 페이지를 바로 사용자의 실제 브라우저로 열어줌 (이미 네이버에 로그인돼있을 수 있고,
  // 앱 내장 창보다 로그인 성공률이 높아서 임베드된 창 대신 시스템 브라우저를 씀)
  app.post(
    "/api/oauth/open",
    wrap((req, res) => {
      const url = oauthClient.buildAuthorizeUrl();
      if (isElectron && electronMod.shell) {
        electronMod.shell.openExternal(url);
        ok(res, { opened: true, url });
      } else {
        ok(res, { opened: false, url });
      }
    })
  );

  // 인가 페이지에서 허용을 누르면 치지직이 이 주소(redirectUri)로 code/state를 돌려줌.
  // 여기서 바로 토큰으로 교환하고, 사용자에게는 간단한 안내 페이지만 보여줌.
  app.get(
    "/callback",
    wrap(async (req, res) => {
      const { code, state, error } = req.query || {};
      if (error) {
        res.status(400).send(`<h2>인가가 취소됐어요</h2><p>${error}</p><p>이 창을 닫고 다시 시도해주세요.</p>`);
        return;
      }
      if (!code) {
        res.status(400).send("<h2>잘못된 요청이에요</h2><p>code 파라미터가 없어요.</p>");
        return;
      }
      try {
        await oauthClient.exchangeCode(code, state);
        const restartResult = await botControl.restartSession();
        invalidateChannelProfileCache();
        const ok2 = restartResult && restartResult.ok;
        res.send(
          `<h2>인가 완료!</h2><p>${ok2 ? "채팅 연결까지 확인했어요." : "인가는 됐지만 채팅 연결에 문제가 있어요: " + (restartResult && restartResult.error)}</p><p>이 창은 닫아도 돼요.</p>`
        );
      } catch (err) {
        res.status(500).send(`<h2>인가 처리 실패</h2><p>${err.message}</p>`);
      }
    })
  );

  app.delete(
    "/api/oauth/credentials",
    wrap((req, res) => {
      oauthClient.clear();
      botControl.restartSession().catch(() => {});
      ok(res, { authorized: false });
    })
  );

  // 발급된 accessToken/refreshToken 실제 값 조회 — 절대 로그로 남기지 않고,
  // 사용자가 대시보드에서 "값 보기" 버튼을 눌렀을 때만 호출됨. 유출되면 그 권한으로
  // API가 호출될 수 있는 민감한 값이라 별도 안내 없이 노출하지 않도록 주의.
  app.get(
    "/api/oauth/tokens",
    wrap((req, res) => {
      const tokens = oauthClient.getTokens();
      ok(res, {
        accessToken: (tokens && tokens.accessToken) || "",
        refreshToken: (tokens && tokens.refreshToken) || "",
      });
    })
  );

  // ---- 봇 연결/채팅 로그 (대시보드에서 실시간 터미널처럼 확인용) ----
  app.get(
    "/api/bot/logs",
    wrap((req, res) => {
      ok(res, botLog.getAll());
    })
  );

  app.delete(
    "/api/bot/logs",
    wrap((req, res) => {
      botLog.clear();
      ok(res, []);
    })
  );

  // 로그 확인 창을 이 앱과 같은 Electron 창(별도 데스크톱 창)으로 엽니다.
  app.post(
    "/api/bot/open-log-window",
    wrap((req, res) => {
      if (!isElectron || !BrowserWindow) {
        return fail(res, 400, "이 실행 환경(터미널)에서는 별도 창을 열 수 없어요. Electron 앱(npm start)에서 실행해주세요.");
      }
      if (logWindow && !logWindow.isDestroyed()) {
        logWindow.focus();
        return ok(res, { opened: true, focused: true });
      }
      logWindow = new BrowserWindow({
        width: 760,
        height: 560,
        title: "새벽봇 로그",
        webPreferences: { contextIsolation: true, nodeIntegration: false },
      });
      logWindow.setMenuBarVisibility(false);
      logWindow.loadURL(`http://localhost:${config.webPort}/log-viewer.html`);
      logWindow.on("closed", () => {
        logWindow = null;
      });
      ok(res, { opened: true });
    })
  );

  return app;
}

function startWebServer() {
  if (!config.webEnabled) {
    console.log("[web] WEB_ENABLED=false 로 설정되어 관리 페이지를 켜지 않습니다.");
    return null;
  }

  const app = createApp();
  // 127.0.0.1 에만 바인딩 — 같은 컴퓨터에서만 접속 가능 (원격 접속 불가)
  const server = app.listen(config.webPort, "127.0.0.1", () => {
    console.log(`[web] 관리 페이지: http://localhost:${config.webPort} (이 컴퓨터에서만 접속 가능)`);
  });
  server.on("error", (err) => {
    console.error("[web] 관리 페이지 서버를 시작하지 못했습니다:", err.message);
  });
  return server;
}

module.exports = { startWebServer, createApp };
