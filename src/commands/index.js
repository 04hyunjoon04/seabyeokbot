"use strict";

const config = require("../config");
const official = require("../official/chzzkOfficial");
const store = require("../commandStore");
const { cooldown, permissions, template: templateUtil } = require("../utils");
const { hasPermission } = permissions;
const { render, pickRandom } = templateUtil;
const chat = require("../chatSender");
const moderation = require("../moderation");
const {
  getEffectivePermission,
  getEffectiveCooldownSec,
  getEffectiveEnabled,
} = require("../web/systemCommands");

const DEBUG = process.env.DEBUG === "1";

// 관리용 기본 제공 명령어 이름 (커스텀 명령어로 덮어쓸 수 없음)
const RESERVED_NAMES = new Set([
  "추가",
  "등록",
  "수정",
  "편집",
  "변경",
  "제거",
  "삭제",
  "명령어",
  "업타임",
  "핑",
]);

function parseMessage(content) {
  const prefix = config.commandPrefix;
  if (!content || !content.startsWith(prefix)) return null;

  const withoutPrefix = content.slice(prefix.length);
  const spaceIdx = withoutPrefix.indexOf(" ");
  const name = spaceIdx === -1 ? withoutPrefix : withoutPrefix.slice(0, spaceIdx);
  const rest = spaceIdx === -1 ? "" : withoutPrefix.slice(spaceIdx + 1).trim();

  if (!name) return null;
  return { name: name.trim(), rest };
}

async function handleUptime() {
  try {
    const detail = await official.getLiveDetail(config.channelId);

    if (DEBUG) console.log("[debug] live.detail 응답:", JSON.stringify(detail).slice(0, 2000));

    if (!detail || detail.status !== "OPEN") {
      return "업타임: [방송중이 아님]";
    }

    const openDateRaw = detail.openDate;
    if (!openDateRaw) {
      return "방송 중이지만 시작 시각 정보를 API 응답에서 찾지 못했어요. (DEBUG=1로 실행해 응답 구조를 확인해주세요)";
    }

    // "YYYY-MM-DD HH:mm:ss" 형태(치지직 응답에서 흔히 쓰는 포맷)를 KST로 간주하고 파싱
    const isoish = openDateRaw.includes("T")
      ? openDateRaw
      : `${openDateRaw.replace(" ", "T")}+09:00`;
    const openedAt = new Date(isoish);
    if (Number.isNaN(openedAt.getTime())) {
      return `업타임 계산에 실패했어요. (openDate=${openDateRaw})`;
    }

    const diffSec = Math.max(0, Math.floor((Date.now() - openedAt.getTime()) / 1000));
    const h = Math.floor(diffSec / 3600);
    const m = Math.floor((diffSec % 3600) / 60);
    const s = diffSec % 60;
    return `업타임: ${h}시간 ${m}분 ${s}초`;
  } catch (err) {
    console.error("[commands] 업타임 조회 실패:", err.message);
    return "업타임 정보를 가져오는 중 오류가 발생했어요.";
  }
}

// 시스템 명령어용 쿨타임 체크 (전체 쿨타임만 사용, 대시보드에서 조정한 값 반영)
function checkSystemCooldown(key, userId) {
  const sec = getEffectiveCooldownSec(key);
  if (sec <= 0) return false;
  if (cooldown.isOnCooldown(key, userId, sec, 0)) return true;
  cooldown.markUsed(key, userId);
  return false;
}

// 관리 명령어(추가/수정/제거)도 대시보드에서 "시청자(누구나)"로 권한을 낮출 수 있으니
// !명령어 목록에서도 항상 빠지지 않고 반영되도록 시스템 명령어 전체를 대상으로 함.
const SYSTEM_COMMAND_KEYS = ["핑", "업타임", "명령어", "추가", "수정", "제거"];

function listCommands() {
  const names = Object.entries(store.all())
    .filter(([, cmd]) => cmd.enabled && cmd.listed)
    .map(([name]) => `${config.commandPrefix}${name}`);

  // 목록에는 "지금 누구나 쓸 수 있는" 명령어만 보여줌 — 매니저 이상으로 제한된 명령어까지
  // 시청자 전체에게 노출하면 오히려 혼란스러우니, 활성화 + 권한이 "시청자(누구나)"인 것만.
  const builtins = SYSTEM_COMMAND_KEYS.filter(
    (key) => getEffectiveEnabled(key) && getEffectivePermission(key) === "everyone"
  ).map((key) => `${config.commandPrefix}${key}`);
  const all = [...builtins, ...names];
  return `명령어: ${all.join(", ")}`;
}

