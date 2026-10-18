const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const escapeHTML = (value) => String(value ?? "").replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);
const formatPhone = (value) => {
  const digits = String(value || "").replace(/\D/g, "");
  return digits.length === 11 ? `${digits.slice(0, 3)}-${digits.slice(3, 7)}-${digits.slice(7)}` : digits.length === 10 ? `${digits.slice(0, 3)}-${digits.slice(3, 6)}-${digits.slice(6)}` : digits;
};

let config = { schoolName: "주엽고등학교", departments: [], staff: [], trainings: [], onsiteTrainings: [] };
let profile = null;
let records = [];
let users = [];
let selectedFile = null;
let extractedTrainings = [];
let matchedTrainings = [];
let activeAdminTab = "status";
let adminSubview = "matrix";
let toastTimer;
let drawing = false;
let hasSignature = false;
const signatureCanvas = $("#signature-pad");
const signatureContext = signatureCanvas.getContext("2d");

async function api(url, options = {}) {
  const response = await fetch(url, { credentials: "same-origin", ...options });
  const data = response.status === 204 ? {} : await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || "요청을 처리하지 못했어요.");
  return data;
}

function showToast(message) {
  const toast = $("#toast");
  toast.textContent = message;
  toast.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove("show"), 3200);
}

function hideAuthCards() {
  $$(".auth-card").forEach((card) => { card.hidden = true; });
}

function showAuthCard(cardId) {
  document.body.classList.toggle("admin-mode", location.pathname === "/admin");
  $("#brand-home").href = location.pathname === "/admin" ? "/admin" : "/";
  $("#app-main").hidden = true;
  $("#auth-gate").hidden = false;
  hideAuthCards();
  $(cardId).hidden = false;
  $("#signed-in-email").hidden = true;
  $("#logout-button").hidden = true;
}

function setError(target, message) {
  const element = $(target);
  element.textContent = message;
  element.hidden = false;
}

function clearErrors() {
  $$(".auth-error").forEach((item) => { item.hidden = true; item.textContent = ""; });
}

function fillSchoolLists() {
  $(".school-name").lastChild.textContent = config.schoolName;
  $("#onsite-training").replaceChildren();
  $("#onsite-training").add(new Option("연수를 선택해 주세요", ""));
  $("#register-department").replaceChildren(new Option("부서를 선택해 주세요", ""));
  config.departments.forEach((department) => {
    $("#register-department").add(new Option(department, department));
  });
  config.onsiteTrainings.forEach((training) => {
    $("#onsite-training").add(new Option(training, training));
  });
  fillRegistrationNames();
}

function fillRegistrationNames() {
  const department = $("#register-department").value;
  const nameSelect = $("#register-name");
  const names = config.staff.filter((person) => person.department === department);
  nameSelect.replaceChildren(new Option(department ? (names.length ? "이름을 선택해 주세요" : "등록된 교직원이 없어요") : "먼저 부서를 선택해 주세요", ""));
  names.forEach((person) => nameSelect.add(new Option(person.name, person.name)));
  nameSelect.disabled = !department || !names.length;
}

async function loadPublicSetup() {
  try {
    const setup = await api("/api/setup-status");
    config = await api("/api/public-config");
    fillSchoolLists();
    if (!setup.adminExists) {
      showAuthCard("#setup-card");
      return false;
    }
    return true;
  } catch (error) {
    showAuthCard("#setup-card");
    $("#setup-message").textContent = `앱 서버에 연결하지 못했어요. 서버가 실행 중인지 확인해 주세요. (${error.message})`;
    return false;
  }
}

async function loadSession() {
  if (!await loadPublicSetup()) return;
  try {
    const result = await api("/api/auth/me");
    await enterAccount(result.user);
  } catch {
    showAuthCard("#login-card");
  }
}

async function enterAccount(user) {
  profile = user;
  $("#brand-home").href = profile.role === "admin" ? "/admin" : "/";
  if (profile.status !== "active") {
    showAuthCard("#pending-card");
    return;
  }
  config = await api("/api/config");
  fillSchoolLists();
  $("#auth-gate").hidden = true;
  $("#app-main").hidden = false;
  $("#signed-in-email").hidden = false;
  $("#signed-in-email").textContent = profile.email;
  $("#logout-button").hidden = false;
  $("#person-name").textContent = profile.fullName;
  $("#person-department").textContent = profile.department;
  $("#person-avatar").textContent = profile.fullName.slice(0, 1);
  $("#signature-person").textContent = profile.fullName;
  $("#remote-person").textContent = `${profile.department} · ${profile.fullName} 선생님`;
  $("#onsite-person").textContent = `${profile.department} · ${profile.fullName} 선생님`;
  $("#onsite-today").textContent = new Intl.DateTimeFormat("ko-KR", { year: "numeric", month: "long", day: "numeric" }).format(new Date());
  await refreshRecords();
  const isAdminPath = location.pathname.startsWith("/admin");
  const target = isAdminPath && profile.role === "admin" ? "admin" : "home";
  if (isAdminPath && profile.role !== "admin") {
    history.replaceState({}, "", "/");
    showToast("관리자 계정으로만 들어갈 수 있어요.");
  }
  showPage(target, false);
  if (target === "admin") setAdminSubview(location.pathname === "/admin/remote-overview" ? "overview" : "matrix", false);
}

