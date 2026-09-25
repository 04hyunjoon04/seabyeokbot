"use strict";

// 시스템(내장) 명령어의 "필요 권한"/"쿨타임"/"활성화"/"응답 문구" 오버라이드 저장소. 명령어 판정 로직 자체는 코드에 고정.
// data/systemCommandOverrides.json 에 { [key]: { permission, cooldownSec, enabled, response } } 형태로 저장.
// response는 일부 명령어(핑/업타임/명령어)만 사용, 나머지는 무시됨.

const fs = require("fs");
const config = require("./config");
const { atomicWriteJson } = require("./utils");
const eventBus = require("./eventBus");

const VALID_PERMISSIONS = new Set(["everyone", "manager", "streamer"]);

let overrides = {};

function load() {
  try {
    const text = fs.readFileSync(config.systemCommandOverridesFilePath, "utf8");
    overrides = JSON.parse(text);
  } catch (err) {
    overrides = {};
    if (err.code === "ENOENT") return; // 파일 없음 (최초 실행)

    // 파일 손상 시 백업 후 기본값으로 시작
    console.error(
      "[systemCommandStore] systemCommandOverrides.json 파싱 실패, 기본값으로 시작합니다:",
      err.message
    );
    try {
      fs.copyFileSync(
        config.systemCommandOverridesFilePath,
        `${config.systemCommandOverridesFilePath}.corrupted-${Date.now()}.bak`
      );
    } catch (backupErr) {
      console.error("[systemCommandStore] 손상된 파일 백업 실패:", backupErr.message);
    }
  }
}

function save() {
  atomicWriteJson(config.systemCommandOverridesFilePath, overrides);
  eventBus.emit("system-commands");
}

function getPermission(key, defaultPermission) {
  const entry = overrides[key];
  return (entry && entry.permission) || defaultPermission;
}

function setPermission(key, permission) {
  if (!VALID_PERMISSIONS.has(permission)) return null;
  overrides[key] = { ...(overrides[key] || {}), permission };
  save();
  return overrides[key];
}

function getCooldownSec(key, defaultCooldownSec) {
  const entry = overrides[key];
  return entry && entry.cooldownSec !== undefined ? entry.cooldownSec : defaultCooldownSec;
}

function setCooldownSec(key, cooldownSec) {
  const n = Number(cooldownSec);
  if (!Number.isFinite(n) || n < 0) return null;
  overrides[key] = { ...(overrides[key] || {}), cooldownSec: Math.floor(n) };
  save();
  return overrides[key];
}

function getResponse(key, defaultResponse) {
  const entry = overrides[key];
  const custom = entry && entry.response;
  return custom ? custom : defaultResponse;
}

function setResponse(key, response) {
  overrides[key] = { ...(overrides[key] || {}), response: String(response ?? "").trim() };
  save();
  return overrides[key];
}

function getEnabled(key, defaultEnabled) {
  const entry = overrides[key];
  return entry && entry.enabled !== undefined ? entry.enabled : defaultEnabled;
}

function setEnabled(key, enabled) {
  overrides[key] = { ...(overrides[key] || {}), enabled: !!enabled };
  save();
  return overrides[key];
}

load();

module.exports = {
  load,
  getPermission,
  setPermission,
  getCooldownSec,
  setCooldownSec,
  getResponse,
  setResponse,
  getEnabled,
  setEnabled,
};
