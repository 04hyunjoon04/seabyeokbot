"use strict";

const path = require("path");
const express = require("express");

const config = require("../config");
const api = require("../api");
const { updateEnvFile } = require("../envStore");
const botControl = require("../botControl");
const oauthClient = require("../official/oauthClient");
const { botLog, kst } = require("../utils");
const commandStore = require("../commandStore");
const banwordStore = require("../banwordStore");
const attendanceStore = require("../attendanceStore");
const rouletteStore = require("../rouletteStore");
const systemCommandStore = require("../systemCommandStore");
const backup = require("../backup");
const { getSystemCommands, isEditable: isSystemCommandEditable } = require("./systemCommands");
const { RESERVED_NAMES } = require("../commands");
const eventBus = require("../eventBus");

// 관리 페이지/오버레이로 실시간 변경 알림을 보낼 때 쓰는 이벤트 종류.
// roulette-spin은 룰렛이 실제로 당첨될 때마다 결과와 함께 오버레이로 전달되는 1회성 이벤트.
const SSE_EVENTS = [
  "commands",
  "system-commands",
  "banwords",
  "attendance",
  "roulette",
  "roulette-spin",
  "bot-status",
  "oauth",
];
const SSE_HEARTBEAT_MS = 25_000;

const DEFAULT_COOLDOWN_SEC = 3;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// 출석 수정 API에 들어온 날짜 문자열 검증. 형식이 틀리거나 미래 날짜면 null 반환.
function validateAttendanceDate(value) {
  if (typeof value !== "string" || !DATE_RE.test(value)) return null;
  if (value > kst.dateString()) return null;
  return value;
}

// 쿨타임 입력값이 숫자가 아니거나 음수면 기본값으로 대체
function sanitizeCooldown(value, fallback = DEFAULT_COOLDOWN_SEC) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

// 룰렛 이름에서 앞의 명령어 접두사(!)를 떼어내고 앞뒤 공백 제거
function normalizeRouletteName(name) {
  const trimmed = String(name || "").trim();
  return trimmed.startsWith(config.commandPrefix) ? trimmed.slice(config.commandPrefix.length) : trimmed;
}

// 룰렛 결과 목록: [{ text, probability, locked }] 형태로 정리하고 빈 문구 제거. 하나도 없으면 null.
// probability는 0~100 사이 숫자로 보정하고 소수점 2자리까지만 허용. 값이 없거나 잘못되면 0으로 처리.
// locked가 true인 항목은 !목록추가로 새 항목이 들어와도 확률이 재분배되지 않고 고정됨
function sanitizeRouletteOptions(options) {
  if (!Array.isArray(options)) return null;
  const cleaned = options
    .map((item) => {
      if (item && typeof item === "object") {
        const text = String(item.text ?? "").trim();
        if (!text) return null;
        let probability = Number(item.probability);
        if (!Number.isFinite(probability) || probability < 0) probability = 0;
        probability = Math.min(100, Math.round(probability * 100) / 100);
        return { text, probability, locked: !!item.locked };
      }
      const text = String(item ?? "").trim();
      return text ? { text, probability: 0, locked: false } : null;
    })
    .filter(Boolean);
  return cleaned.length ? cleaned : null;
}

// 결과 항목들의 확률 합이 100%에 충분히 가까운지 확인 (반올림 오차 허용 오차 0.05)
function probabilitiesSumToHundred(options) {
  const sum = options.reduce((acc, o) => acc + (Number(o.probability) || 0), 0);
  return Math.abs(sum - 100) <= 0.05;
}

// 후원 금액 필터 값 검증. 비어있으면 금액 상관없이 반응(null), 숫자면 0 이상 정수만 허용
function sanitizeDonationAmount(value) {
  if (value === undefined || value === null) return { ok: true, value: null };
  const trimmed = String(value).trim();
  if (trimmed === "") return { ok: true, value: null };
  const n = Number(trimmed);
  if (!Number.isFinite(n) || n < 0) return { ok: false, value: null };
  return { ok: true, value: Math.round(n) };
}