function showPage(name, updateAddress = true) {
  if (name === "admin" && profile?.role !== "admin") {
    showToast("관리자 계정으로만 들어갈 수 있어요.");
    return;
  }
  $$(".page").forEach((page) => {
    const active = page.id === `${name}-page`;
    page.hidden = !active;
    page.classList.toggle("active", active);
  });
  if (updateAddress) {
    const path = name === "admin" ? "/admin" : "/";
    history.pushState({}, "", path);
  }
  document.body.classList.toggle("admin-mode", name === "admin");
  if (name === "admin") renderAdmin();
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function setAdminSubview(view, updateAddress = true) {
  if (profile?.role !== "admin") return;
  adminSubview = view;
  const showingSummary = view === "overview";
  $("#remote-summary-content").hidden = !showingSummary;
  $("#remote-summary-open").hidden = showingSummary;
  $("#admin-controls").hidden = showingSummary;
  $("#admin-stats").hidden = showingSummary;
  $("#status-content").hidden = showingSummary || activeAdminTab !== "status";
  $("#onsite-content").hidden = showingSummary || activeAdminTab !== "onsite";
  $("#files-content").hidden = showingSummary || activeAdminTab !== "files";
  $("#individual-content").hidden = showingSummary || activeAdminTab !== "individual";
  $("#users-content").hidden = showingSummary || activeAdminTab !== "users";
  if (showingSummary) renderCourseOverview(getSchoolStaff(), completedKeys());
  else renderAdmin();
  if (updateAddress) history.pushState({}, "", showingSummary ? "/admin/remote-overview" : "/admin");
  window.scrollTo({ top: 0, behavior: "smooth" });
}

async function refreshRecords() {
  records = await api("/api/records");
  if (profile.role === "admin") users = await api("/api/admin/users");
  renderMyMaterials();
  if (!$("#admin-page").hidden) renderAdmin();
}

function completedKeys(list = records) {
  return new Set(list.flatMap((record) => (record.trainings?.length ? record.trainings : [record.training]).filter((training) => config.trainings.includes(training)).map((training) => `${record.user_id}|${training}`)));
}

function openSubmission(method) {
  selectedFile = null;
  if (method === "remote") {
    $("#certificate-file").value = "";
    extractedTrainings = [];
    matchedTrainings = [];
    $("#upload-title").textContent = "이수증 PDF 파일을 올려주세요";
    $("#upload-description").textContent = "파일을 누르거나 여기에 끌어다 놓으세요";
    $("#extracted-name").value = "";
    $("#completion-date").value = "";
    $("#extraction-status").hidden = true;
    renderTrainingMatches();
    $("#save-remote").disabled = true;
  } else {
    requestAnimationFrame(resizeCanvas);
  }
  showPage(method === "remote" ? "remote" : "onsite");
}

$("#login-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  clearErrors();
  const button = event.currentTarget.querySelector("button[type=submit]");
  button.disabled = true;
  try {
    const result = await api("/api/auth/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: $("#login-email").value, password: $("#login-password").value }) });
    await enterAccount(result.user);
  } catch (error) {
    setError("#login-error", error.message);
  } finally {
    button.disabled = false;
  }
});

$("#register-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  clearErrors();
  const button = event.currentTarget.querySelector("button[type=submit]");
  button.disabled = true;
  try {
    const result = await api("/api/auth/register", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ fullName: $("#register-name").value, department: $("#register-department").value, email: $("#register-email").value, phone: $("#register-phone").value, password: $("#register-password").value }) });
    event.currentTarget.reset();
    showAuthCard("#login-card");
    showToast(result.message);
  } catch (error) {
    setError("#register-error", error.message);
  } finally {
    button.disabled = false;
  }
});
$("#register-department").addEventListener("change", fillRegistrationNames);

async function logout() {
  const returnPath = profile?.role === "admin" ? "/admin" : "/";
  try { await api("/api/auth/logout", { method: "POST" }); } catch {}
  profile = null;
  records = [];
  users = [];
  history.replaceState({}, "", returnPath);
  $("#brand-home").href = returnPath;
  showAuthCard("#login-card");
  $("#login-password").value = "";
}

$("#logout-button").addEventListener("click", logout);
$("#pending-logout").addEventListener("click", logout);
$("#show-register").addEventListener("click", () => { clearErrors(); showAuthCard("#register-card"); });
$("#back-to-login").addEventListener("click", () => { clearErrors(); showAuthCard("#login-card"); });
$("#setup-recheck").addEventListener("click", loadSession);

$$('[data-method]').forEach((button) => button.addEventListener("click", () => openSubmission(button.dataset.method)));
$$('[data-back]').forEach((button) => button.addEventListener("click", () => showPage("home")));
$("#admin-department").addEventListener("change", renderAdmin);
$("#remote-summary-back").addEventListener("click", () => setAdminSubview("matrix"));
window.addEventListener("popstate", () => {
  if (!profile) return;
  if (location.pathname.startsWith("/admin") && profile.role === "admin") {
    showPage("admin", false);
    setAdminSubview(location.pathname === "/admin/remote-overview" ? "overview" : "matrix", false);
  } else showPage("home", false);
});

$("#choose-file").addEventListener("click", () => $("#certificate-file").click());
$("#upload-zone").addEventListener("click", (event) => { if (!event.target.closest("button")) $("#certificate-file").click(); });
$("#certificate-file").addEventListener("change", (event) => handleCertificate(event.target.files[0]));
$("#upload-zone").addEventListener("dragover", (event) => { event.preventDefault(); $("#upload-zone").classList.add("dragover"); });
$("#upload-zone").addEventListener("dragleave", () => $("#upload-zone").classList.remove("dragover"));
$("#upload-zone").addEventListener("drop", (event) => { event.preventDefault(); $("#upload-zone").classList.remove("dragover"); handleCertificate(event.dataTransfer.files[0]); });

async function handleCertificate(file) {
  if (!file) return;
  if (file.type !== "application/pdf" && !file.name.toLowerCase().endsWith(".pdf")) return showToast("PDF 파일만 올릴 수 있어요.");
  if (file.size > 15 * 1024 * 1024) return showToast("파일 크기는 15MB 이하로 올려 주세요.");
  selectedFile = file;
  $("#upload-title").textContent = file.name;
  $("#upload-description").textContent = `${(file.size / 1024 / 1024).toFixed(2)}MB · 파일이 선택되었어요`;
  updateRemoteSubmit();
  await extractCertificateText(file);
}

