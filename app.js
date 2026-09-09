const tg = window.Telegram.WebApp;
tg.expand();
tg.ready();

// !!! Замените на адрес своего backend-сервера !!!
const API_BASE = "https://your-backend-domain.com/api";
const BOT_USERNAME = "your_bot_username"; // без @, для реферальной ссылки

// ===== ТАРИФЫ =====
// Цены для family считаются как price * 2 (по вашей формуле).
const BASE_PLANS = [
  { id: "1m", title: "1 месяц", price: 199 },
  { id: "3m", title: "3 месяца", price: 499 },
  { id: "12m", title: "12 месяцев", price: 1499 },
];

let planType = "basic"; // basic | family
let selectedPlan = null;

// ===== ЭЛЕМЕНТЫ =====
const plansEl = document.getElementById("plans");
const statusEl = document.getElementById("status");
const planTypeToggle = document.getElementById("planTypeToggle");

const balanceAmountEl = document.getElementById("balanceAmount");
const topupBtn = document.getElementById("topupBtn");
const topupOptionsEl = document.getElementById("topupOptions");
const historyListEl = document.getElementById("historyList");

const profileAvatarEl = document.getElementById("profileAvatar");
const profileNameEl = document.getElementById("profileName");
const activeSubEl = document.getElementById("activeSub");
const devicesListEl = document.getElementById("devicesList");
const ordersListEl = document.getElementById("ordersList");
const referralLinkEl = document.getElementById("referralLink");
const copyReferralBtn = document.getElementById("copyReferralBtn");

// ================= НАВИГАЦИЯ ПО ВКЛАДКАМ =================
document.querySelectorAll(".tab-btn").forEach((btn) => {
  btn.addEventListener("click", () => switchView(btn.dataset.view));
});

function switchView(view) {
  document.querySelectorAll(".view").forEach((v) => v.classList.add("hidden"));
  document.getElementById(`view-${view}`).classList.remove("hidden");

  document.querySelectorAll(".tab-btn").forEach((b) => b.classList.remove("active"));
  document.querySelector(`.tab-btn[data-view="${view}"]`).classList.add("active");

  tg.MainButton.hide();

  if (view === "plans" && selectedPlan) {
    tg.MainButton.setText(`Оплатить ${planPrice(selectedPlan)} ₽`);
    tg.MainButton.show();
  }
  if (view === "balance") loadBalance();
  if (view === "profile") loadProfile();
}

// ================= ТАРИФЫ =================
function planPrice(plan) {
  return planType === "family" ? plan.price * 2 : plan.price;
}

function renderPlans() {
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

planTypeToggle.querySelectorAll(".seg-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    planType = btn.dataset.type;
    planTypeToggle.querySelectorAll(".seg-btn").forEach((b) => b.classList.remove("active"));
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
  statusEl.textContent = text;
  statusEl.classList.remove("hidden");
}

tg.MainButton.onClick(async () => {
  // Если открыта вкладка "Баланс" — MainButton используется для пополнения (см. ниже),
  // иначе — это оплата тарифа.
  if (!document.getElementById("view-plans").classList.contains("hidden") && selectedPlan) {
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
      body: JSON.stringify({
        initData: tg.initData,
        planId: selectedPlan.id,
        planType: planType, // "basic" | "family" — backend сам считает цену x2
      }),
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
    showStatus("Готовим доступ дольше обычного — конфиг придёт вам в чат с ботом.");
    return;
  }
  const res = await fetch(`${API_BASE}/order-status?orderId=${orderId}`);
  const data = await res.json();

  if (data.ready) {
    showStatus("Готово ✅ Ссылка для Happ отправлена вам в чат с ботом.");
  } else {
    setTimeout(() => pollForConfig(orderId, attempt + 1), 2000);
  }
}

// ================= БАЛАНС =================
let pendingTopupAmount = null;

topupBtn.addEventListener("click", () => {
  topupOptionsEl.classList.toggle("hidden");
});

topupOptionsEl.querySelectorAll(".topup-chip").forEach((chip) => {
  chip.addEventListener("click", () => {
    pendingTopupAmount = Number(chip.dataset.amount);
    tg.MainButton.setText(`Пополнить на ${pendingTopupAmount} ₽`);
    tg.MainButton.show();
  });
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
      if (status === "paid") {
        loadBalance(); // обновляем баланс и историю
      }
    });
  } catch (err) {
    tg.MainButton.hideProgress();
    console.error(err);
  }
}

