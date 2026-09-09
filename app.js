const tg = window.Telegram.WebApp;
tg.expand();
tg.ready();

// !!! Замените на адрес своего backend-сервера (см. backend/bot.py) !!!
const API_BASE = "https://your-backend-domain.com/api";

const PLANS = [
  { id: "1m", title: "1 месяц", desc: "Безлимитный трафик", price: 199 },
  { id: "3m", title: "3 месяца", desc: "Выгода 15%", price: 499 },
  { id: "12m", title: "12 месяцев", desc: "Выгода 40%", price: 1499 },
];

let selectedPlan = null;

const plansEl = document.getElementById("plans");
const statusEl = document.getElementById("status");
const configBlockEl = document.getElementById("configBlock");
const downloadLinkEl = document.getElementById("downloadLink");

function renderPlans() {
  plansEl.innerHTML = "";
  PLANS.forEach((plan) => {
    const card = document.createElement("div");
    card.className = "plan-card";
    card.dataset.id = plan.id;
    card.innerHTML = `
      <div class="plan-info">
        <span class="plan-title">${plan.title}</span>
        <span class="plan-desc">${plan.desc}</span>
      </div>
      <span class="plan-price">${plan.price} ₽</span>
    `;
    card.addEventListener("click", () => selectPlan(plan, card));
    plansEl.appendChild(card);
  });
}

function selectPlan(plan, cardEl) {
  selectedPlan = plan;
  document.querySelectorAll(".plan-card").forEach((el) => el.classList.remove("selected"));
  cardEl.classList.add("selected");

  tg.MainButton.setText(`Оплатить ${plan.price} ₽`);
  tg.MainButton.show();
}

function showStatus(text) {
  statusEl.textContent = text;
  statusEl.classList.remove("hidden");
}

tg.MainButton.onClick(async () => {
  if (!selectedPlan) return;

  tg.MainButton.showProgress();
  showStatus("Создаём счёт на оплату…");

  try {
    // 1. Просим backend создать invoice link через Telegram Bot API
    const res = await fetch(`${API_BASE}/create-invoice`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        initData: tg.initData, // backend обязан проверить подпись!
        planId: selectedPlan.id,
      }),
    });

    if (!res.ok) throw new Error("invoice_failed");
    const { invoiceLink, orderId } = await res.json();

    // 2. Открываем нативное окно оплаты Telegram
    tg.openInvoice(invoiceLink, async (status) => {
      tg.MainButton.hideProgress();

      if (status === "paid") {
        showStatus("Оплата прошла ✅ Генерируем ваш VPN-конфиг…");
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
});

// После оплаты backend генерирует конфиг асинхронно (в handler successful_payment),
// поэтому опрашиваем сервер, пока конфиг не будет готов.
async function pollForConfig(orderId, attempt = 0) {
  if (attempt > 15) {
    showStatus("Конфиг генерируется дольше обычного. Он придёт вам в чат с ботом.");
    return;
  }

  const res = await fetch(`${API_BASE}/order-status?orderId=${orderId}`);
  const data = await res.json();

  if (data.ready) {
    configBlockEl.classList.remove("hidden");
    downloadLinkEl.href = data.configUrl;
    statusEl.classList.add("hidden");
  } else {
    setTimeout(() => pollForConfig(orderId, attempt + 1), 2000);
  }
}

renderPlans();
