require("dotenv").config();
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { promisify } = require("node:util");
const Database = require("better-sqlite3");
const matchTrainingLabels = require("./training-matcher");

const dataDir = path.resolve(process.env.DATA_DIR || path.join(os.homedir(), ".ongyeol-data"));
fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
try { fs.chmodSync(dataDir, 0o700); } catch {}
const uploadsDir = path.join(dataDir, "uploads");
fs.mkdirSync(uploadsDir, { recursive: true, mode: 0o700 });
try { fs.chmodSync(uploadsDir, 0o700); } catch {}

const db = new Database(path.join(dataDir, "ongyeol.sqlite"));
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");
db.exec(`
  CREATE TABLE IF NOT EXISTS profiles (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL UNIQUE COLLATE NOCASE,
    full_name TEXT NOT NULL,
    department TEXT NOT NULL,
    phone TEXT NOT NULL DEFAULT '',
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'teacher' CHECK (role IN ('teacher', 'admin')),
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'active')),
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS sessions_user_id_idx ON sessions(user_id);
  CREATE TABLE IF NOT EXISTS school_config (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    school_name TEXT NOT NULL,
    departments_json TEXT NOT NULL,
    staff_json TEXT NOT NULL DEFAULT '[]',
    trainings_json TEXT NOT NULL,
    onsite_trainings_json TEXT NOT NULL DEFAULT '[]'
  );
  CREATE TABLE IF NOT EXISTS records (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    teacher_name TEXT NOT NULL,
    department TEXT NOT NULL,
    training TEXT NOT NULL,
    trainings_json TEXT NOT NULL DEFAULT '[]',
    extracted_trainings_json TEXT NOT NULL DEFAULT '[]',
    individual_trainings_json TEXT NOT NULL DEFAULT '[]',
    certificate_training_name TEXT,
    completion_date TEXT NOT NULL,
    method TEXT NOT NULL CHECK (method IN ('원격연수', '학교현장연수')),
    file_name TEXT NOT NULL,
    file_path TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS records_user_training_idx ON records(user_id, training);
  CREATE INDEX IF NOT EXISTS records_created_at_idx ON records(created_at DESC);
`);

if (!db.pragma("table_info(profiles)").some((column) => column.name === "phone")) {
  db.exec("ALTER TABLE profiles ADD COLUMN phone TEXT NOT NULL DEFAULT ''");
}

const recordColumns = db.pragma("table_info(records)");
if (!recordColumns.some((column) => column.name === "trainings_json")) db.exec("ALTER TABLE records ADD COLUMN trainings_json TEXT NOT NULL DEFAULT '[]'");
if (!recordColumns.some((column) => column.name === "extracted_trainings_json")) db.exec("ALTER TABLE records ADD COLUMN extracted_trainings_json TEXT NOT NULL DEFAULT '[]'");
if (!recordColumns.some((column) => column.name === "individual_trainings_json")) db.exec("ALTER TABLE records ADD COLUMN individual_trainings_json TEXT NOT NULL DEFAULT '[]'");
const legacyRecords = db.prepare("SELECT id, training, certificate_training_name, method FROM records WHERE trainings_json = '[]' AND extracted_trainings_json = '[]'").all();
const updateLegacyRecord = db.prepare("UPDATE records SET trainings_json = ?, extracted_trainings_json = ? WHERE id = ?");
for (const record of legacyRecords) {
  const trainings = record.training === "미분류 연수" ? [] : [record.training];
  const extracted = record.method === "원격연수" && record.certificate_training_name ? [record.certificate_training_name] : trainings;
  updateLegacyRecord.run(JSON.stringify(trainings), JSON.stringify(extracted), record.id);
}

if (!db.pragma("table_info(school_config)").some((column) => column.name === "staff_json")) {
  db.exec("ALTER TABLE school_config ADD COLUMN staff_json TEXT NOT NULL DEFAULT '[]'");
}
if (!db.pragma("table_info(school_config)").some((column) => column.name === "onsite_trainings_json")) {
  db.exec("ALTER TABLE school_config ADD COLUMN onsite_trainings_json TEXT NOT NULL DEFAULT '[]'");
}

