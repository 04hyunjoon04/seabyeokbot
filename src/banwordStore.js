"use strict";

// 금칙어 목록을 data/banwords.json에 저장/조회/수정하는 저장소. action: "blind" | "timeout" (영구 차단 미지원).

const fs = require("fs");
const crypto = require("crypto");
const config = require("./config");
const { atomicWriteJson } = require("./utils");
const eventBus = require("./eventBus");

let words = []; // [{ id, word, action, enabled, _wordLower }]

// 채팅 메시지마다 검사하므로 소문자 변환은 로드/추가 시 한 번만 캐시.
function withLowerCache(entry) {
  entry._wordLower = String(entry.word || "").toLowerCase();
  return entry;
}

function load() {
  try {
    const text = fs.readFileSync(config.banwordsFilePath, "utf8");
    words = JSON.parse(text).map(withLowerCache);
  } catch (err) {
    words = [];
    if (err.code === "ENOENT") return; // 파일 없음 (최초 실행)

    // 파일 손상 시 백업 후 빈 목록으로 시작
    console.error("[banwordStore] banwords.json 파싱 실패, 빈 목록으로 시작합니다:", err.message);
    try {
      fs.copyFileSync(config.banwordsFilePath, `${config.banwordsFilePath}.corrupted-${Date.now()}.bak`);
    } catch (backupErr) {
      console.error("[banwordStore] 손상된 파일 백업 실패:", backupErr.message);
    }
  }
}

function save() {
  // _wordLower는 메모리 캐시용이라 파일에는 저장하지 않음
  atomicWriteJson(config.banwordsFilePath, words.map(stripInternal));
  eventBus.emit("banwords");
}

function stripInternal(entry) {
  const { _wordLower, ...rest } = entry;
  return rest;
}

function all() {
  return words.map(stripInternal);
}

function add(word, action = "blind") {
  const entry = withLowerCache({
    id: crypto.randomBytes(6).toString("hex"),
    word: String(word).trim(),
    action: action === "timeout" ? "timeout" : "blind",
    enabled: true,
  });
  words.push(entry);
  save();
  return stripInternal(entry);
}

function remove(id) {
  const before = words.length;
  words = words.filter((w) => w.id !== id);
  save();
  return words.length < before;
}

function setEnabled(id, enabled) {
  const entry = words.find((w) => w.id === id);
  if (!entry) return null;
  entry.enabled = enabled;
  save();
  return stripInternal(entry);
}

// 메시지에 활성화된 금칙어가 포함되면 해당 항목 반환 (부분 일치, 대소문자 무시)
function findMatch(content) {
  if (!content) return null;
  const lower = content.toLowerCase();
  return words.find((w) => w.enabled && w._wordLower && lower.includes(w._wordLower)) || null;
}

load();

module.exports = { load, all, add, remove, setEnabled, findMatch };
