"use strict";

// 시스템(내장) 명령어의 "필요 권한"/"쿨타임"만 사용자가 바꿀 수 있게 해주는 저장소.
// 명령어 자체(응답 로직)는 코드에 고정돼 있지만, 권한 등급과 쿨타임만 여기 오버라이드로 조정 가능.
// data/systemCommandOverrides.json 에 { [key]: { permission, cooldownSec } } 형태로 저장됨.

const fs = require("fs");
const config = require("./config");

const VALID_PERMISSIONS = new Set(["everyone", "manager", "streamer"]);

let overrides = {};

function load() {
  try {
    const text = fs.readFileSync(config.systemCommandOverridesFilePath, "utf8");
    overrides = JSON.parse(text);
  } catch (err) {
    overrides = {};
    if (err.code === "ENOENT") return; // 아직 파일이 없는 최초 실행 — 정상 상황

    // 파일은 있는데 내용이 깨져서 못 읽는 경우. 빈 값으로 시작하면 다음 저장 때 기존
    // 설정이 통째로 사라지니, 원본을 백업해두고 빈 값(=전부 기본값)으로 시작함.
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
  fs.writeFileSync(
    config.systemCommandOverridesFilePath,
    JSON.stringify(overrides, null, 2),
    "utf8"
  );
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
  getPermission,
  setPermission,
  getCooldownSec,
  setCooldownSec,
  getEnabled,
  setEnabled,
};
