"use strict";

const config = require("../config");
const official = require("../official/chzzkOfficial");
const store = require("../commandStore");
const attendanceStore = require("../attendanceStore");
const rouletteStore = require("../rouletteStore");
const eventBus = require("../eventBus");
const { cooldown, permissions, template: templateUtil } = require("../utils");
const { hasPermission } = permissions;
const { render, pickRandom } = templateUtil;
const chat = require("../chatSender");
const moderation = require("../moderation");
const {
  getEffectivePermission,
  getEffectiveCooldownSec,
  getEffectiveEnabled,
  getEffectiveResponse,
} = require("../web/systemCommands");

const DEBUG = process.env.DEBUG === "1";

// 커스텀 명령어로 덮어쓸 수 없는 기본 제공 명령어 이름
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
  "출첵",
  "목록추가",
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

// {업타임} 자리에 경과 시간(또는 방송중 아님 문구)을 채워 대시보드에서 수정한 응답 문구를 완성
function applyUptimeTemplate(elapsedText) {
  const template = getEffectiveResponse("업타임");
  return template.replace(/\{업타임\}/g, elapsedText);
}

async function handleUptime() {
  try {
    const detail = await official.getLiveDetail(config.channelId);

    if (DEBUG) console.log("[debug] live.detail 응답:", JSON.stringify(detail).slice(0, 2000));

    if (!detail || detail.status !== "OPEN") {
      return applyUptimeTemplate("[방송중이 아님]");
    }

    const openDateRaw = detail.openDate;
    if (!openDateRaw) {
      return "방송 중이지만 시작 시각 정보를 API 응답에서 찾지 못했어요. (DEBUG=1로 실행해 응답 구조를 확인해주세요)";
    }

    // "YYYY-MM-DD HH:mm:ss" 형태를 KST로 간주하고 파싱
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
    return applyUptimeTemplate(`${h}시간 ${m}분 ${s}초`);
  } catch (err) {
    console.error("[commands] 업타임 조회 실패:", err.message);
    return "업타임 정보를 가져오는 중 오류가 발생했어요.";
  }
}

async function isChannelLive() {
  try {
    const detail = await official.getLiveDetail(config.channelId);
    return !!(detail && detail.status === "OPEN");
  } catch (err) {
    console.error("[commands] 방송 상태 확인 실패:", err.message);
    return false;
  }
}

// 유저 명령어 응답 실행 (! 있는 명령어와 ! 없이 반응하는 명령어가 공통으로 사용)
async function runCustomCommand(name, custom, ctx) {
  if (!hasPermission(ctx.userRoleCode, custom.permission)) return;
  if (cooldown.isOnCooldown(name, ctx.userId, custom.cooldownSec, custom.userCooldownSec)) return;

  cooldown.markUsed(name, ctx.userId);

  const template = pickRandom(custom.responses);
  return chat.say(render(template, ctx));
}

// 시스템 명령어 전체 쿨타임 체크 (대시보드 설정값 반영)
function checkSystemCooldown(key, userId) {
  const sec = getEffectiveCooldownSec(key);
  if (sec <= 0) return false;
  if (cooldown.isOnCooldown(key, userId, sec, 0)) return true;
  cooldown.markUsed(key, userId);
  return false;
}

const SYSTEM_COMMAND_KEYS = ["핑", "업타임", "명령어", "출첵", "추가", "수정", "제거", "목록추가"];

function listCommands() {
  const names = Object.entries(store.all())
    .filter(([, cmd]) => cmd.enabled && cmd.listed)
    .map(([name]) => `${config.commandPrefix}${name}`);

  // 목록에는 활성화 + 권한이 everyone인 명령어만 표시
  const builtins = SYSTEM_COMMAND_KEYS.filter(
    (key) => getEffectiveEnabled(key) && getEffectivePermission(key) === "everyone"
  ).map((key) => `${config.commandPrefix}${key}`);
  const all = [...builtins, ...names];
  return getEffectiveResponse("명령어").replace(/\{목록\}/g, all.join(", "));
}