async function extractCertificateText(file) {
  const status = $("#extraction-status");
  status.hidden = false;
  status.classList.remove("error");
  status.textContent = "이수증 내용을 확인하고 있어요...";
  try {
    if (!window.pdfjsLib) throw new Error("PDF 글자 읽기 기능을 불러오지 못했어요.");
    pdfjsLib.GlobalWorkerOptions.workerSrc = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
    const pdf = await pdfjsLib.getDocument({ data: await file.arrayBuffer() }).promise;
    let text = "";
    for (let pageNo = 1; pageNo <= Math.min(pdf.numPages, 4); pageNo += 1) {
      const page = await pdf.getPage(pageNo);
      const content = await page.getTextContent();
      text += ` ${content.items.map((item) => item.str).join(" ")}`;
    }
    const parsed = window.parseCertificateText(text);
    extractedTrainings = parsed.trainings;
    $("#extracted-name").value = extractedTrainings.join("\n");
    $("#completion-date").value = parsed.completionDate;
    renderTrainingMatches();
    status.textContent = extractedTrainings.length ? `${extractedTrainings.length}개 연수명을 읽었어요. 연결된 필수 연수를 확인해 주세요.` : "연수명을 찾지 못했어요. 아래 칸에 연수명을 한 줄씩 입력해 주세요.";
  } catch (error) {
    status.classList.add("error");
    status.textContent = `${error.message} 연수명과 날짜를 직접 입력해 주세요.`;
  }
  updateRemoteSubmit();
}

function renderTrainingMatches() {
  matchedTrainings = window.matchTrainingLabels(extractedTrainings, config.trainings);
  const matchedSources = new Set(matchedTrainings.flatMap((item) => item.sources));
  const unmatched = extractedTrainings.filter((label) => !matchedSources.has(label));
  $("#matched-trainings").innerHTML = matchedTrainings.length ? matchedTrainings.map((item) => `<label class="matched-training"><input type="checkbox" value="${escapeHTML(item.training)}" checked><span><strong>${escapeHTML(item.training)}</strong><small>이수증 표기: ${escapeHTML(item.sources.join(", "))}</small></span></label>`).join("") : '<p class="detected-empty">필수 연수 목록과 연결된 항목이 아직 없어요.</p>';
  $("#unmatched-trainings").hidden = !unmatched.length;
  $("#unmatched-trainings").innerHTML = unmatched.length ? `<strong>개별 연수로 따로 기록</strong><span>${unmatched.map(escapeHTML).join(" · ")}<br>전체 필수 이수율에는 포함하지 않고, 내 제출 내역과 관리자 ‘개별 연수’ 탭에 표시합니다.</span>` : "";
  $$("#matched-trainings input").forEach((input) => input.addEventListener("change", updateRemoteSubmit));
}

function readTrainingLabels() {
  extractedTrainings = [...new Set($("#extracted-name").value.split(/[\n,，、]/).map((label) => label.trim()).filter(Boolean))];
  renderTrainingMatches();
  updateRemoteSubmit();
}

function selectedCanonicalTrainings() {
  return $$("#matched-trainings input:checked").map((input) => input.value);
}

function updateRemoteSubmit() {
  $("#save-remote").disabled = !(selectedFile && extractedTrainings.length && $("#completion-date").value);
}
$("#extracted-name").addEventListener("input", readTrainingLabels);
$("#completion-date").addEventListener("change", updateRemoteSubmit);

async function submitFile(method, training, completionDate, certificateTrainingName, labels, matched, file) {
  const body = new FormData();
  body.set("method", method);
  body.set("training", training || "");
  body.set("completionDate", completionDate);
  body.set("certificateTrainingName", certificateTrainingName || "");
  body.set("extractedTrainings", JSON.stringify(labels));
  body.set("selectedTrainings", JSON.stringify(matched));
  body.set("file", file, file.name || (method === "원격연수" ? "이수증.pdf" : "서명.png"));
  const result = await api("/api/records", { method: "POST", body });
  await refreshRecords();
  showPage("home");
  showToast(method === "원격연수" ? `${result.trainings.length}개 필수 연수, ${result.individualTrainings.length}개 개별 연수를 기록했어요.` : "현장연수 서명이 등록됐어요.");
}

$("#save-remote").addEventListener("click", async () => {
  if (!selectedFile) return;
  const button = $("#save-remote");
  button.disabled = true;
  try {
    await submitFile("원격연수", selectedCanonicalTrainings()[0], $("#completion-date").value, extractedTrainings.join(" · "), extractedTrainings, selectedCanonicalTrainings(), selectedFile);
  } catch (error) {
    showToast(error.message);
    updateRemoteSubmit();
  }
});

function resizeCanvas() {
  const rect = signatureCanvas.getBoundingClientRect();
  if (!rect.width) return;
  const ratio = window.devicePixelRatio || 1;
  signatureCanvas.width = Math.round(rect.width * ratio);
  signatureCanvas.height = Math.round(rect.height * ratio);
  signatureContext.setTransform(ratio, 0, 0, ratio, 0, 0);
  signatureContext.lineWidth = 2.4;
  signatureContext.lineCap = "round";
  signatureContext.lineJoin = "round";
  signatureContext.strokeStyle = "#2e4d3a";
  hasSignature = false;
  $("#signature-placeholder").hidden = false;
  updateOnsiteSubmit();
}

function pointFromEvent(event) {
  const rect = signatureCanvas.getBoundingClientRect();
  return { x: event.clientX - rect.left, y: event.clientY - rect.top };
}
signatureCanvas.addEventListener("pointerdown", (event) => {
  event.preventDefault();
  signatureCanvas.setPointerCapture(event.pointerId);
  const point = pointFromEvent(event);
  drawing = true;
  signatureContext.beginPath();
  signatureContext.moveTo(point.x, point.y);
});
signatureCanvas.addEventListener("pointermove", (event) => {
  if (!drawing) return;
  const point = pointFromEvent(event);
  signatureContext.lineTo(point.x, point.y);
  signatureContext.stroke();
  hasSignature = true;
  $("#signature-placeholder").hidden = true;
  updateOnsiteSubmit();
});
function stopDrawing() { drawing = false; }
signatureCanvas.addEventListener("pointerup", stopDrawing);
signatureCanvas.addEventListener("pointercancel", stopDrawing);
window.addEventListener("resize", () => { if (!$("#onsite-page").hidden) resizeCanvas(); });
$("#clear-signature").addEventListener("click", () => {
  signatureContext.clearRect(0, 0, signatureCanvas.width, signatureCanvas.height);
  hasSignature = false;
  $("#signature-placeholder").hidden = false;
  updateOnsiteSubmit();
});
function updateOnsiteSubmit() { $("#save-onsite").disabled = !(hasSignature && $("#onsite-training").value); }
$("#onsite-training").addEventListener("change", updateOnsiteSubmit);

