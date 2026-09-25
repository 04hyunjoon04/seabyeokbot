"use strict";

// 유저 명령어/금칙어/시스템 명령어 설정/출석 기록/룰렛(오버레이 스핀 스타일 포함)을 파일 하나로
// 내보내고 불러오는 기능. 치지직 인가 토큰(officialAuth.json)은 유출 위험이 있어 대상에서 제외.

const fs = require("fs");
const config = require("./config");
const { atomicWriteJson } = require("./utils");
const eventBus = require("./eventBus");
const commandStore = require("./commandStore");
const banwordStore = require("./banwordStore");
const systemCommandStore = require("./systemCommandStore");
const attendanceStore = require("./attendanceStore");
const rouletteStore = require("./rouletteStore");

let appVersion = "";
try {
  appVersion = require("../package.json").version || "";
} catch (_err) {
  appVersion = "";
}

// 백업 대상 항목. path는 원본 파일 위치, fallback은 파일이 없을 때 쓸 빈 값,
// store는 복원 후 메모리에 다시 불러올 저장소, event는 복원 후 대시보드에 알릴 SSE 이벤트명.
const DATA_FILES = {
  commands: { path: config.commandsFilePath, fallback: {}, store: commandStore, event: "commands" },
  banwords: { path: config.banwordsFilePath, fallback: [], store: banwordStore, event: "banwords" },
  systemCommandOverrides: {
    path: config.systemCommandOverridesFilePath,
    fallback: {},
    store: systemCommandStore,
    event: "system-commands",
  },
  attendance: {
    path: config.attendanceFilePath,
    fallback: { broadcastDates: [], records: {} },
    store: attendanceStore,
    event: "attendance",
  },
  roulette: { path: config.rouletteFilePath, fallback: [], store: rouletteStore, event: "roulette" },
};

function readJsonSafe(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (err) {
    return fallback;
  }
}

// destPath에 현재 데이터 전체를 하나의 JSON 파일로 저장
function exportBackup(destPath) {
  const data = {};
  for (const [key, meta] of Object.entries(DATA_FILES)) {
    data[key] = readJsonSafe(meta.path, meta.fallback);
  }
  const bundle = {
    app: "saebyeokbot",
    exportedAt: new Date().toISOString(),
    appVersion,
    data,
  };
  fs.writeFileSync(destPath, JSON.stringify(bundle, null, 2), "utf8");
  return bundle;
}

// srcPath의 백업 파일 내용으로 현재 데이터를 덮어씀. 복원된 항목 키 배열을 반환
function importBackup(srcPath) {
  const text = fs.readFileSync(srcPath, "utf8");
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error("백업 파일을 읽을 수 없어요. (JSON 형식이 아니에요)");
  }
  if (!parsed || typeof parsed !== "object" || !parsed.data || typeof parsed.data !== "object") {
    throw new Error("올바른 새벽봇 백업 파일이 아니에요.");
  }

  const restored = [];
  for (const [key, meta] of Object.entries(DATA_FILES)) {
    if (!Object.prototype.hasOwnProperty.call(parsed.data, key)) continue;
    atomicWriteJson(meta.path, parsed.data[key]);
    meta.store.load();
    eventBus.emit(meta.event);
    restored.push(key);
  }
  return restored;
}

module.exports = { exportBackup, importBackup };