// 룰렛이 일반 명령어 모드일 때만 기본 명령어/커스텀 명령어 이름과의 충돌 검사
function checkRouletteChatNameConflict(name, excludeId) {
  if (RESERVED_NAMES.has(name)) return `'${name}'는 기본 제공 명령어 이름이라 사용할 수 없어요.`;
  if (commandStore.has(name)) return `'${name}'는 이미 등록된 유저 명령어예요.`;
  if (rouletteStore.hasNameConflict("chat", name, excludeId)) return `'${name}' 룰렛이 이미 있어요.`;
  return null;
}

// 룰렛 추가/수정 요청 공통 검증. 문제가 있으면 { error: "메시지" }, 통과하면 rouletteStore.add/update에
// 바로 넘길 수 있는 필드들을 반환. excludeId는 수정 시 자기 자신을 이름 충돌 검사에서 제외하기 위함.
function validateRouletteInput(body, excludeId) {
  const { name, mode, options, cooldownSec, userCooldownSec, donationAmount, allowChatAdd, spinStyle } = body || {};

  const key = normalizeRouletteName(name);
  if (!key) return { error: "이름을 입력해주세요." };

  const cleanOptions = sanitizeRouletteOptions(options);
  if (!cleanOptions) return { error: "결과를 한 줄 이상 입력해주세요." };
  if (!probabilitiesSumToHundred(cleanOptions)) {
    return { error: "결과 항목의 확률 합이 100%가 되도록 맞춰주세요." };
  }

  const rouletteMode = mode === "donation" ? "donation" : "chat";
  if (rouletteMode === "chat") {
    const conflict = checkRouletteChatNameConflict(key, excludeId);
    if (conflict) return { error: conflict };
  } else if (rouletteStore.hasNameConflict("donation", key, excludeId)) {
    return { error: `'${key}' 룰렛이 이미 있어요.` };
  }

  const amountResult = rouletteMode === "donation" ? sanitizeDonationAmount(donationAmount) : { ok: true, value: null };
  if (!amountResult.ok) return { error: "후원 금액은 0 이상의 숫자로 입력해주세요." };

  return {
    key,
    rouletteMode,
    cleanOptions,
    donationAmount: amountResult.value,
    cooldownSec: cooldownSec !== undefined ? sanitizeCooldown(cooldownSec) : undefined,
    userCooldownSec: userCooldownSec !== undefined ? sanitizeCooldown(userCooldownSec, 0) : undefined,
    allowChatAdd: !!allowChatAdd,
    spinStyle,
  };
}

// 관리 페이지에 표시할 앱 버전. 시작 시 한 번만 읽음.
let appVersion = "";
try {
  appVersion = require("../../package.json").version || "";
} catch (_err) {
  appVersion = "";
}

// 로그 확인 창은 같은 Electron 창으로 띄움. CLI 실행 시엔 Electron이 없어 사용 불가.
let electronMod = null;
try {
  electronMod = require("electron");
} catch (_err) {
  electronMod = null;
}
const isElectron = !!(electronMod && typeof electronMod === "object");
const BrowserWindow = isElectron ? electronMod.BrowserWindow : null;
let logWindow = null;