$("#save-onsite").addEventListener("click", async () => {
  if (!hasSignature || !$("#onsite-training").value) return;
  const button = $("#save-onsite");
  button.disabled = true;
  const date = new Date();
  const completionDate = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
  const blob = await new Promise((resolve) => signatureCanvas.toBlob(resolve, "image/png"));
  try {
    await submitFile("학교현장연수", $("#onsite-training").value, completionDate, "", [], [$("#onsite-training").value], new File([blob], `${profile.fullName}_서명.png`, { type: "image/png" }));
  } catch (error) {
    showToast(error.message);
    button.disabled = false;
  }
});

function renderAdmin() {
  if (profile?.role !== "admin") return showPage("home", false);
  const schoolStaff = getSchoolStaff();
  const completed = completedKeys();
  const total = schoolStaff.length * config.trainings.length;
  const completedCount = schoolStaff.reduce((sum, person) => sum + config.trainings.filter((training) => person.account && completed.has(`${person.account.id}|${training}`)).length, 0);
  const teachersDone = schoolStaff.filter((person) => person.account && config.trainings.every((training) => completed.has(`${person.account.id}|${training}`))).length;
  const percent = total ? Math.round(completedCount / total * 100) : 0;
  $("#admin-stats").innerHTML = `<div class="stat-card"><span>필수 원격연수 이수율</span><strong>${percent}<small>%</small></strong></div><div class="stat-card"><span>필수 연수 전체 완료</span><strong>${teachersDone}<small> / ${schoolStaff.length}명</small></strong></div>`;
  $("#file-count").textContent = records.length;
  $("#individual-count").textContent = records.reduce((count, record) => count + (record.individualTrainings?.length || 0), 0);
  $("#pending-count").textContent = users.filter((user) => user.status === "pending").length;
  renderCourseOverview(schoolStaff, completed);
  renderStatusTable(completed, schoolStaff);
  renderOnsiteTable(schoolStaff);
  renderMaterials("#materials-list", records);
  renderIndividualTrainings();
  renderUsers();
}

function renderCourseOverview(schoolStaff, completed) {
  $("#course-overview").innerHTML = config.trainings.map((training) => {
    const count = schoolStaff.filter((person) => person.account && completed.has(`${person.account.id}|${training}`)).length;
    const percent = schoolStaff.length ? Math.round(count / schoolStaff.length * 100) : 0;
    return `<button class="course-summary-card" type="button" data-course-detail="${escapeHTML(training)}" aria-haspopup="dialog"><span class="course-card-title" title="${escapeHTML(training)}">${escapeHTML(training)}</span><span class="course-summary-counts"><span><strong>${count}</strong>명 이수</span><span><strong>${schoolStaff.length - count}</strong>명 미이수</span></span><span class="course-summary-track" role="meter" aria-label="${escapeHTML(training)} 이수율" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${percent}"><span style="width:${percent}%"></span></span><small>이수율 ${percent}%</small></button>`;
  }).join("");
  $$('[data-course-detail]').forEach((button) => button.addEventListener("click", () => showCourseDetails(button.dataset.courseDetail)));
}

function showCourseDetails(training) {
  const completed = completedKeys();
  const schoolStaff = getSchoolStaff();
  const done = schoolStaff.filter((person) => person.account && completed.has(`${person.account.id}|${training}`));
  const pending = schoolStaff.filter((person) => !person.account || !completed.has(`${person.account.id}|${training}`));
  $("#course-detail-title").textContent = training;
  $("#course-completed-count").textContent = `${done.length}명`;
  $("#course-pending-count").textContent = `${pending.length}명`;
  $("#course-completed-names").innerHTML = done.length ? done.map((person) => `<li><strong>${escapeHTML(person.name)}</strong><small>${escapeHTML(person.department)}</small></li>`).join("") : '<li class="course-empty-name">아직 이수한 선생님이 없어요.</li>';
  $("#course-pending-names").innerHTML = pending.length ? pending.map((person) => `<li><strong>${escapeHTML(person.name)}</strong><small>${escapeHTML(person.department)}${person.account ? "" : " · 가입 전"}</small></li>`).join("") : '<li class="course-empty-name">모든 선생님이 이수했어요.</li>';
  $("#course-detail-modal").hidden = false;
  $("#course-detail-close").focus();
}

function getSchoolStaff() {
  return config.staff.map((person) => ({
    ...person,
    account: users.find((user) => user.fullName === person.name && user.department === person.department)
  }));
}

function accountStatusLabel(account) {
  if (!account) return '<span class="status-pill pending">가입 전</span>';
  if (account.status === "pending") return '<span class="status-pill pending">승인 대기</span>';
  return '<span class="status-pill complete">가입</span>';
}

function contactCell(phone, message) {
  if (!phone) return '<span class="contact-missing">번호 없음</span>';
  if (!message) return '<span class="status-pill complete">완료</span>';
  const href = `sms:${phone}?body=${encodeURIComponent(message)}`;
  return `<span class="contact-cell"><small>${escapeHTML(formatPhone(phone))}</small><a class="sms-link" href="${escapeHTML(href)}">문자</a></span>`;
}