// TODO backend: реализовать GET /api/balance?initData=... ->
// { balance, history: [{title, date, amount, type: "plus"|"minus"}] }
async function loadBalance() {
  try {
    const res = await fetch(`${API_BASE}/balance?initData=${encodeURIComponent(tg.initData)}`);
    if (!res.ok) throw new Error();
    const data = await res.json();
    renderBalance(data);
  } catch {
    // Пока backend не готов — просто ничего не показываем поверх плейсхолдера
    balanceAmountEl.textContent = "— ₽";
    historyListEl.innerHTML = `<div class="empty-note">История пока недоступна</div>`;
  }
}

function renderBalance(data) {
  balanceAmountEl.textContent = `${data.balance} ₽`;
  if (!data.history || data.history.length === 0) {
    historyListEl.innerHTML = `<div class="empty-note">Операций пока нет</div>`;
    return;
  }
  historyListEl.innerHTML = data.history
    .map(
      (h) => `
      <div class="history-item">
        <div>
          <div class="h-title">${h.title}</div>
          <div class="h-date">${h.date}</div>
        </div>
        <div class="h-amount ${h.type}">${h.type === "plus" ? "+" : "-"}${h.amount} ₽</div>
      </div>`
    )
    .join("");
}

// ================= ПРОФИЛЬ =================
function renderProfileHeader() {
  const user = tg.initDataUnsafe?.user;
  if (!user) return;
  profileNameEl.textContent = [user.first_name, user.last_name].filter(Boolean).join(" ") || user.username || "Пользователь";
  if (user.photo_url) profileAvatarEl.src = user.photo_url;

  referralLinkEl.value = `https://t.me/${BOT_USERNAME}?start=ref_${user.id}`;
}

copyReferralBtn.addEventListener("click", () => {
  referralLinkEl.select();
  document.execCommand("copy");
  tg.HapticFeedback?.notificationOccurred("success");
});

// TODO backend: реализовать GET /api/profile?initData=... ->
// { subscription: {planTitle, expiresAt, devicesUsed, devicesLimit} | null,
//   devices: [{name, status}], orders: [{title, date, amount}] }
async function loadProfile() {
  try {
    const res = await fetch(`${API_BASE}/profile?initData=${encodeURIComponent(tg.initData)}`);
    if (!res.ok) throw new Error();
    const data = await res.json();
    renderProfile(data);
  } catch {
    activeSubEl.innerHTML = `<div class="sub-empty">Подписка не активна</div>`;
    devicesListEl.innerHTML = `<div class="empty-note">Нет подключённых устройств</div>`;
    ordersListEl.innerHTML = `<div class="empty-note">Заказов пока нет</div>`;
  }
}

function renderProfile(data) {
  if (data.subscription) {
    const s = data.subscription;
    activeSubEl.innerHTML = `
      <div class="sub-active">
        <div class="sub-plan">${s.planTitle}</div>
        <div class="sub-expiry">Действует до ${s.expiresAt}</div>
        <div class="sub-devices">Устройства: ${s.devicesUsed} / ${s.devicesLimit}</div>
      </div>`;
  } else {
    activeSubEl.innerHTML = `<div class="sub-empty">Подписка не активна</div>`;
  }

  devicesListEl.innerHTML = (data.devices && data.devices.length)
    ? data.devices.map((d) => `
        <div class="device-item">
          <span class="d-name">${d.name}</span>
          <span class="d-status">${d.status}</span>
        </div>`).join("")
    : `<div class="empty-note">Нет подключённых устройств</div>`;

  ordersListEl.innerHTML = (data.orders && data.orders.length)
    ? data.orders.map((o) => `
        <div class="history-item">
          <div>
            <div class="h-title">${o.title}</div>
            <div class="h-date">${o.date}</div>
          </div>
          <div class="h-amount minus">${o.amount} ₽</div>
        </div>`).join("")
    : `<div class="empty-note">Заказов пока нет</div>`;
}

// ================= INIT =================
renderPlans();
renderProfileHeader();
