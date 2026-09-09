const tg = window.Telegram.WebApp;
tg.expand();
tg.ready();

// !!! Настройте под себя !!!
const API_BASE = "https://your-backend-domain.com/api";
const BOT_USERNAME = "your_bot_username"; // без @
const SUPPORT_USERNAME = "your_support_username"; // без @, куда пишут в поддержку

// ===== ТАРИФЫ =====
const BASE_PLANS = [
  { id: "1m", title: "1 месяц", price: 199 },
  { id: "3m", title: "3 месяца", price: 499 },
  { id: "12m", title: "12 месяцев", price: 1499 },
];

let planType = "basic"; // basic | family
let selectedPlan = null;
let countdownIntervalId = null;

// ================= НАВИГАЦИЯ =================
document.querySelectorAll(".tab-btn").forEach((btn) => {
  btn.addEventListener("click", () => switchView(btn.dataset.view));
});

function switchView(view) {
  document.querySelectorAll(".view").forEach((v) => v.classList.add("hidden"));
  document.getElementById(`view-${view}`).classList.remove("hidden");
  document.querySelectorAll(".tab-btn").forEach((b) => b.classList.remove("active"));
  document.querySelector(`.tab-btn[data-view="${view}"]`).classList.add("active");

  tg.MainButton.hide();
  if (countdownIntervalId) clearInterval(countdownIntervalId);

  if (view === "home") loadHome();
  if (view === "sub") loadSubscription();
  if (view === "balance") loadBalance();
  if (view === "profile") loadProfile();
}

// ================= ГЛАВНАЯ =================
async function loadHome() {
  const homeCard = document.getElementById("homeSubCard");
  const sub = await fetchSubscription();

  if (sub) {
    homeCard.innerHTML = `
      <div class="hs-status">✅ Подписка активна</div>
      <div class="hs-expiry">До ${sub.expiresAtFormatted}</div>
    `;
    document.getElementById("homeExtendPrice").textContent = "";
  } else {
    homeCard.innerHTML = `<div class="hs-empty">Подписка не активна</div>`;
  }
}

document.getElementById("homeExtendBtn").addEventListener("click", () => switchView("sub"));
document.getElementById("homeConnectBtn").addEventListener("click", () => switchView("sub"));

// ================= ПОДПИСКА =================
async function loadSubscription() {
  const sub = await fetchSubscription();
  const activeBlock = document.getElementById("subActiveBlock");
  const plansBlock = document.getElementById("subPlansBlock");

  if (sub) {
    activeBlock.classList.remove("hidden");
    plansBlock.classList.add("hidden");
    renderActiveSub(sub);
  } else {
    activeBlock.classList.add("hidden");
    plansBlock.classList.remove("hidden");
    renderPlans();
  }
}

function renderActiveSub(sub) {
  document.getElementById("subPlanTitle").textContent = sub.planTitle;
  document.getElementById("subPlanPrice").textContent = `${sub.price} ₽`;
  document.getElementById("countdownUntil").textContent = `Действует до: ${sub.expiresAtFormatted}`;

  document.getElementById("trafficValue").textContent = `${sub.trafficUsedGb} GB / ${sub.trafficLimitGb} GB`;
  document.getElementById("usageBarFill").style.width = `${Math.min(100, (sub.trafficUsedGb / sub.trafficLimitGb) * 100)}%`;
  document.getElementById("devicesValue").textContent = `${sub.devicesUsed} из ${sub.devicesLimit} подключено`;

  renderDevices(sub.devices || []);
  startCountdown(sub.expiresAtIso);
}

function startCountdown(expiresAtIso) {
  const el = document.getElementById("countdownTimer");
  const expiresAt = new Date(expiresAtIso).getTime();

  function tick() {
    const diff = expiresAt - Date.now();
    if (diff <= 0) {
      el.textContent = "Истекла";
      clearInterval(countdownIntervalId);
      return;
    }
    const d = Math.floor(diff / 86400000);
    const h = Math.floor((diff % 86400000) / 3600000);
    const m = Math.floor((diff % 3600000) / 60000);
    const s = Math.floor((diff % 60000) / 1000);
    el.textContent = `${d}дн ${h}ч ${m}м ${s}с`;
  }
  tick();
  countdownIntervalId = setInterval(tick, 1000);
}

document.getElementById("manageDevicesBtn").addEventListener("click", () => {
  document.getElementById("devicesManage").classList.toggle("hidden");
});