function legacyRenderStatusTable(completed, schoolStaff) {
  const trainings = config.trainings;
  const filtered = schoolStaff.filter((person) => (!query || person.name.includes(query)) && matchesMatrixFilters(person, "status", config.trainings, completed));
  const departmentOptions = config.departments.map((department) => [department, department]);
  const accountOptions = [["active", "가입 완료"], ["pending", "승인 대기"], ["none", "가입 전"]];
  $("#status-head").innerHTML = `<tr><th scope="col">${headerFilterMarkup("status", "department", "department", "부서", matrixFilters.status.department, departmentOptions)}</th><th scope="col">이름</th><th scope="col">${headerFilterMarkup("status", "account", "account", "계정", matrixFilters.status.account, accountOptions)}</th>${config.trainings.map((training) => `<th scope="col" title="${escapeHTML(training)}"><span class="column-heading">${escapeHTML(training.replace("교육", ""))}</span>${headerFilterMarkup("status", "training", training, training, matrixFilters.status.trainings[training] || "all", [["complete", "이수"], ["pending", "미이수"]])}</th>`).join("")}<th scope="col">이수율</th><th scope="col">연락</th></tr>`;
  $("#remote-filter-count").textContent = `${filtered.length} / ${schoolStaff.length}명 표시`;
  $("#status-body").innerHTML = filtered.length ? filtered.map((person) => {
    const count = config.trainings.filter((training) => person.account && completed.has(`${person.account.id}|${training}`)).length;
    const cells = trainings.map((training) => person.account && completed.has(`${person.account.id}|${training}`) ? '<td><span class="status-pill complete">이수</span></td>' : '<td><span class="status-pill pending">미이수</span></td>').join("");
    const accountStatus = accountStatusLabel(person.account);
    const filteredMissing = trainings.filter((training) => !person.account || !completed.has(`${person.account.id}|${training}`));
    const message = filteredMissing.length ? `${config.schoolName} 연수 이수 안내: ${filteredMissing.join(", ")}의 이수 여부를 확인해 주세요.` : "";
    return `<tr><td>${escapeHTML(person.department)}</td><td>${escapeHTML(person.name)}</td><td>${accountStatus}</td>${cells}<td><strong>${Math.round(count / config.trainings.length * 100)}%</strong></td><td>${contactCell(person.account?.phone, message)}</td></tr>`;
  }).join("") : `<tr><td colspan="${trainings.length + 5}" class="empty-state">조건에 맞는 교직원이 없어요.</td></tr>`;
}

function legacyRenderOnsiteTable(schoolStaff) {
  const query = $("#admin-search").value.trim();
  const trainings = config.onsiteTrainings;
  const onsiteCompleted = new Set(records.filter((record) => record.method === "학교현장연수").flatMap((record) => (record.trainings || []).map((training) => `${record.user_id}|${training}`)));
  const filtered = schoolStaff.filter((person) => (!query || person.name.includes(query)) && matchesMatrixFilters(person, "onsite", trainings, onsiteCompleted));
  const departmentOptions = config.departments.map((department) => [department, department]);
  const accountOptions = [["active", "가입 완료"], ["pending", "승인 대기"], ["none", "가입 전"]];
  $("#onsite-head").innerHTML = `<tr><th scope="col">${headerFilterMarkup("onsite", "department", "department", "부서", matrixFilters.onsite.department, departmentOptions)}</th><th scope="col">이름</th><th scope="col">${headerFilterMarkup("onsite", "account", "account", "계정", matrixFilters.onsite.account, accountOptions)}</th>${trainings.map((training) => `<th scope="col" title="${escapeHTML(training)}"><span class="column-heading">${escapeHTML(training)}</span>${headerFilterMarkup("onsite", "training", training, training, matrixFilters.onsite.trainings[training] || "all", [["complete", "이수"], ["pending", "미이수"]])}</th>`).join("")}<th scope="col">연락</th></tr>`;
  $("#onsite-filter-count").textContent = `${filtered.length} / ${schoolStaff.length}명 표시`;
  $("#onsite-body").innerHTML = filtered.length ? filtered.map((person) => {
    const accountStatus = accountStatusLabel(person.account);
    const cells = trainings.map((training) => person.account && onsiteCompleted.has(`${person.account.id}|${training}`) ? '<td><span class="status-pill complete">참석</span></td>' : '<td><span class="status-pill pending">미참석</span></td>').join("");
    const missing = trainings.filter((training) => !person.account || !onsiteCompleted.has(`${person.account.id}|${training}`));
    const message = missing.length ? `${config.schoolName} 학교현장연수 참석 안내: ${missing.join(", ")}에 참석해 주세요.` : "";
    return `<tr><td>${escapeHTML(person.department)}</td><td>${escapeHTML(person.name)}</td><td>${accountStatus}</td>${cells}<td>${contactCell(person.account?.phone, message)}</td></tr>`;
  }).join("") : `<tr><td colspan="${trainings.length + 4}" class="empty-state">조건에 맞는 교직원이 없어요.</td></tr>`;
}

function legacyRenderMaterials(target, items) {
  const query = $("#admin-search").value.trim();
  const department = $("#admin-department").value;
  const filtered = items.filter((record) => (!query || record.teacher_name.includes(query)) && (department === "all" || record.department === department));
  $(target).innerHTML = filtered.length ? filtered.map((record) => {
    const linkedTrainings = [...(record.trainings || []), ...(record.individualTrainings || [])];
    const title = linkedTrainings.length > 3
      ? `${record.trainings?.length || 0}개 필수 · ${record.individualTrainings?.length || 0}개 개별 연수`
      : linkedTrainings.length ? linkedTrainings.join(" · ") : (record.certificate_training_name || "필수 목록 연결 대기");
    const detail = record.method === "원격연수" ? `${record.extractedTrainings?.length || 0}개 과정 추출 · ${record.file_name}` : record.file_name;
    return `<div class="material-row"><div class="material-main"><span class="file-type ${record.method === "학교현장연수" ? "signature-type" : ""}">${record.method === "학교현장연수" ? "서명" : "PDF"}</span><span class="material-copy"><strong title="${escapeHTML(linkedTrainings.join(" · ") || title)}">${escapeHTML(title)}</strong><small title="${escapeHTML(record.certificate_training_name || "")}">${escapeHTML(detail)}</small></span></div><span class="material-person">${escapeHTML(record.department)} · ${escapeHTML(record.teacher_name)}</span><span class="material-date">${escapeHTML(record.completion_date)}</span><div class="material-actions"><a class="small-action" href="/api/records/${encodeURIComponent(record.id)}/preview" target="_blank" rel="noopener">보기</a><button class="small-action delete" type="button" data-delete="${escapeHTML(record.id)}">삭제</button></div></div>`;
  }).join("") : '<div class="empty-state">아직 제출한 자료가 없어요.</div>';
  $$(`${target} [data-delete]`).forEach((button) => button.addEventListener("click", () => deleteRecord(button.dataset.delete)));
}