// 채널 프로필(이름/이미지) 캐시
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

  // 데이터 변경을 실시간으로 밀어주는 스트림. 대부분의 이벤트는 "무언가 바뀌었다"는 신호만
  // 담아 클라이언트가 해당 목록을 다시 조회하게 하고, roulette-spin처럼 그 자리에서 재조회할
  // 상태가 없는 1회성 이벤트는 payload에 실제 데이터를 함께 실어 보낸다.
  app.get("/api/events", (req, res) => {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    res.write("\n");

    const listeners = SSE_EVENTS.map((type) => {
      const handler = (payload) => res.write(`data: ${JSON.stringify({ type, payload })}\n\n`);
      eventBus.on(type, handler);
      return [type, handler];
    });

    // 프록시/브라우저의 유휴 연결 종료를 막기 위한 주기적 핑
    const heartbeat = setInterval(() => res.write(": ping\n\n"), SSE_HEARTBEAT_MS);
    if (heartbeat.unref) heartbeat.unref();

    req.on("close", () => {
      clearInterval(heartbeat);
      for (const [type, handler] of listeners) eventBus.off(type, handler);
    });
  });

  // ---- 시스템 명령어 (로직은 고정, 권한/쿨타임만 조정 가능) ----
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

  // 핑/업타임/명령어만 응답 문구 수정 가능. 나머지 시스템 명령어는 판정 로직이 고정이라 대상 아님
  app.patch(
    "/api/system-commands/:key/response",
    wrap((req, res) => {
      const { key } = req.params;
      if (!isSystemCommandEditable(key)) return fail(res, 400, "이 명령어는 응답을 수정할 수 없어요.");
      const { response } = req.body || {};
      const updated = systemCommandStore.setResponse(key, response);
      ok(res, { key, ...updated });
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
      const { name, response, permission, cooldownSec, userCooldownSec, listed, description, noPrefix } =
        req.body || {};
      if (!name || !name.trim()) return fail(res, 400, "명령어 이름을 입력해주세요.");
      if (!response || !response.trim()) return fail(res, 400, "응답 메시지를 입력해주세요.");

      const key = name.trim().replace(new RegExp(`^\\${config.commandPrefix}`), "");
      if (RESERVED_NAMES.has(key)) return fail(res, 400, `'${key}'는 기본 명령어 이름이라 사용할 수 없어요.`);
      if (commandStore.has(key)) return fail(res, 400, `'${key}' 명령어가 이미 있어요.`);
      if (rouletteStore.chatModeNames().includes(key)) {
        return fail(res, 400, `'${key}'는 룰렛 명령어로 이미 등록되어 있어 사용할 수 없어요.`);
      }

      const created = commandStore.add(key, response, {
        permission,
        cooldownSec: cooldownSec !== undefined ? sanitizeCooldown(cooldownSec) : undefined,
        userCooldownSec: userCooldownSec !== undefined ? sanitizeCooldown(userCooldownSec) : undefined,
        listed,
        description,
        noPrefix,
      });
      ok(res, { name: key, ...created });
    })
  );

  app.put(
    "/api/commands/:name",
    wrap((req, res) => {
      const { name } = req.params;
      const { response, permission, cooldownSec, userCooldownSec, listed, description, noPrefix } =
        req.body || {};

      if (!commandStore.has(name)) return fail(res, 404, `'${name}' 명령어를 찾을 수 없어요.`);

      if (response !== undefined) commandStore.update(name, response);
      commandStore.setMeta(name, {
        ...(permission !== undefined ? { permission } : {}),
        ...(cooldownSec !== undefined ? { cooldownSec: sanitizeCooldown(cooldownSec) } : {}),
        ...(userCooldownSec !== undefined ? { userCooldownSec: sanitizeCooldown(userCooldownSec) } : {}),
        ...(listed !== undefined ? { listed } : {}),
        ...(description !== undefined ? { description } : {}),
        ...(noPrefix !== undefined ? { noPrefix: !!noPrefix } : {}),
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

  // ---- 출석체크 ----
  app.get(
    "/api/attendance",
    wrap((req, res) => {
      ok(res, attendanceStore.all());
    })
  );

  app.get(
    "/api/attendance/:channelId",
    wrap((req, res) => {
      const record = attendanceStore.get(req.params.channelId);
      if (!record) return fail(res, 404, "해당 출석 기록을 찾을 수 없어요.");
      ok(res, record);
    })
  );

  app.delete(
    "/api/attendance/:channelId",
    wrap((req, res) => {
      const removed = attendanceStore.remove(req.params.channelId);
      if (!removed) return fail(res, 404, "해당 출석 기록을 찾을 수 없어요.");
      ok(res, { channelId: req.params.channelId });
    })
  );

  // 이미 출첵 기록이 있는 유저 전체에 한해, 특정 날짜를 일괄 출석/결석 처리
  app.post(
    "/api/attendance/bulk",
    wrap((req, res) => {
      const { date, attended } = req.body || {};
      const validDate = validateAttendanceDate(date);
      if (!validDate) return fail(res, 400, "날짜 형식이 올바르지 않거나 미래 날짜예요.");
      ok(res, attendanceStore.bulkSetAttendance(validDate, !!attended));
    })
  );

  // 특정 유저의 특정 날짜 출석 여부를 직접 켜고 끔
  app.post(
    "/api/attendance/:channelId/dates",
    wrap((req, res) => {
      const { date, attended } = req.body || {};
      const validDate = validateAttendanceDate(date);
      if (!validDate) return fail(res, 400, "날짜 형식이 올바르지 않거나 미래 날짜예요.");
      const updated = attendanceStore.setDateAttendance(req.params.channelId, validDate, !!attended);
      if (!updated) return fail(res, 404, "해당 출석 기록을 찾을 수 없어요.");
      ok(res, updated);
    })
  );

  // ---- 룰렛 ----
  app.get(
    "/api/roulette",
    wrap((req, res) => {
      ok(res, rouletteStore.all());
    })
  );

  app.post(
    "/api/roulette",
    wrap((req, res) => {
      const result = validateRouletteInput(req.body);
      if (result.error) return fail(res, 400, result.error);

      const created = rouletteStore.add(result.key, result.rouletteMode, result.cleanOptions, {
        cooldownSec: result.cooldownSec,
        userCooldownSec: result.userCooldownSec,
        donationAmount: result.donationAmount,
        allowChatAdd: result.allowChatAdd,
        spinStyle: result.spinStyle,
      });
      ok(res, created);
    })
  );

  app.put(
    "/api/roulette/:id",
    wrap((req, res) => {
      const { id } = req.params;
      if (!rouletteStore.get(id)) return fail(res, 404, "해당 룰렛을 찾을 수 없어요.");

      const result = validateRouletteInput(req.body, id);
      if (result.error) return fail(res, 400, result.error);

      const updated = rouletteStore.update(id, {
        name: result.key,
        mode: result.rouletteMode,
        options: result.cleanOptions,
        donationAmount: result.donationAmount,
        cooldownSec: result.cooldownSec,
        userCooldownSec: result.userCooldownSec,
        allowChatAdd: result.allowChatAdd,
        spinStyle: result.spinStyle,
      });
      ok(res, updated);
    })
  );

  app.patch(
    "/api/roulette/:id/enabled",
    wrap((req, res) => {
      const { enabled } = req.body || {};
      const updated = rouletteStore.setEnabled(req.params.id, !!enabled);
      if (!updated) return fail(res, 404, "해당 룰렛을 찾을 수 없어요.");
      ok(res, updated);
    })
  );

  app.delete(
    "/api/roulette/:id",
    wrap((req, res) => {
      const removed = rouletteStore.remove(req.params.id);
      if (!removed) return fail(res, 404, "해당 룰렛을 찾을 수 없어요.");
      ok(res, { id: req.params.id });
    })
  );

  // ---- 계정 연동 ----
  app.get(
    "/api/auth/status",
    wrap((req, res) => {
      ok(res, {
        clientId: config.clientId || "",
        hasClientSecret: !!config.clientSecret,
        channelId: config.channelId || "",
        redirectUri: config.redirectUriExplicit ? config.redirectUri || "" : "",
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
        // 빈 값이면(=화면에서 안 건드림) 기존 값 유지 — 마스킹된 값을 덮어쓰지 않도록
        config.clientSecret = String(clientSecret).trim();
        updates.CLIENT_SECRET = config.clientSecret;
      }
      if (channelId !== undefined) {
        config.channelId = String(channelId).trim();
        updates.CHANNEL_ID = config.channelId;
      }
      // Redirect URI에서 포트를 추출해 WEB_PORT도 함께 반영 (적용에는 재시작 필요)
      if (redirectUri !== undefined && String(redirectUri).trim() !== "") {
        const trimmed = String(redirectUri).trim();
        let parsed;
        try {
          parsed = new URL(trimmed);
        } catch (err) {
          return fail(res, 400, "Redirect URI 형식이 올바르지 않아요. http://localhost:포트/callback 형태여야 해요.");
        }
        if (trimmed !== config.redirectUri || !config.redirectUriExplicit) {
          redirectUriChanged = true;
          config.redirectUri = trimmed;
          config.redirectUriExplicit = true;
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
        redirectUri: config.redirectUriExplicit ? config.redirectUri || "" : "",
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

  // 인가 페이지 URL 발급
  app.get(
    "/api/oauth/authorize-url",
    wrap((req, res) => {
      ok(res, { url: oauthClient.buildAuthorizeUrl() });
    })
  );

  // 인가 페이지를 시스템 브라우저로 연다
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

  // 인가 완료 후 치지직이 code/state를 돌려주는 콜백. 여기서 토큰으로 교환.
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

  // 실제 토큰 값 조회. "값 보기" 버튼을 눌렀을 때만 호출됨 — 로그에 남기지 않음.
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

  // ---- 봇 연결/채팅 로그 ----
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

  // 로그 확인 창을 별도 Electron 창으로 연다
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

  // ---- 데이터 백업 ----
  // 유저 명령어/금칙어/시스템 명령어 설정/출석 기록/룰렛을 파일 하나로 내보내거나 불러온다.
  // 치지직 인가 토큰은 백업 대상에서 제외됨 (src/backup.js 참고).
  app.post(
    "/api/backup/export",
    wrap(async (req, res) => {
      if (!isElectron || !electronMod.dialog) {
        return fail(res, 400, "이 실행 환경(터미널)에서는 저장 위치 선택 창을 열 수 없어요. Electron 앱(npm start)에서 실행해주세요.");
      }
      const defaultName = `새벽봇_백업_${kst.dateString().replace(/-/g, "")}.json`;
      const result = await electronMod.dialog.showSaveDialog({
        title: "데이터 백업 저장",
        defaultPath: defaultName,
        filters: [{ name: "새벽봇 백업 파일", extensions: ["json"] }],
      });
      if (result.canceled || !result.filePath) return ok(res, { saved: false });

      backup.exportBackup(result.filePath);
      ok(res, { saved: true, path: result.filePath });
    })
  );

  app.post(
    "/api/backup/import",
    wrap(async (req, res) => {
      if (!isElectron || !electronMod.dialog) {
        return fail(res, 400, "이 실행 환경(터미널)에서는 파일 선택 창을 열 수 없어요. Electron 앱(npm start)에서 실행해주세요.");
      }
      const result = await electronMod.dialog.showOpenDialog({
        title: "백업 파일 불러오기",
        filters: [{ name: "새벽봇 백업 파일", extensions: ["json"] }],
        properties: ["openFile"],
      });
      if (result.canceled || !result.filePaths || !result.filePaths[0]) return ok(res, { restored: false });

      const restoredKeys = backup.importBackup(result.filePaths[0]);
      ok(res, { restored: true, keys: restoredKeys, path: result.filePaths[0] });
    })
  );

  // ---- 오버레이 (OBS 브라우저 소스) ----
  // /overlay.html은 정적 파일로 그대로 서빙됨. 스핀 스타일은 룰렛마다 따로 저장되고, 여기서는
  // 미리보기용 테스트 스핀만 처리. 포트는 위 계정 연동의 Redirect URI 저장 시 함께 반영됨.

  // 오버레이 미리보기용 테스트 스핀. 등록된 룰렛이 있으면 그중 하나를 무작위로, 없으면 예시 데이터로 재생
  app.post(
    "/api/overlay/test-spin",
    wrap((req, res) => {
      const enabledEntries = rouletteStore.all().filter((e) => e.enabled && (e.options || []).length);
      const sample = enabledEntries.length
        ? enabledEntries[Math.floor(Math.random() * enabledEntries.length)]
        : null;
      const options = sample
        ? sample.options
        : [
            { text: "점메추", probability: 25 },
            { text: "라면", probability: 25 },
            { text: "짜장면", probability: 25 },
            { text: "짬뽕", probability: 25 },
          ];
      const name = sample ? sample.name : "테스트";
      const style = sample ? sample.spinStyle || "wheel" : "wheel";
      const result = rouletteStore.pickOption({ options });

      eventBus.emit("roulette-spin", {
        id: sample ? sample.id : "test",
        name,
        mode: sample ? sample.mode : "chat",
        options,
        result,
        style,
      });
      ok(res, { triggered: true, name, result, style });
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
  // 127.0.0.1에만 바인딩 — 같은 컴퓨터에서만 접속 가능
  const server = app.listen(config.webPort, "127.0.0.1", () => {
    console.log(`[web] 관리 페이지: http://localhost:${config.webPort} (이 컴퓨터에서만 접속 가능)`);
  });
  server.on("error", (err) => {
    console.error("[web] 관리 페이지 서버를 시작하지 못했습니다:", err.message);
  });
  return server;
}

module.exports = { startWebServer, createApp };