function renderDevices(devices) {
  const listEl = document.getElementById("devicesList");
  if (!devices.length) {
    listEl.innerHTML = `<div class="empty-note">Нет подключённых устройств</div>`;
    return;
  }
  listEl.innerHTML = devices.map((d) => `
    <div class="device-item">
      <div>
        <div class="d-name">${d.name}</div>
        <div class="d-sub">${d.platform}</div>
      </div>
      <button class="device-remove" data-id="${d.id}">Удалить</button>
    </div>
  `).join("");

  listEl.querySelectorAll(".device-remove").forEach((btn) => {
    btn.addEventListener("click", () => removeDevice(btn.dataset.id));
  });
}

// TODO backend: DELETE /api/devices/:id
async function removeDevice(deviceId) {
  try {
    await fetch(`${API_BASE}/devices/${deviceId}`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ initData: tg.initData }),
    });
    loadSubscription();
  } catch (err) {
    console.error(err);
  }
}

document.getElementById("extendBtn").addEventListener("click", () => {
  document.getElementById("subActiveBlock").classList.add("hidden");
  document.getElementById("subPlansBlock").classList.remove("hidden");
  renderPlans();
});
document.getElementById("changePlanBtn").addEventListener("click", () => {
  document.getElementById("subActiveBlock").classList.add("hidden");
  document.getElementById("subPlansBlock").classList.remove("hidden");
  renderPlans();
});

// ----- выбор тарифа -----
function planPrice(plan) {
  return planType === "family" ? plan.price * 2 : plan.price;
}

function renderPlans() {
  const plansEl = document.getElementById("plans");
  plansEl.innerHTML = "";
  BASE_PLANS.forEach((plan) => {
    const card = document.createElement("div");
    card.className = "plan-card";
    card.dataset.id = plan.id;
    card.innerHTML = `
      <div class="plan-info">
        <span class="plan-title">${plan.title}</span>
        <span class="plan-desc">${planType === "family" ? "До 5 устройств" : "До 2 устройств"}</span>
      </div>
      <span class="plan-price">${planPrice(plan)} ₽</span>
    `;
    card.addEventListener("click", () => selectPlan(plan, card));
    plansEl.appendChild(card);
  });
  selectedPlan = null;
  tg.MainButton.hide();
}

document.getElementById("planTypeToggle").querySelectorAll(".seg-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    planType = btn.dataset.type;
    document.querySelectorAll("#planTypeToggle .seg-btn").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    renderPlans();
  });
});

function selectPlan(plan, cardEl) {
  selectedPlan = plan;
  document.querySelectorAll(".plan-card").forEach((el) => el.classList.remove("selected"));
  cardEl.classList.add("selected");
  tg.MainButton.setText(`Оплатить ${planPrice(plan)} ₽`);
  tg.MainButton.show();
}

function showStatus(text) {
  const statusEl = document.getElementById("status");
  statusEl.textContent = text;
  statusEl.classList.remove("hidden");
}

let pendingTopupAmount = null;

tg.MainButton.onClick(async () => {
  if (!document.getElementById("view-sub").classList.contains("hidden") && selectedPlan) {
    await payForPlan();
  } else if (pendingTopupAmount) {
    await payTopup(pendingTopupAmount);
  }
});

async function payForPlan() {
  tg.MainButton.showProgress();
  showStatus("Создаём счёт на оплату…");
  try {
    const res = await fetch(`${API_BASE}/create-invoice`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ initData: tg.initData, planId: selectedPlan.id, planType }),
    });
    if (!res.ok) throw new Error("invoice_failed");
    const { invoiceLink, orderId } = await res.json();

    tg.openInvoice(invoiceLink, async (status) => {
      tg.MainButton.hideProgress();
      if (status === "paid") {
        showStatus("Оплата прошла ✅ Готовим доступ…");
        await pollForConfig(orderId);
      } else if (status === "cancelled") {
        showStatus("Оплата отменена.");
      } else {
        showStatus("Оплата не завершена: " + status);
      }
    });
  } catch (err) {
    tg.MainButton.hideProgress();
    showStatus("Ошибка: не удалось создать счёт. Попробуйте позже.");
    console.error(err);
  }
}

async function pollForConfig(orderId, attempt = 0) {
  if (attempt > 15) {
    showStatus("Готовим доступ дольше обычного — ссылка придёт в чат с ботом.");
    return;
  }
  const res = await fetch(`${API_BASE}/order-status?orderId=${orderId}`);
  const data = await res.json();
  if (data.ready) {
    showStatus("Готово ✅ Ссылка для Happ отправлена вам в чат.");
    loadSubscription();
  } else {
    setTimeout(() => pollForConfig(orderId, attempt + 1), 2000);
  }
}

