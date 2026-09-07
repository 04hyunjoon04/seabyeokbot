"use strict";

// 예전에 cooldown.js / permissions.js / template.js / botLog.js로 나뉘어 있던,
// 서로 기능은 다르지만 각각 1KB 안팎으로 아주 작았던 유틸리티들을 파일 수를 줄이기
// 위해 한 파일로 모았어요. 동작은 전혀 안 바뀌었고, utils.cooldown / utils.permissions /
// utils.template / utils.botLog 로 이름만 묶어서 씀.

// ---- cooldown: 명령어별 전체 쿨타임 + 유저별 쿨타임을 메모리에서 관리 (프로세스 재시작하면 초기화됨) ----
const lastGlobalUse = new Map(); // commandName -> timestamp(ms)
const lastUserUse = new Map(); // `${commandName}:${userId}` -> timestamp(ms)

function isOnCooldown(commandName, userId, cooldownSec, userCooldownSec) {
  const now = Date.now();

  const globalLast = lastGlobalUse.get(commandName) || 0;
  if (cooldownSec && now - globalLast < cooldownSec * 1000) {
    return true;
  }

  const userKey = `${commandName}:${userId}`;
  const userLast = lastUserUse.get(userKey) || 0;
  if (userCooldownSec && now - userLast < userCooldownSec * 1000) {
    return true;
  }

  return false;
}

function markUsed(commandName, userId) {
  const now = Date.now();
  lastGlobalUse.set(commandName, now);
  lastUserUse.set(`${commandName}:${userId}`, now);
}

const cooldown = { isOnCooldown, markUsed };

// ---- permissions: 치지직 Open API 채팅 이벤트의 userRoleCode 값을 등급으로 매핑 ----
// (실제 값은 문서상 streamer / streaming_channel_manager / streaming_chat_manager / common_user 로 확인됨)
const LEVELS = {
  everyone: 0,
  manager: 1, // 채팅 관리자 / 채널 관리자 (치지직 자체 매니저 권한을 가진 사람)
  streamer: 2, // 채널 주인
};

function levelOf(userRoleCode) {
  switch (userRoleCode) {
    case "streamer":
      return LEVELS.streamer;
    case "streaming_channel_manager":
    case "streaming_chat_manager":
    case "manager":
      return LEVELS.manager;
    default:
      return LEVELS.everyone;
  }
}

function hasPermission(userRoleCode, required) {
  const requiredLevel = LEVELS[required] ?? LEVELS.everyone;
  return levelOf(userRoleCode) >= requiredLevel;
}

const permissions = { LEVELS, levelOf, hasPermission };

// ---- template: 아주 단순한 변수 치환기. $nick / $name 정도만 우선 지원 ----
// (뚜봇처럼 $follow_check, $att_add 같은 고급 변수는 추후 필요할 때 추가)
function render(text, ctx) {
  return text
    .replace(/\$nick\b/g, ctx.nickname || "")
    .replace(/\$name\b/g, ctx.nickname || "");
}

function pickRandom(list) {
  if (!Array.isArray(list) || list.length === 0) return "";
  return list[Math.floor(Math.random() * list.length)];
}

const template = { render, pickRandom };

// ---- botLog: 봇 연결/채팅 관련 로그를 메모리에 잠깐 모아뒀다가 대시보드("봇 연결 상태"
// 카드)에서 터미널처럼 보여주기 위한 모듈. 콘솔에는 기존처럼 그대로 출력하면서, 동시에
// 최근 로그 N개를 링 버퍼에 저장해서 /api/bot/logs 로 조회할 수 있게 함. ----
const MAX_LOG_ENTRIES = 300;
const logEntries = [];

function pushLog(level, message) {
  logEntries.push({ time: Date.now(), level, message: String(message) });
  if (logEntries.length > MAX_LOG_ENTRIES) logEntries.shift();
}

function logInfo(message) {
  pushLog("info", message);
  console.log(message);
}

function logWarn(message) {
  pushLog("warn", message);
  console.warn(message);
}

function logError(message) {
  pushLog("error", message);
  console.error(message);
}

function getAllLogs() {
  return logEntries.slice();
}

function clearLogs() {
  logEntries.length = 0;
}

const botLog = { log: logInfo, warn: logWarn, error: logError, getAll: getAllLogs, clear: clearLogs };

module.exports = { cooldown, permissions, template, botLog };