function legacyRenderIndividualTrainings() {
  const query = $("#admin-search").value.trim();
  const department = $("#admin-department").value;
  const rows = records.flatMap((record) => (record.individualTrainings || []).map((training) => ({ record, training })))
    .filter(({ record }) => (!query || record.teacher_name.includes(query)) && (department === "all" || record.department === department));
  $("#individual-list").innerHTML = rows.length ? rows.map(({ record, training }) => `<div class="material-row"><div class="material-main"><span class="file-type individual-type">개별</span><span class="material-copy"><strong title="${escapeHTML(training)}">${escapeHTML(training)}</strong><small>${escapeHTML(record.file_name)}</small></span></div><span class="material-person">${escapeHTML(record.department)} · ${escapeHTML(record.teacher_name)}</span><span class="material-date">${escapeHTML(record.completion_date)}</span><div class="material-actions"><a class="small-action" href="/api/records/${encodeURIComponent(record.id)}/preview" target="_blank" rel="noopener">이수증 보기</a></div></div>`).join("") : '<div class="empty-state">개별 연수로 기록된 제출 자료가 없어요.</div>';
}

function renderMyMaterials() {
  const mine = records.filter((record) => record.user_id === profile.id);
  const list = $("#my-materials-list");
  if (!mine.length) {
    list.innerHTML = '<div class="my-material-empty">아직 제출한 연수가 없어요.</div>';
    return;
  }
  renderMaterials("#my-materials-list", mine);
}

function legacyRenderUsers() {
  const query = $("#admin-search").value.trim();
  const department = $("#admin-department").value;
  const phoneQuery = query.replace(/\D/g, "");
  const matchesQuery = (user) => (!query || user.fullName.includes(query) || user.email.includes(query) || (phoneQuery.length >= 3 && user.phone?.includes(phoneQuery))) && (department === "all" || user.department === department);
  const pending = users.filter((user) => user.status === "pending" && matchesQuery(user));
  const active = users.filter((user) => user.status === "active" && user.role === "teacher" && matchesQuery(user));
  const rows = [...pending, ...active];
  $("#users-list").innerHTML = rows.length ? `<div class="table-scroll"><table class="admin-users-table"><thead><tr><th>이름 / 이메일</th><th>부서</th><th>휴대폰</th><th>상태</th><th>관리</th></tr></thead><tbody>${rows.map((user) => `<tr class="${user.status === "pending" ? "pending-row" : ""}"><td>${escapeHTML(user.fullName)}<br><small>${escapeHTML(user.email)}</small></td><td>${escapeHTML(user.department)}</td><td>${contactCell(user.phone, `${user.fullName} 선생님, 연수 확인 계정 신청 관련 확인을 위해 연락드립니다.`)}</td><td>${user.status === "pending" ? "승인 대기" : "승인 완료"}</td><td>${user.status === "pending" ? `<button type="button" data-approve="${escapeHTML(user.id)}">승인</button><button class="reject" type="button" data-reject="${escapeHTML(user.id)}">거절</button>` : `<button class="reject" type="button" data-reject="${escapeHTML(user.id)}">계정 삭제</button>`}</td></tr>`).join("")}</tbody></table></div>` : '<div class="empty-state">가입 신청이 없어요.</div>';
  $$('[data-approve]').forEach((button) => button.addEventListener("click", () => approveUser(button.dataset.approve)));
  $$('[data-reject]').forEach((button) => button.addEventListener("click", () => rejectUser(button.dataset.reject)));
}

function contactCell(phone, message) {
  if (!phone) return '<span class="contact-missing">미등록</span>';
  const href = `sms:${phone}?body=${encodeURIComponent(message)}`;
  return `<span class="contact-cell"><span>${escapeHTML(formatPhone(phone))}</span><a class="sms-link" href="${escapeHTML(href)}">문자</a></span>`;
}

async function approveUser(id) {
  try {
    await api(`/api/admin/users/${encodeURIComponent(id)}/approve`, { method: "PATCH" });
    users = await api("/api/admin/users");
    renderAdmin();
    showToast("교직원 계정을 승인했어요.");
  } catch (error) { showToast(error.message); }
}

async function rejectUser(id) {
  const user = users.find((item) => item.id === id);
  if (!user || !window.confirm(`${user.fullName} 계정을 삭제할까요? 제출 자료도 함께 삭제됩니다.`)) return;
  try {
    await api(`/api/admin/users/${encodeURIComponent(id)}`, { method: "DELETE" });
    users = await api("/api/admin/users");
    records = await api("/api/records");
    renderAdmin();
    showToast("계정을 삭제했어요.");
  } catch (error) { showToast(error.message); }
}

async function deleteRecord(id) {
  const record = records.find((item) => item.id === id);
  if (!record || !window.confirm(`${record.teacher_name} 선생님의 '${record.training}' 자료를 삭제할까요?`)) return;
  try {
    await api(`/api/records/${encodeURIComponent(id)}`, { method: "DELETE" });
    await refreshRecords();
    showToast("제출 자료를 삭제했어요.");
  } catch (error) { showToast(error.message); }
}

$$('[data-admin-tab]').forEach((tab) => tab.addEventListener("click", () => {
  activeAdminTab = tab.dataset.adminTab;
  $$("[data-admin-tab]").forEach((item) => {
    const selected = item === tab;
    item.classList.toggle("active", selected);
    item.setAttribute("aria-selected", String(selected));
  });
  $("#status-content").hidden = activeAdminTab !== "status";
  $("#onsite-content").hidden = activeAdminTab !== "onsite";
  $("#files-content").hidden = activeAdminTab !== "files";
  $("#individual-content").hidden = activeAdminTab !== "individual";
  $("#users-content").hidden = activeAdminTab !== "users";
  renderAdmin();
}));

$("#settings-open").addEventListener("click", () => {
  $("#school-input").value = config.schoolName;
  $("#departments-input").value = config.departments.join("\n");
  $("#staff-input").value = config.staff.map((person) => `${person.department}, ${person.name}`).join("\n");
  $("#trainings-input").value = config.trainings.join("\n");
  $("#onsite-trainings-input").value = config.onsiteTrainings.join("\n");
  $("#settings-modal").hidden = false;
});
function closeSettings() { $("#settings-modal").hidden = true; }
$("#settings-close").addEventListener("click", closeSettings);
$("#settings-cancel").addEventListener("click", closeSettings);
$("#settings-modal").addEventListener("click", (event) => { if (event.target.id === "settings-modal") closeSettings(); });
$("#settings-save").addEventListener("click", async () => {
  const schoolName = $("#school-input").value.trim();
  const departments = $("#departments-input").value.split("\n").map((item) => item.trim()).filter(Boolean);
  const staff = $("#staff-input").value.split("\n").map((line) => {
    const [department, ...nameParts] = line.split(",");
    return { department: department?.trim(), name: nameParts.join(",").trim() };
  }).filter((person) => person.department && person.name);
  const trainings = [...new Set($("#trainings-input").value.split("\n").map((item) => item.trim()).filter(Boolean))];
  const onsiteTrainings = [...new Set($("#onsite-trainings-input").value.split("\n").map((item) => item.trim()).filter(Boolean))];
  try {
    config = await api("/api/config", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ schoolName, departments, staff, trainings, onsiteTrainings }) });
    fillSchoolLists();
    await refreshRecords();
    closeSettings();
    showToast("학교 연수 목록을 서버 DB에 저장했어요.");
  } catch (error) { showToast(error.message); }
});

