"use strict";

const fs = require("fs");
const path = require("path");
const dotenv = require("dotenv");

// Electron 환경이면 사용자 데이터 폴더(app.getPath("userData"))의 app 객체를 반환, CLI 등 아니면 null 반환.
function getElectronApp() {
  try {
    const electron = require("electron");
    const app = electron.app || (electron.remote && electron.remote.app);
    if (app && typeof app.getPath === "function") return app;
  } catch (err) {
    // electron 모듈 사용 불가 (CLI 모드)
  }
  return null;
}

// 커스텀 명령어/금칙어/토큰 저장 폴더. Electron이면 %APPDATA%\saebyeokbot\data, 아니면 프로젝트 폴더 내 data.
function getDataDir() {
  const app = getElectronApp();
  if (app) return path.join(app.getPath("userData"), "data");
  return path.join(__dirname, "..", "data");
}

// .env 저장 위치. Electron이면 %APPDATA%\saebyeokbot, 아니면 프로젝트 폴더.
function getEnvPath() {
  const app = getElectronApp();
  if (app) return path.join(app.getPath("userData"), ".env");
  return path.join(__dirname, "..", ".env");
}

const envPath = getEnvPath();
const envExamplePath = path.join(__dirname, "..", ".env.example");

// .env가 없는 최초 실행에서만 .env.example로 기본 틀 생성. 이미 있으면 건드리지 않음.
try {
  if (!fs.existsSync(envPath) && fs.existsSync(envExamplePath)) {
    fs.copyFileSync(envExamplePath, envPath);
  }
} catch (err) {
  console.error("[config] .env 파일 생성 실패:", err.message);
}

dotenv.config({ path: envPath });

function required(name, { optional = false } = {}) {
  const value = process.env[name];
  if (!value && !optional) {
    console.warn(`[config] 경고: 환경변수 ${name} 가 비어있습니다. .env 파일을 확인하세요.`);
  }
  return value || "";
}

const dataDir = getDataDir();
try {
  fs.mkdirSync(dataDir, { recursive: true });
} catch (err) {
  console.error("[config] 데이터 폴더 생성 실패:", err.message);
}

const webPort = Number(process.env.WEB_PORT) || 5173;

const config = {
  apiBaseUrl: "https://openapi.chzzk.naver.com",
  authorizeBaseUrl: "https://chzzk.naver.com/account-interlock",

  clientId: required("CLIENT_ID"),
  clientSecret: required("CLIENT_SECRET"),

  channelId: required("CHANNEL_ID", { optional: true }),

  commandPrefix: process.env.COMMAND_PREFIX || "!",

  webEnabled: (process.env.WEB_ENABLED ?? "true") !== "false",
  webPort,
  // OAuth 콜백 주소. 관리 페이지 서버가 127.0.0.1에서만 열려있어 loopback 주소로 등록.
  redirectUri: process.env.REDIRECT_URI || `http://localhost:${webPort}/callback`,

  envFilePath: envPath,
  dataDir,
  commandsFilePath: path.join(dataDir, "commands.json"),
  banwordsFilePath: path.join(dataDir, "banwords.json"),
  systemCommandOverridesFilePath: path.join(dataDir, "systemCommandOverrides.json"),
  officialAuthFilePath: path.join(dataDir, "officialAuth.json"),
  attendanceFilePath: path.join(dataDir, "attendance.json"),
};

module.exports = config;