// TODO backend: GET /api/subscription?initData=... -> null | {
//   planTitle, price, expiresAtIso, expiresAtFormatted,
//   trafficUsedGb, trafficLimitGb, devicesUsed, devicesLimit,
//   devices: [{id, name, platform}]
// }
async function fetchSubscription() {
  try {
    const res = await fetch(`${API_BASE}/subscription?initData=${encodeURIComponent(tg.initData)}`);
    if (!res.ok) throw new Error();
    const data = await res.json();
    return data.subscription || null;
  } catch {
    return null; // пока backend не готов — считаем, что подписки нет
  }
}

// ================= БАЛАНС =================
document.getElementById("topupBtn").addEventListener("click", () => {
  document.getElementById("topupOptions").classList.toggle("hidden");
  document.getElementById("promoBox").classList.add("hidden");
});
document.getElementById("promoBtn").addEventListener("click", () => {
  document.getElementById("promoBox").classList.toggle("hidden");
  document.getElementById("topupOptions").classList.add("hidden");
});

document.querySelectorAll(".topup-chip").forEach((chip) => {
  chip.addEventListener("click", () => {
    pendingTopupAmount = Number(chip.dataset.amount);
    tg.MainButton.setText(`Пополнить на ${pendingTopupAmount} ₽`);
    tg.MainButton.show();
  });
});

// TODO backend: POST /api/apply-promo { initData, code }
document.getElementById("promoApplyBtn").addEventListener("click", async () => {
  const code = document.getElementById("promoInput").value.trim();
  if (!code) return;
  try {
    const res = await fetch(`${API_BASE}/apply-promo`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ initData: tg.initData, code }),
    });
    const data = await res.json();
    if (data.success) {
      tg.HapticFeedback?.notificationOccurred("success");
      loadBalance();
    } else {
      tg.HapticFeedback?.notificationOccurred("error");
    }
  } catch (err) {
    console.error(err);
  }
});

async function payTopup(amount) {
  tg.MainButton.showProgress();
  try {
    const res = await fetch(`${API_BASE}/create-topup-invoice`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ initData: tg.initData, amount }),
    });
    if (!res.ok) throw new Error("topup_failed");
    const { invoiceLink } = await res.json();
    tg.openInvoice(invoiceLink, (status) => {
      tg.MainButton.hideProgress();
      if (status === "paid") loadBalance();
    });
  } catch (err) {
    tg.MainButton.hideProgress();
    console.error(err);
  }
}

// TODO backend: GET /api/balance?initData=... -> { balance, history: [{title, date, amount, type}] }
async function loadBalance() {
  try {
    const res = await fetch(`${API_BASE}/balance?initData=${encodeURIComponent(tg.initData)}`);
    if (!res.ok) throw new Error();
    const data = await res.json();
    renderBalance(data);
  } catch {
    document.getElementById("balanceAmount").textContent = "₽ 0.00";
    document.getElementById("historyList").innerHTML = `<div class="empty-note">История пока недоступна</div>`;
  }
}

function renderBalance(data) {
  document.getElementById("balanceAmount").textContent = `₽ ${Number(data.balance).toFixed(2)}`;
  const historyListEl = document.getElementById("historyList");
  if (!data.history || data.history.length === 0) {
    historyListEl.innerHTML = `<div class="empty-note">Операций пока нет</div>`;
    return;
  }
  historyListEl.innerHTML = data.history.map((h) => `
    <div class="history-item">
      <div>
        <div class="h-title">${h.title}</div>
        <div class="h-date">${h.date}</div>
      </div>
      <div class="h-amount ${h.type}">${h.type === "plus" ? "+" : "-"}${h.amount} ₽</div>
    </div>`).join("");
}

// ================= ПРОФИЛЬ =================
function loadProfile() {
  const user = tg.initDataUnsafe?.user;
  if (!user) return;
  document.getElementById("profileName").textContent = [user.first_name, user.last_name].filter(Boolean).join(" ") || "Пользователь";
  document.getElementById("profileUsername").textContent = user.username ? `@${user.username}` : "";
  document.getElementById("profileId").textContent = user.id;
  if (user.photo_url) document.getElementById("profileAvatar").src = user.photo_url;

  // TODO backend: реальная дата регистрации пользователя в вашей БД
  document.getElementById("profileJoined").textContent = "—";

  document.getElementById("referralLink").value = `https://t.me/${BOT_USERNAME}?start=ref_${user.id}`;
}

document.getElementById("copyReferralBtn").addEventListener("click", () => {
  const input = document.getElementById("referralLink");
  input.select();
  document.execCommand("copy");
  tg.HapticFeedback?.notificationOccurred("success");
});

// ================= ПОДДЕРЖКА =================
document.getElementById("supportBtn").addEventListener("click", () => {
  tg.openTelegramLink(`https://t.me/${SUPPORT_USERNAME}`);
});

// ================= INIT =================
loadHome();