function exportWorkbook() {
  if (!window.XLSX) return showToast("엑셀 내보내기 기능을 불러오지 못했어요.");
  const workbook = XLSX.utils.book_new();
  const schoolStaff = getSchoolStaff();
  const completed = completedKeys();
  config.trainings.forEach((training, index) => {
    const rows = [["부서", "이름", "계정 상태", "이수 여부", "이수일", "연수 방법"]];
    schoolStaff.forEach((person) => {
      const account = person.account;
      const record = account && records.find((item) => item.user_id === account.id && (item.trainings?.includes(training) || item.training === training));
      rows.push([person.department, person.name, account ? "가입" : "미가입", account && completed.has(`${account.id}|${training}`) ? "이수" : "미이수", record?.completion_date || "", record?.method || ""]);
    });
    const sheet = XLSX.utils.aoa_to_sheet(rows);
    sheet["!cols"] = [{ wch: 17 }, { wch: 12 }, { wch: 14 }, { wch: 14 }, { wch: 16 }, { wch: 18 }];
    const name = `${String(index + 1).padStart(2, "0")}_${training}`.replace(/[\\/?*\[\]:]/g, " ").slice(0, 31);
    XLSX.utils.book_append_sheet(workbook, sheet, name);
  });
  const summary = [["부서", "이름", "계정 상태", ...config.trainings, "이수율"]];
  schoolStaff.forEach((person) => {
    const account = person.account;
    const count = config.trainings.filter((training) => account && completed.has(`${account.id}|${training}`)).length;
    summary.push([person.department, person.name, account ? "가입" : "미가입", ...config.trainings.map((training) => account && completed.has(`${account.id}|${training}`) ? "이수" : "미이수"), `${Math.round(count / config.trainings.length * 100)}%`]);
  });
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(summary), "전체 현황");
  const onsiteRows = [["부서", "이름", "계정 상태", ...config.onsiteTrainings]];
  const onsiteCompleted = new Set(records.filter((record) => record.method === "학교현장연수").flatMap((record) => (record.trainings || []).map((training) => `${record.user_id}|${training}`)));
  schoolStaff.forEach((person) => onsiteRows.push([person.department, person.name, person.account ? "가입" : "미가입", ...config.onsiteTrainings.map((training) => person.account && onsiteCompleted.has(`${person.account.id}|${training}`) ? "참석" : "미참석")]));
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(onsiteRows), "학교현장연수");
  const submissions = [["부서", "이름", "연수 항목", "개별 연수", "이수증에서 추출한 연수명", "이수일", "방식", "파일명"]];
  records.forEach((record) => submissions.push([record.department, record.teacher_name, record.trainings?.join(" · ") || "", record.individualTrainings?.join(" · ") || "", record.certificate_training_name || "", record.completion_date, record.method, record.file_name]));
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(submissions), "제출 내역");
  XLSX.writeFile(workbook, `${config.schoolName}_연수이수현황.xlsx`);
  showToast("연수별 시트가 있는 엑셀 파일을 내려받았어요.");
}
$("#export-excel").addEventListener("click", exportWorkbook);

$("#help-button").addEventListener("click", () => { $("#help-modal").hidden = false; });
$("#close-help").addEventListener("click", () => { $("#help-modal").hidden = true; });
$("#help-done").addEventListener("click", () => { $("#help-modal").hidden = true; });
$("#help-modal").addEventListener("click", (event) => { if (event.target.id === "help-modal") event.currentTarget.hidden = true; });
function closeCourseDetails() { $("#course-detail-modal").hidden = true; }
$("#course-detail-close").addEventListener("click", closeCourseDetails);
$("#course-detail-done").addEventListener("click", closeCourseDetails);
$("#course-detail-modal").addEventListener("click", (event) => { if (event.target.id === "course-detail-modal") closeCourseDetails(); });
window.addEventListener("keydown", (event) => { if (event.key === "Escape" && !$("#course-detail-modal").hidden) closeCourseDetails(); });

function renderStatusTable(completed, schoolStaff) {
  const trainings = config.trainings;
  const filtered = schoolStaff;
  $("#status-head").innerHTML = `<tr><th scope="col">부서</th><th scope="col">이름</th><th scope="col">계정</th>${trainings.map((training) => `<th scope="col" title="${escapeHTML(training)}">${escapeHTML(training.replace("교육", ""))}</th>`).join("")}<th scope="col">이수율</th><th scope="col">연락</th></tr>`;
  $("#remote-filter-count").textContent = `${filtered.length} / ${schoolStaff.length}명 표시`;
  $("#status-body").innerHTML = filtered.length ? filtered.map((person) => {
    const count = trainings.filter((training) => person.account && completed.has(`${person.account.id}|${training}`)).length;
    const cells = trainings.map((training) => person.account && completed.has(`${person.account.id}|${training}`) ? '<td><span class="status-pill complete">이수</span></td>' : '<td><span class="status-pill pending">미이수</span></td>').join("");
    const missing = trainings.filter((training) => !person.account || !completed.has(`${person.account.id}|${training}`));
    const message = missing.length ? `${config.schoolName} 연수 이수 안내: ${missing.join(", ")}의 이수 여부를 확인해 주세요.` : "";
    return `<tr><td>${escapeHTML(person.department)}</td><td>${escapeHTML(person.name)}</td><td>${accountStatusLabel(person.account)}</td>${cells}<td><strong>${Math.round(count / trainings.length * 100)}%</strong></td><td>${contactCell(person.account?.phone, message)}</td></tr>`;
  }).join("") : `<tr><td colspan="${trainings.length + 5}" class="empty-state">교직원 명단이 비어 있어요.</td></tr>`;
}

