"use strict";

// cooldown / permissions / template / botLog / atomicWriteJson 유틸리티 모음. utils.cooldown 등으로 사용.

const fs = require("fs");

// ---- atomicWriteJson: 임시 파일에 쓴 뒤 교체해 저장 중 강제종료로 인한 파일 손상 방지 ----
function atomicWriteJson(filePath, data) {
  const tmpPath = `${filePath}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2), "utf8");
  fs.renameSync(tmpPath, filePath);
}

// ---- cooldown: 명령어별 전체 쿨타임 + 유저별 쿨타임을 메모리에서 관리 (프로세스 재시작 시 초기화) ----
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

// ---- permissions: 치지직 Open API 채팅 이벤트의 userRoleCode를 권한 등급으로 매핑 ----
const LEVELS = {
  everyone: 0,
  manager: 1, // 채팅 관리자 / 채널 관리자
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

// ---- template: 변수 치환기. $nick / $name 지원 ----
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

// ---- botLog: 콘솔 출력과 함께 최근 로그를 링 버퍼에 저장. /api/bot/logs로 조회. ----
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

module.exports = { cooldown, permissions, template, botLog, atomicWriteJson };