const STAFF_GROUPS = [
  ["교장실", ["정금자"]],
  ["교감실", ["김병호"]],
  ["교무총괄부", ["이주영", "서기원", "김광성", "홍예원", "김윤희", "김민지", "김은화", "박영희"]],
  ["교육연구부", ["송다희", "기미란", "홍승미", "오나연"]],
  ["교육과정부", ["이후영", "장희영", "김인영", "서수진"]],
  ["교육정보부", ["임은경", "김수연"]],
  ["체육예술부", ["김정은", "허진용", "김성훈", "하은효", "양수현", "노희백"]],
  ["학생안전부", ["하소연", "박우용", "김혜진", "박준보", "이다은"]],
  ["창의과학부", ["이승엽", "주정미", "이상은", "조주은", "신명숙", "안현정"]],
  ["진로상담부", ["오미숙", "최윤환", "유지원", "오동건", "정일정", "설승렬", "이규봉"]],
  ["인문사회부", ["승미라", "이시윤", "송주희", "강문주"]],
  ["1학년부", ["박범석", "최인수", "김수현", "이소연", "이지은", "강인영", "이영철", "장미영", "황선익", "천미애", "백승욱", "이하늘", "김미영"]],
  ["2학년부", ["기방호", "이혜인", "정수임", "장소영", "변다희", "박화영", "김빛누리", "강지예", "정혜진", "박근주", "황성진", "이승권", "김은숙"]],
  ["3학년부", ["변미희", "차홍석", "최린", "이경미", "김은지", "권혜원", "이성현", "이재향", "이예원", "박새롬", "송경화", "이연희", "위지연"]],
  ["교육행정실", ["이현주", "설유미", "김영은", "한예은", "김하나", "정미선", "이민순"]]
];
const INITIAL_DEPARTMENTS = STAFF_GROUPS.map(([department]) => department);
const INITIAL_STAFF = STAFF_GROUPS.flatMap(([department, names]) => names.map((name) => ({ department, name })));
const INITIAL_TRAININGS = [
  "교육활동 침해 예방교육", "교직원 인성교육", "학교폭력 예방교육", "선행교육 및 선행학습 예방교육",
  "심폐소생술 및 응급처치", "부패방지·청렴교육", "청탁금지법 교육", "이해충돌방지 교육",
  "공무원 행동강령 교육", "긴급복지 신고의무자 교육", "아동학대 신고의무자 교육", "장애인학대 신고의무자 교육",
  "장애인식 개선교육", "직장 내 장애인식 개선교육", "자살예방 및 생명존중 교육", "감염병 예방교육",
  "정보공개 교육", "개인정보 보호교육", "정보보안 교육", "인권교육"
];
const INITIAL_ONSITE_TRAININGS = [
  "청렴연수 (부패방지·공직윤리 교육)",
  "아동학대 예방 및 신고의무자 교육",
  "응급처치·심폐소생술 교육 (교직원 의무 실습)",
  "개인정보보호 교육 / 정보보안 교육",
  "직장 내 괴롭힘 예방교육"
];

db.prepare(`INSERT OR IGNORE INTO school_config (id, school_name, departments_json, staff_json, trainings_json, onsite_trainings_json)
  VALUES (1, ?, ?, ?, ?, ?)`) 
  .run("주엽고등학교", JSON.stringify(INITIAL_DEPARTMENTS), JSON.stringify(INITIAL_STAFF), JSON.stringify(INITIAL_TRAININGS), JSON.stringify(INITIAL_ONSITE_TRAININGS));

db.exec(`CREATE TABLE IF NOT EXISTS app_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT (datetime('now')))`);
const rosterMigration = "jyeop-staff-roster-v1";
if (!db.prepare("SELECT 1 FROM app_migrations WHERE name = ?").get(rosterMigration)) {
  const savedConfig = db.prepare("SELECT school_name FROM school_config WHERE id = 1").get();
  const schoolName = ["우리 학교", "늘봄중학교"].includes(savedConfig.school_name) ? "주엽고등학교" : savedConfig.school_name;
  db.prepare("UPDATE school_config SET school_name = ?, departments_json = ?, staff_json = ? WHERE id = 1")
    .run(schoolName, JSON.stringify(INITIAL_DEPARTMENTS), JSON.stringify(INITIAL_STAFF));
  const departmentMap = { "교무부": "교무총괄부", "연구부": "교육연구부", "행정실": "교육행정실" };
  const updateProfileDepartment = db.prepare("UPDATE profiles SET department = ? WHERE department = ?");
  const updateRecordDepartment = db.prepare("UPDATE records SET department = ? WHERE department = ?");
  for (const [oldName, newName] of Object.entries(departmentMap)) {
    updateProfileDepartment.run(newName, oldName);
    updateRecordDepartment.run(newName, oldName);
  }
  db.prepare("INSERT INTO app_migrations (name) VALUES (?)").run(rosterMigration);
}

