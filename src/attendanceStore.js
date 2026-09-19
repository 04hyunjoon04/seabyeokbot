"use strict";

// !출첵 출석체크 기록을 data/attendance.json에 저장/조회하는 저장소.
// 연속 출석은 달력상 연속일이 아니라, 실제 방송이 있었던 날 기준으로 판단.
// 각 유저의 출석 날짜 목록(checkDates)을 원본으로 두고, 연속/총/최장 기록은 그 목록에서 매번 다시 계산.

const fs = require("fs");
const config = require("./config");
const api = require("./api");
const { atomicWriteJson, kst } = require("./utils");
const eventBus = require("./eventBus");

let broadcastDates = []; // 방송이 확인된 날짜(YYYY-MM-DD) 오름차순 목록
let records = {};

function newRecord(channelId, nickname) {
  return {
    channelId,
    nickname,
    profileImageUrl: null,
    checkDates: [],
    totalCount: 0,
    currentStreak: 0,
    longestStreak: 0,
    lastCheckDate: null,
    firstCheckAt: null,
    lastCheckAt: null,
  };
}

// checkDates를 기준으로 총/연속/최장 출석을 다시 계산
function recomputeStats(record) {
  const dateSet = new Set(record.checkDates);
  record.totalCount = record.checkDates.length;

  if (record.checkDates.length === 0) {
    record.currentStreak = 0;
    record.longestStreak = 0;
    record.lastCheckDate = null;
    return;
  }

  let run = 0;
  let longest = 0;
  let streakAtLastCheck = 0;
  for (const bd of broadcastDates) {
    if (dateSet.has(bd)) {
      run += 1;
      if (run > longest) longest = run;
      streakAtLastCheck = run;
    } else {
      run = 0;
    }
  }

  record.longestStreak = longest;
  record.currentStreak = streakAtLastCheck;
  record.lastCheckDate = record.checkDates[record.checkDates.length - 1];
}

// 옛 형식(checkDates 없음) 기록을 최소한으로 복구
function migrateRecord(record) {
  if (!Array.isArray(record.checkDates)) {
    record.checkDates = record.lastCheckDate ? [record.lastCheckDate] : [];
  }
  record.checkDates = Array.from(new Set(record.checkDates)).sort();
  recomputeStats(record);
  return record;
}

function load() {
  try {
    const text = fs.readFileSync(config.attendanceFilePath, "utf8");
    const parsed = JSON.parse(text);
    broadcastDates = Array.isArray(parsed.broadcastDates) ? parsed.broadcastDates : [];
    records = parsed.records && typeof parsed.records === "object" ? parsed.records : {};
    for (const channelId of Object.keys(records)) {
      migrateRecord(records[channelId]);
    }
  } catch (err) {
    broadcastDates = [];
    records = {};
    if (err.code === "ENOENT") return; // 파일 없음 (최초 실행)

    // 파일 손상 시 백업 후 빈 목록으로 시작
    console.error("[attendanceStore] attendance.json 파싱 실패, 빈 목록으로 시작합니다:", err.message);
    try {
      fs.copyFileSync(config.attendanceFilePath, `${config.attendanceFilePath}.corrupted-${Date.now()}.bak`);
    } catch (backupErr) {
      console.error("[attendanceStore] 손상된 파일 백업 실패:", backupErr.message);
    }
  }
}

function save() {
  atomicWriteJson(config.attendanceFilePath, { broadcastDates, records });
  eventBus.emit("attendance");
}

function all() {
  return Object.values(records).sort((a, b) => b.totalCount - a.totalCount);
}

function get(channelId) {
  return records[channelId] || null;
}

// 방송 날짜 목록에 오늘이 없으면 추가 (정렬 유지)
function markBroadcastDate(dateStr) {
  if (!broadcastDates.includes(dateStr)) {
    broadcastDates.push(dateStr);
    broadcastDates.sort();
  }
}

// 오늘 이미 출석했으면 alreadyChecked: true만 반환, 아니면 기록 갱신 후 저장
// 방송 중인지는 호출 전에 호출자가 이미 확인한 상태여야 함
function checkIn(channelId, nickname) {
  const today = kst.dateString();
  markBroadcastDate(today);

  const record = records[channelId] || newRecord(channelId, nickname);

  if (record.checkDates.includes(today)) {
    return { alreadyChecked: true, record };
  }

  record.checkDates.push(today);
  record.checkDates.sort();
  record.nickname = nickname;
  record.lastCheckAt = Date.now();
  if (!record.firstCheckAt) record.firstCheckAt = Date.now();
  recomputeStats(record);

  records[channelId] = record;
  save();
  return { alreadyChecked: false, record };
}

// 특정 날짜를, 이미 출첵 기록이 있는 유저들에 한해 일괄 출석/결석 처리. 새 유저 행은 만들지 않음.
function bulkSetAttendance(dateStr, attended) {
  if (attended) markBroadcastDate(dateStr);
  let affected = 0;
  const channelIds = Object.keys(records);
  for (const channelId of channelIds) {
    const record = records[channelId];
    const has = record.checkDates.includes(dateStr);
    if (attended && !has) {
      record.checkDates.push(dateStr);
      record.checkDates.sort();
      affected += 1;
    } else if (!attended && has) {
      record.checkDates = record.checkDates.filter((d) => d !== dateStr);
      affected += 1;
    }
    recomputeStats(record);
  }
  save();
  return { date: dateStr, attended, affected, total: channelIds.length };
}

// 특정 유저의 특정 날짜 출석 여부를 관리자가 직접 켜고 끔. 기존에 출첵 기록이 없는 유저는 대상이 아님.
function setDateAttendance(channelId, dateStr, attended) {
  const record = records[channelId];
  if (!record) return null;

  if (attended) {
    markBroadcastDate(dateStr);
    if (!record.checkDates.includes(dateStr)) {
      record.checkDates.push(dateStr);
      record.checkDates.sort();
    }
  } else {
    record.checkDates = record.checkDates.filter((d) => d !== dateStr);
  }
  recomputeStats(record);
  save();
  return record;
}

// 프로필 사진은 별도 API 호출이 필요해 출첵 응답과 분리, 실패해도 출첵 자체는 정상 처리
async function refreshProfileImage(channelId) {
  const record = records[channelId];
  if (!record) return;
  try {
    const result = await api.getChannels([channelId]);
    const ch = (result && result.data && result.data[0]) || null;
    if (ch && ch.channelImageUrl && ch.channelImageUrl !== record.profileImageUrl) {
      record.profileImageUrl = ch.channelImageUrl;
      save();
    }
  } catch (err) {
    console.error("[attendanceStore] 프로필 사진 조회 실패:", err.message);
  }
}

function remove(channelId) {
  if (!Object.prototype.hasOwnProperty.call(records, channelId)) return false;
  delete records[channelId];
  save();
  return true;
}

load();

module.exports = {
  load,
  all,
  get,
  checkIn,
  bulkSetAttendance,
  setDateAttendance,
  refreshProfileImage,
  remove,
};
