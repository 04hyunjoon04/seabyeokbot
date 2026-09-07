"use strict";

const fs = require("fs");
const path = require("path");
const dotenv = require("dotenv");

// Electron 앱으로 실행 중이면(설치형/포터블 모두) 윈도우 표준 사용자 데이터 폴더
// (보통 %APPDATA%\saebyeokbot)의 app 객체를 돌려주고, 순수 node로 실행 중(`npm run start:cli`)
// 이거나 아직 app이 준비되지 않은 경우엔 null을 돌려줌. getDataDir/getEnvPath가 같이 씀.
function getElectronApp() {
  try {
    const electron = require("electron");
    const app = electron.app || (electron.remote && electron.remote.app);
    if (app && typeof app.getPath === "function") return app;
  } catch (err) {
    // electron 모듈을 못 쓰는 환경(CLI 모드) — 호출한 쪽에서 폴백 처리
  }
  return null;
}

// 커스텀 명령어/금칙어/토큰 등을 저장할 폴더. Electron 환경이면 %APPDATA%\saebyeokbot\data,
// 아니면 프로젝트 폴더 안의 data 폴더를 그대로 사용합니다.
// 이렇게 설치 폴더와 분리해두면, 새 버전을 설치(덮어쓰기)해도 데이터가 안전하게 남아요.
function getDataDir() {
  const app = getElectronApp();
  if (app) return path.join(app.getPath("userData"), "data");
  return path.join(__dirname, "..", "data");
}

// .env(Client ID/Secret/채널 ID/포트 등)도 마찬가지로 Electron 환경이면 %APPDATA%\saebyeokbot에
// 저장해요. 예전에는 설치 폴더 안에 뒀었는데, 그러면 (1) 배포 패키지에 개발자 PC의 값이
// 그대로 포함되고, (2) 코드를 압축 아카이브(asar) 하나로 묶을 수가 없었어요(설치 폴더는
// 앱 실행 중에 그 자리에서 값을 다시 써야 하는데, asar로 묶으면 그 안은 읽기 전용이라
// 파일을 새로 쓸 수 없거든요). 데이터 폴더와 같은 위치로 옮기면 이 문제가 다 해결되고,
// 파일 수가 줄어들어서 시작 속도(백신 검사 등으로 인한 지연)도 좀 더 빨라져요.
// "계정 연동" 탭에서 입력/저장하는 방식은 그대로예요.
function getEnvPath() {
  const app = getElectronApp();
  if (app) return path.join(app.getPath("userData"), ".env");
  return path.join(__dirname, "..", ".env");
}

const envPath = getEnvPath();
const envExamplePath = path.join(__dirname, "..", ".env.example");

// .env가 아직 없는 최초 실행일 때만 .env.example로 기본 틀을 만들어주고, 이미 있으면
// (업데이트 설치든, 이전에 직접 입력해둔 값이든) 절대 건드리지 않습니다.
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
  // 치지직 공식 Open API 주소. 이 "공식 API" 버전은 채팅 수신/발신/제재까지 전부
  // 이 주소(OAuth 인가 + 세션 구독)로 처리해요. (비공식 NID_AUT/NID_SES 쿠키 방식 아님)
  apiBaseUrl: "https://openapi.chzzk.naver.com",
  // 인가(로그인 동의) 화면 주소 — 방송인이 이 앱에 채팅 읽기/쓰기 등 권한을 허용하는 화면
  authorizeBaseUrl: "https://chzzk.naver.com/account-interlock",

  clientId: required("CLIENT_ID"),
  clientSecret: required("CLIENT_SECRET"),

  channelId: required("CHANNEL_ID", { optional: true }),

  commandPrefix: process.env.COMMAND_PREFIX || "!",

  webEnabled: (process.env.WEB_ENABLED ?? "true") !== "false",
  webPort,
  // OAuth 인가 후 코드(code)를 돌려받을 주소. 관리 페이지 서버가 127.0.0.1에서만
  // 열려있으므로 이 loopback 주소를 리다이렉트 URI로 등록해서 써요.
  redirectUri: process.env.REDIRECT_URI || `http://localhost:${webPort}/callback`,

  envFilePath: envPath,
  dataDir,
  commandsFilePath: path.join(dataDir, "commands.json"),
  banwordsFilePath: path.join(dataDir, "banwords.json"),
  systemCommandOverridesFilePath: path.join(dataDir, "systemCommandOverrides.json"),

  // 치지직 OAuth 토큰(accessToken/refreshToken) 저장 위치
  officialAuthFilePath: path.join(dataDir, "officialAuth.json"),
};

module.exports = config;