async function handleChatMessage(evt) {
  const content = (evt.content || "").trim();

  const moderated = await moderation.checkAndModerate(evt).catch((err) => {
    console.error("[commands] 금칙어 검사 실패:", err.message);
    return false;
  });
  if (moderated) return; // 제재된 메시지는 명령어로 처리하지 않음

  const parsed = parseMessage(content);
  if (!parsed) return;

  const { name, rest } = parsed;
  const nickname = (evt.profile && evt.profile.nickname) || "익명";
  const userId = evt.senderChannelId || nickname;
  const userRoleCode = evt.userRoleCode;

  const ctx = { nickname, userId, userRoleCode, args: rest };

  if (DEBUG) console.log(`[chat] ${nickname}(${userRoleCode}): ${content}`);

  // ---- 관리 명령어 (기본은 매니저 이상, 대시보드에서 권한 조정 가능) ----
  if ((name === "추가" || name === "등록") && rest) {
    if (!getEffectiveEnabled("추가")) return;
    if (!hasPermission(userRoleCode, getEffectivePermission("추가"))) return;
    if (checkSystemCooldown("추가", userId)) return;
    const spaceIdx = rest.indexOf(" ");
    if (spaceIdx === -1) return chat.say("사용법: !추가 [명령어] [응답 메시지]");
    let cmdName = rest.slice(0, spaceIdx).trim();
    const body = rest.slice(spaceIdx + 1).trim();
    if (!cmdName || !body) return chat.say("사용법: !추가 [명령어] [응답 메시지]");
    if (cmdName.startsWith(config.commandPrefix)) cmdName = cmdName.slice(config.commandPrefix.length);

    if (RESERVED_NAMES.has(cmdName)) {
      return chat.say(`'${cmdName}' 은(는) 기본 제공 명령어라 덮어쓸 수 없어요.`);
    }
    store.add(cmdName, body);
    return chat.say(`'${config.commandPrefix}${cmdName}' 명령어가 추가되었습니다.`);
  }

  if ((name === "수정" || name === "편집" || name === "변경") && rest) {
    if (!getEffectiveEnabled("수정")) return;
    if (!hasPermission(userRoleCode, getEffectivePermission("수정"))) return;
    if (checkSystemCooldown("수정", userId)) return;
    const spaceIdx = rest.indexOf(" ");
    if (spaceIdx === -1) return chat.say("사용법: !수정 [명령어] [새 응답 메시지]");
    let cmdName = rest.slice(0, spaceIdx).trim();
    const body = rest.slice(spaceIdx + 1).trim();
    if (cmdName.startsWith(config.commandPrefix)) cmdName = cmdName.slice(config.commandPrefix.length);

    if (!store.has(cmdName)) return chat.say(`'${cmdName}' 명령어를 찾을 수 없어요.`);
    store.update(cmdName, body);
    return chat.say(`'${config.commandPrefix}${cmdName}' 명령어가 수정되었습니다.`);
  }

  if ((name === "제거" || name === "삭제") && rest) {
    if (!getEffectiveEnabled("제거")) return;
    if (!hasPermission(userRoleCode, getEffectivePermission("제거"))) return;
    if (checkSystemCooldown("제거", userId)) return;
    let cmdName = rest.trim();
    if (cmdName.startsWith(config.commandPrefix)) cmdName = cmdName.slice(config.commandPrefix.length);

    const removed = store.remove(cmdName);
    return chat.say(
      removed ? `'${config.commandPrefix}${cmdName}' 명령어가 제거되었습니다.` : `'${cmdName}' 명령어를 찾을 수 없어요.`
    );
  }

  // ---- 기본 제공 명령어 (기본은 everyone, 대시보드에서 권한 조정 가능) ----
  if (name === "핑") {
    if (!getEffectiveEnabled("핑")) return;
    if (!hasPermission(userRoleCode, getEffectivePermission("핑"))) return;
    if (checkSystemCooldown("핑", userId)) return;
    return chat.say("퐁! 봇이 정상적으로 동작하고 있어요 :>");
  }

  if (name === "명령어") {
    if (!getEffectiveEnabled("명령어")) return;
    if (!hasPermission(userRoleCode, getEffectivePermission("명령어"))) return;
    if (checkSystemCooldown("명령어", userId)) return;
    return chat.say(listCommands());
  }

  if (name === "업타임") {
    if (!getEffectiveEnabled("업타임")) return;
    if (!hasPermission(userRoleCode, getEffectivePermission("업타임"))) return;
    if (checkSystemCooldown("업타임", userId)) return;
    return chat.say(await handleUptime());
  }

  // ---- 커스텀 명령어 ----
  const custom = store.get(name);
  if (custom && custom.enabled) {
    if (!hasPermission(userRoleCode, custom.permission)) return;
    if (cooldown.isOnCooldown(name, userId, custom.cooldownSec, custom.userCooldownSec)) return;

    cooldown.markUsed(name, userId);
    store.incrementUses(name);

    const template = pickRandom(custom.responses);
    return chat.say(render(template, ctx));
  }
}

module.exports = { handleChatMessage, parseMessage };