const trainingMigration = "jyeop-certificate-training-catalog-v1";
if (!db.prepare("SELECT 1 FROM app_migrations WHERE name = ?").get(trainingMigration)) {
  const current = db.prepare("SELECT trainings_json FROM school_config WHERE id = 1").get();
  const oldDefaults = [
    "학교폭력 예방교육", "아동학대 신고의무자 교육", "긴급복지 신고의무자 교육", "장애인식 개선교육",
    "성희롱·성폭력 예방교육", "개인정보 보호교육", "청렴·부패방지 교육", "심폐소생술 및 응급처치",
    "정보보안 및 개인정보 보호", "생명존중 및 자살예방 교육", "교원 안전교육", "다문화 이해교육"
  ];
  if (JSON.stringify(JSON.parse(current.trainings_json)) === JSON.stringify(oldDefaults)) {
    db.prepare("UPDATE school_config SET trainings_json = ? WHERE id = 1").run(JSON.stringify(INITIAL_TRAININGS));
  }
  db.prepare("INSERT INTO app_migrations (name) VALUES (?)").run(trainingMigration);
}

const onsiteTrainingMigration = "jyeop-onsite-training-catalog-v1";
if (!db.prepare("SELECT 1 FROM app_migrations WHERE name = ?").get(onsiteTrainingMigration)) {
  db.prepare("UPDATE school_config SET onsite_trainings_json = ? WHERE id = 1").run(JSON.stringify(INITIAL_ONSITE_TRAININGS));
  db.prepare("INSERT INTO app_migrations (name) VALUES (?)").run(onsiteTrainingMigration);
}

const recordCatalogMigration = "jyeop-record-training-catalog-v1";
if (!db.prepare("SELECT 1 FROM app_migrations WHERE name = ?").get(recordCatalogMigration)) {
  const trainings = JSON.parse(db.prepare("SELECT trainings_json FROM school_config WHERE id = 1").get().trainings_json);
  const oldRecords = db.prepare("SELECT id, training, extracted_trainings_json, certificate_training_name, method FROM records").all();
  const update = db.prepare("UPDATE records SET training = ?, trainings_json = ?, individual_trainings_json = ? WHERE id = ?");
  for (const record of oldRecords) {
    let labels = JSON.parse(record.extracted_trainings_json || "[]");
    if (!labels.length) labels = record.method === "원격연수" && record.certificate_training_name ? [record.certificate_training_name] : [record.training];
    const matches = record.method === "학교현장연수" && trainings.includes(record.training)
      ? [record.training]
      : matchTrainingLabels(labels, trainings).map((item) => item.training);
    const matchedSources = new Set(matchTrainingLabels(labels, trainings).flatMap((item) => item.sources));
    const individual = record.method === "원격연수" ? labels.filter((label) => !matchedSources.has(label)) : [];
    update.run(matches[0] || "미분류 연수", JSON.stringify(matches), JSON.stringify(individual), record.id);
  }
  db.prepare("INSERT INTO app_migrations (name) VALUES (?)").run(recordCatalogMigration);
}

const filenameMigration = "repair-upload-filenames-utf8-v1";
if (!db.prepare("SELECT 1 FROM app_migrations WHERE name = ?").get(filenameMigration)) {
  const files = db.prepare("SELECT id, file_name FROM records").all();
  const updateFilename = db.prepare("UPDATE records SET file_name = ? WHERE id = ?");
  for (const file of files) {
    const decoded = Buffer.from(file.file_name, "latin1").toString("utf8");
    const alreadyReadable = /[\uAC00-\uD7A3]/.test(file.file_name);
    if (!decoded.includes("\uFFFD") && /[\uAC00-\uD7A3]/.test(decoded) && !alreadyReadable) updateFilename.run(decoded, file.id);
  }
  db.prepare("INSERT INTO app_migrations (name) VALUES (?)").run(filenameMigration);
}

const scrypt = promisify(crypto.scrypt);
async function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const derived = await scrypt(password, salt, 64, { N: 16384, r: 8, p: 1 });
  return `${salt}:${derived.toString("hex")}`;
}

async function verifyPassword(password, storedHash) {
  if (!storedHash || !storedHash.includes(":")) return false;
  const [salt, hash] = storedHash.split(":");
  const expected = Buffer.from(hash, "hex");
  const actual = await scrypt(password, salt, expected.length, { N: 16384, r: 8, p: 1 });
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

module.exports = { db, dataDir, uploadsDir, hashPassword, verifyPassword };