function renderOnsiteTable(schoolStaff) {
  const trainings = config.onsiteTrainings;
  const filtered = schoolStaff;
  const onsiteCompleted = new Set(records.filter((record) => record.method === "학교현장연수").flatMap((record) => (record.trainings || []).map((training) => `${record.user_id}|${training}`)));
  $("#onsite-filter-count").textContent = `${filtered.length} / ${schoolStaff.length}명 표시`;
  $("#onsite-head").innerHTML = `<tr><th scope="col">부서</th><th scope="col">이름</th><th scope="col">계정</th>${trainings.map((training) => `<th scope="col" title="${escapeHTML(training)}">${escapeHTML(training)}</th>`).join("")}<th scope="col">연락</th></tr>`;
  $("#onsite-body").innerHTML = filtered.length ? filtered.map((person) => {
    const cells = trainings.map((training) => person.account && onsiteCompleted.has(`${person.account.id}|${training}`) ? '<td><span class="status-pill complete">참석</span></td>' : '<td><span class="status-pill pending">미참석</span></td>').join("");
    const missing = trainings.filter((training) => !person.account || !onsiteCompleted.has(`${person.account.id}|${training}`));
    const message = missing.length ? `${config.schoolName} 학교현장연수 참석 안내: ${missing.join(", ")}에 참석해 주세요.` : "";
    return `<tr><td>${escapeHTML(person.department)}</td><td>${escapeHTML(person.name)}</td><td>${accountStatusLabel(person.account)}</td>${cells}<td>${contactCell(person.account?.phone, message)}</td></tr>`;
  }).join("") : `<tr><td colspan="${trainings.length + 4}" class="empty-state">교직원 명단이 비어 있어요.</td></tr>`;
}

function renderMaterials(target, items) {
  const filtered = items;
  $(target).innerHTML = filtered.length ? filtered.map((record) => {
    const linkedTrainings = [...(record.trainings || []), ...(record.individualTrainings || [])];
    const title = linkedTrainings.length > 3 ? `${record.trainings?.length || 0}개 필수 · ${record.individualTrainings?.length || 0}개 개별 연수` : linkedTrainings.join(" · ") || record.certificate_training_name || "필수 목록 연결 대기";
    const detail = record.method === "원격연수" ? `${record.trainings?.length || 0}개 필수 · ${record.individualTrainings?.length || 0}개 개별 · ${record.file_name}` : record.file_name;
    return `<div class="material-row"><div class="material-main"><span class="file-type ${record.method === "학교현장연수" ? "signature-type" : ""}">${record.method === "학교현장연수" ? "서명" : "PDF"}</span><span class="material-copy"><strong title="${escapeHTML(linkedTrainings.join(" · ") || title)}">${escapeHTML(title)}</strong><small title="${escapeHTML(record.certificate_training_name || "")}">${escapeHTML(detail)}</small></span></div><span class="material-person">${escapeHTML(record.department)} · ${escapeHTML(record.teacher_name)}</span><span class="material-date">${escapeHTML(record.completion_date)}</span><div class="material-actions"><a class="small-action" href="/api/records/${encodeURIComponent(record.id)}/preview" target="_blank" rel="noopener">보기</a><button class="small-action delete" type="button" data-delete="${escapeHTML(record.id)}">삭제</button></div></div>`;
  }).join("") : '<div class="empty-state">아직 제출한 자료가 없어요.</div>';
  $$(`${target} [data-delete]`).forEach((button) => button.addEventListener("click", () => deleteRecord(button.dataset.delete)));
}

function renderIndividualTrainings() {
  const rows = records.flatMap((record) => (record.individualTrainings || []).map((training) => ({ record, training })));
  $("#individual-list").innerHTML = rows.length ? rows.map(({ record, training }) => `<div class="material-row"><div class="material-main"><span class="file-type individual-type">개별</span><span class="material-copy"><strong title="${escapeHTML(training)}">${escapeHTML(training)}</strong><small>${escapeHTML(record.file_name)}</small></span></div><span class="material-person">${escapeHTML(record.department)} · ${escapeHTML(record.teacher_name)}</span><span class="material-date">${escapeHTML(record.completion_date)}</span><div class="material-actions"><a class="small-action" href="/api/records/${encodeURIComponent(record.id)}/preview" target="_blank" rel="noopener">이수증 보기</a></div></div>`).join("") : '<div class="empty-state">개별 연수로 기록된 제출 자료가 없어요.</div>';
}

function renderUsers() {
  const rows = [...users.filter((user) => user.status === "pending"), ...users.filter((user) => user.status === "active" && user.role === "teacher")];
  $("#users-list").innerHTML = rows.length ? `<div class="table-scroll"><table class="admin-users-table"><thead><tr><th>이름 / 이메일</th><th>부서</th><th>휴대폰</th><th>상태</th><th>관리</th></tr></thead><tbody>${rows.map((user) => `<tr class="${user.status === "pending" ? "pending-row" : ""}"><td>${escapeHTML(user.fullName)}<br><small>${escapeHTML(user.email)}</small></td><td>${escapeHTML(user.department)}</td><td>${contactCell(user.phone, `${user.fullName} 선생님, 연수 확인 계정 신청 관련 확인을 위해 연락드립니다.`)}</td><td>${user.status === "pending" ? "승인 대기" : "승인 완료"}</td><td>${user.status === "pending" ? `<button type="button" data-approve="${escapeHTML(user.id)}">승인</button><button class="reject" type="button" data-reject="${escapeHTML(user.id)}">거절</button>` : `<button class="reject" type="button" data-reject="${escapeHTML(user.id)}">계정 삭제</button>`}</td></tr>`).join("")}</tbody></table></div>` : '<div class="empty-state">가입 신청이 없어요.</div>';
  $$('[data-approve]').forEach((button) => button.addEventListener("click", () => approveUser(button.dataset.approve)));
  $$('[data-reject]').forEach((button) => button.addEventListener("click", () => rejectUser(button.dataset.reject)));
}

loadSession();