async function handleChatMessage(evt) {
  const content = (evt.content || "").trim();

  const moderated = await moderation.checkAndModerate(evt).catch((err) => {
    console.error("[commands] 금칙어 검사 실패:", err.message);
    return false;
  });
  if (moderated) return; // 제재된 메시지는 명령어로 처리하지 않음

  const nickname = (evt.profile && evt.profile.nickname) || "익명";
  const userId = evt.senderChannelId || nickname;
  const userRoleCode = evt.userRoleCode;

  const parsed = parseMessage(content);
  if (!parsed) {
    // ! 없이 반응하도록 설정된 유저 명령어. 메시지 전체가 명령어 이름과 정확히 일치할 때만 반응
    const noPrefixCmd = store.get(content);
    if (noPrefixCmd && noPrefixCmd.enabled && noPrefixCmd.noPrefix) {
      return runCustomCommand(content, noPrefixCmd, { nickname, userId, userRoleCode, args: "" });
    }
    return;
  }

  const { name, rest } = parsed;
  const ctx = { nickname, userId, userRoleCode, args: rest };

  if (DEBUG) console.log(`[chat] ${nickname}(${userRoleCode}): ${content}`);

  // ---- 관리 명령어 (기본 매니저 이상, 대시보드에서 권한 조정 가능) ----
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
    if (rouletteStore.chatModeNames().includes(cmdName)) {
      return chat.say(`'${cmdName}' 은(는) 룰렛 명령어로 이미 등록되어 있어 사용할 수 없어요.`);
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

  // ---- 룰렛 결과 항목 채팅 추가 (해당 룰렛에서 "채팅으로 항목 추가 허용"을 켠 경우만) ----
  if (name === "목록추가" && rest) {
    if (!getEffectiveEnabled("목록추가")) return;
    if (!hasPermission(userRoleCode, getEffectivePermission("목록추가"))) return;
    if (checkSystemCooldown("목록추가", userId)) return;

    const spaceIdx = rest.indexOf(" ");
    if (spaceIdx === -1) return chat.say("사용법: !목록추가 [룰렛이름] [추가할 문구]");
    let rouletteName = rest.slice(0, spaceIdx).trim();
    const optionText = rest.slice(spaceIdx + 1).trim();
    if (rouletteName.startsWith(config.commandPrefix)) rouletteName = rouletteName.slice(config.commandPrefix.length);
    if (!rouletteName || !optionText) return chat.say("사용법: !목록추가 [룰렛이름] [추가할 문구]");

    const target = rouletteStore.findByName(rouletteName);
    if (!target) return chat.say(`'${rouletteName}' 룰렛을 찾을 수 없어요.`);
    if (!target.allowChatAdd) return chat.say(`'${rouletteName}' 룰렛은 채팅으로 항목을 추가할 수 없어요.`);

    const updated = rouletteStore.addChatOption(target.id, optionText);
    if (!updated) return chat.say("항목 추가에 실패했어요.");
    const added = updated.options[updated.options.length - 1];
    const addedProbability = added ? added.probability : 0;
    return chat.say(
      `'${rouletteName}' 룰렛에 '${optionText}' 항목을 추가했어요. (총 ${updated.options.length}개, 이번 항목 확률 ${addedProbability}%)`
    );
  }

  // ---- 기본 제공 명령어 (기본 everyone, 대시보드에서 권한 조정 가능) ----
  if (name === "핑") {
    if (!getEffectiveEnabled("핑")) return;
    if (!hasPermission(userRoleCode, getEffectivePermission("핑"))) return;
    if (checkSystemCooldown("핑", userId)) return;
    return chat.say(getEffectiveResponse("핑"));
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

  if (name === "출첵") {
    if (!getEffectiveEnabled("출첵")) return;
    if (!hasPermission(userRoleCode, getEffectivePermission("출첵"))) return;
    if (checkSystemCooldown("출첵", userId)) return;

    if (!(await isChannelLive())) {
      return chat.say("방송 중에만 출석체크할 수 있어요.");
    }

    const { alreadyChecked, record } = attendanceStore.checkIn(userId, nickname);
    if (alreadyChecked) {
      return chat.say(`${nickname}님은 오늘 이미 출석하셨어요.`);
    }
    attendanceStore.refreshProfileImage(userId).catch(() => {});
    return chat.say(
      `${nickname}님 출석체크 완료! 연속 ${record.currentStreak}일째, 총 ${record.totalCount}회 출석이에요.`
    );
  }

  // ---- 룰렛 (일반 명령어 모드, 이름이 정확히 일치할 때만 반응) ----
  const rouletteChat = rouletteStore.findMatch("chat", name);
  if (rouletteChat) {
    const cooldownKey = `roulette:${rouletteChat.id}`;
    if (cooldown.isOnCooldown(cooldownKey, userId, rouletteChat.cooldownSec, rouletteChat.userCooldownSec)) return;

    cooldown.markUsed(cooldownKey, userId);

    const template = rouletteStore.pickOption(rouletteChat);
    eventBus.emit("roulette-spin", {
      id: rouletteChat.id,
      name: rouletteChat.name,
      mode: rouletteChat.mode,
      options: rouletteChat.options,
      result: template,
      style: rouletteChat.spinStyle || "wheel",
    });
    return chat.say(render(template, ctx));
  }

  // ---- 커스텀 명령어 ----
  const custom = store.get(name);
  if (custom && custom.enabled) {
    return runCustomCommand(name, custom, ctx);
  }
}

// 후원 이벤트 처리. 후원 문구(donationText)가 등록된 룰렛 이름과 정확히 일치할 때만 반응 (! 없음)
// donationAmount가 지정된 룰렛은 후원 금액까지 정확히 일치해야 반응하고, 지정 안 됐으면 금액 상관없이 반응
async function handleDonation(evt) {
  const text = (evt.donationText || "").trim();
  if (!text) return;

  const entry = rouletteStore.findMatch("donation", text);
  if (!entry) return;

  if (entry.donationAmount !== null && entry.donationAmount !== undefined) {
    const paidAmount = Number(evt.payAmount);
    if (!Number.isFinite(paidAmount) || paidAmount !== entry.donationAmount) return;
  }

  const nickname = evt.donatorNickname || "익명";
  const userId = evt.donatorChannelId || nickname;

  const cooldownKey = `roulette:${entry.id}`;
  if (cooldown.isOnCooldown(cooldownKey, userId, entry.cooldownSec, entry.userCooldownSec)) return;

  cooldown.markUsed(cooldownKey, userId);

  const template = rouletteStore.pickOption(entry);
  eventBus.emit("roulette-spin", {
    id: entry.id,
    name: entry.name,
    mode: entry.mode,
    options: entry.options,
    result: template,
    style: entry.spinStyle || "wheel",
  });
  return chat.say(render(template, { nickname }));
}

module.exports = { handleChatMessage, handleDonation, parseMessage, RESERVED_NAMES };
