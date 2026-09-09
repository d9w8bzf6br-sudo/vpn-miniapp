"""
VelocePN backend v2 — бот + HTTP API с базой данных.

Стек: aiogram 3.x + aiohttp + aiosqlite (SQLite — для старта достаточно,
позже можно перейти на Postgres, структура запросов останется похожей).

Реализовано:
  - Покупка тарифа (Базовый / Семейный) через Telegram Payments
  - Баланс: пополнение, промокоды, история операций
  - Подписка: срок действия, трафик, список устройств
  - initData валидируется на каждый запрос — без этого никто не может
    дёргать API от чужого имени

НЕ реализовано (заглушки, отмечены TODO):
  - Реальная выдача VLESS-ссылки через API панели 3x-ui — сейчас
    generate_vless_config() возвращает фейковую ссылку для демонстрации
  - Реальный подсчёт трафика с сервера — сейчас trafficUsedGb статичный
"""

import asyncio
import hashlib
import hmac
import json
import logging
import secrets
import uuid
from datetime import datetime, timedelta
from urllib.parse import parse_qsl

import aiosqlite
from aiohttp import web
from aiogram import Bot, Dispatcher, F
from aiogram.filters import CommandStart
from aiogram.types import (
    Message, LabeledPrice, PreCheckoutQuery, WebAppInfo,
    InlineKeyboardMarkup, InlineKeyboardButton,
)

logging.basicConfig(level=logging.INFO)
log = logging.getLogger("velocepn-bot")

# ---------- НАСТРОЙКИ ----------
BOT_TOKEN = "PASTE_YOUR_BOT_TOKEN_HERE"
PROVIDER_TOKEN = "PASTE_YOUR_PAYMENT_PROVIDER_TOKEN_HERE"
WEBAPP_URL = "https://your-username.github.io/vpn-miniapp/"
BACKEND_URL = "https://your-backend-domain.com"  # для ссылок на файлы
CURRENCY = "RUB"
DB_PATH = "velocepn.db"

BASE_PLANS = {
    "1m": {"title": "1 месяц", "price": 199, "days": 30, "traffic_gb": 500},
    "3m": {"title": "3 месяца", "price": 499, "days": 90, "traffic_gb": 750},
    "12m": {"title": "12 месяцев", "price": 1499, "days": 365, "traffic_gb": 1000},
}
DEVICE_LIMITS = {"basic": 2, "family": 5}

bot = Bot(token=BOT_TOKEN)
dp = Dispatcher()


# ================= БАЗА ДАННЫХ =================
async def init_db():
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute("""
            CREATE TABLE IF NOT EXISTS users (
                user_id INTEGER PRIMARY KEY,
                balance REAL DEFAULT 0,
                created_at TEXT
            )
        """)
        await db.execute("""
            CREATE TABLE IF NOT EXISTS subscriptions (
                user_id INTEGER PRIMARY KEY,
                plan_id TEXT,
                plan_title TEXT,
                plan_type TEXT,
                price INTEGER,
                traffic_limit_gb INTEGER,
                traffic_used_gb REAL DEFAULT 0,
                devices_limit INTEGER,
                expires_at TEXT
            )
        """)
        await db.execute("""
            CREATE TABLE IF NOT EXISTS devices (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER,
                name TEXT,
                platform TEXT,
                vless_link TEXT
            )
        """)
        await db.execute("""
            CREATE TABLE IF NOT EXISTS history (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER,
                title TEXT,
                amount REAL,
                type TEXT,   -- 'plus' | 'minus'
                date TEXT
            )
        """)
        await db.execute("""
            CREATE TABLE IF NOT EXISTS promo_codes (
                code TEXT PRIMARY KEY,
                amount REAL,
                max_uses INTEGER,
                used_count INTEGER DEFAULT 0
            )
        """)
        await db.execute("""
            CREATE TABLE IF NOT EXISTS orders (
                order_id TEXT PRIMARY KEY,
                user_id INTEGER,
                kind TEXT,        -- 'subscription' | 'topup'
                plan_id TEXT,
                plan_type TEXT,
                amount INTEGER,
                status TEXT       -- 'pending' | 'paid'
            )
        """)
        await db.commit()


async def get_or_create_user(db, user_id: int):
    cur = await db.execute("SELECT user_id FROM users WHERE user_id = ?", (user_id,))
    row = await cur.fetchone()
    if not row:
        await db.execute(
            "INSERT INTO users (user_id, balance, created_at) VALUES (?, 0, ?)",
            (user_id, datetime.utcnow().isoformat()),
        )
        await db.commit()


async def add_history(db, user_id: int, title: str, amount: float, htype: str):
    await db.execute(
        "INSERT INTO history (user_id, title, amount, type, date) VALUES (?, ?, ?, ?, ?)",
        (user_id, title, amount, htype, datetime.now().strftime("%d.%m.%Y, %H:%M")),
    )


# ================= ПРОВЕРКА initData =================
def validate_init_data(init_data: str, bot_token: str) -> dict | None:
    try:
        parsed = dict(parse_qsl(init_data, strict_parsing=True))
        received_hash = parsed.pop("hash", None)
        if not received_hash:
            return None
        data_check_string = "\n".join(f"{k}={v}" for k, v in sorted(parsed.items()))
        secret_key = hmac.new(b"WebAppData", bot_token.encode(), hashlib.sha256).digest()
        computed_hash = hmac.new(secret_key, data_check_string.encode(), hashlib.sha256).hexdigest()
        if not hmac.compare_digest(computed_hash, received_hash):
            return None
        user_raw = parsed.get("user")
        return json.loads(user_raw) if user_raw else {}
    except Exception as e:
        log.warning("initData validation failed: %s", e)
        return None


# ================= ГЕНЕРАЦИЯ VLESS (заглушка) =================
def generate_vless_config(user_id: int) -> str:
    """
    ЗАГЛУШКА. В реальном проекте нужно дёрнуть API панели 3x-ui:
      - создать нового клиента в нужном inbound
      - получить обратно готовую vless://... ссылку
    Пока возвращаем фейковую ссылку для демонстрации потока.
    """
    fake_uuid = str(uuid.uuid4())
    return f"vless://{fake_uuid}@your-server.com:443?security=reality&sni=example.com#VelocePN-{user_id}"


# ================= ХЕНДЛЕРЫ БОТА =================
@dp.message(CommandStart())
async def cmd_start(message: Message):
    kb = InlineKeyboardMarkup(inline_keyboard=[
        [InlineKeyboardButton(text="🔐 Открыть VelocePN", web_app=WebAppInfo(url=WEBAPP_URL))]
    ])
    await message.answer("Добро пожаловать в VelocePN!", reply_markup=kb)


@dp.pre_checkout_query()
async def process_pre_checkout(pre_checkout_query: PreCheckoutQuery):
    await pre_checkout_query.answer(ok=True)


@dp.message(F.successful_payment)
async def process_successful_payment(message: Message):
    payload = message.successful_payment.invoice_payload
    user_id = message.from_user.id

    async with aiosqlite.connect(DB_PATH) as db:
        cur = await db.execute("SELECT * FROM orders WHERE order_id = ?", (payload,))
        order = await cur.fetchone()
        if not order:
            log.error("Order %s not found!", payload)
            return
        _, _, kind, plan_id, plan_type, amount, _ = order

        await db.execute("UPDATE orders SET status = 'paid' WHERE order_id = ?", (payload,))
        await get_or_create_user(db, user_id)

        if kind == "topup":
            await db.execute("UPDATE users SET balance = balance + ? WHERE user_id = ?", (amount, user_id))
            await add_history(db, user_id, "Пополнение баланса", amount, "plus")
            await db.commit()
            await message.answer(f"Баланс пополнен на {amount} ₽ ✅")
            return

        # kind == "subscription"
        plan = BASE_PLANS[plan_id]
        price = plan["price"] * (2 if plan_type == "family" else 1)
        traffic = plan["traffic_gb"] * (2 if plan_type == "family" else 1)
        devices_limit = DEVICE_LIMITS[plan_type]
        expires_at = (datetime.now() + timedelta(days=plan["days"])).isoformat()

        await db.execute("""
            INSERT INTO subscriptions
                (user_id, plan_id, plan_title, plan_type, price, traffic_limit_gb, traffic_used_gb, devices_limit, expires_at)
            VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)
            ON CONFLICT(user_id) DO UPDATE SET
                plan_id=excluded.plan_id, plan_title=excluded.plan_title, plan_type=excluded.plan_type,
                price=excluded.price, traffic_limit_gb=excluded.traffic_limit_gb,
                devices_limit=excluded.devices_limit, expires_at=excluded.expires_at
        """, (user_id, plan_id, plan["title"], plan_type, price, traffic, devices_limit, expires_at))

        vless_link = generate_vless_config(user_id)
        await db.execute(
            "INSERT INTO devices (user_id, name, platform, vless_link) VALUES (?, ?, ?, ?)",
            (user_id, "Первое устройство", "—", vless_link),
        )
        await add_history(db, user_id, f"Оплата тарифа «{plan['title']}»", price, "minus")
        await db.commit()

    await bot.send_message(
        message.chat.id,
        f"Оплата прошла ✅\n\nВаша ссылка для приложения Happ:\n`{vless_link}`",
        parse_mode="Markdown",
    )


# ================= HTTP API =================
def require_user(request_body: dict):
    user = validate_init_data(request_body.get("initData", ""), BOT_TOKEN)
    if user is None:
        return None
    return user


async def api_create_invoice(request: web.Request):
    body = await request.json()
    user = require_user(body)
    if user is None:
        return web.json_response({"error": "invalid_init_data"}, status=403)

    plan_id = body.get("planId")
    plan_type = body.get("planType", "basic")
    plan = BASE_PLANS.get(plan_id)
    if not plan:
        return web.json_response({"error": "unknown_plan"}, status=400)

    price = plan["price"] * (2 if plan_type == "family" else 1)
    order_id = uuid.uuid4().hex

    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute(
            "INSERT INTO orders (order_id, user_id, kind, plan_id, plan_type, amount, status) VALUES (?, ?, 'subscription', ?, ?, ?, 'pending')",
            (order_id, user["id"], plan_id, plan_type, price),
        )
        await db.commit()

    invoice_link = await bot.create_invoice_link(
        title=f"{plan['title']} ({'Семейный' if plan_type == 'family' else 'Базовый'})",
        description="Подписка VelocePN",
        payload=order_id,
        provider_token=PROVIDER_TOKEN,
        currency=CURRENCY,
        prices=[LabeledPrice(label=plan["title"], amount=price * 100)],
    )
    return web.json_response({"invoiceLink": invoice_link, "orderId": order_id})


async def api_create_topup_invoice(request: web.Request):
    body = await request.json()
    user = require_user(body)
    if user is None:
        return web.json_response({"error": "invalid_init_data"}, status=403)

    amount = int(body.get("amount", 0))
    if amount <= 0:
        return web.json_response({"error": "invalid_amount"}, status=400)

    order_id = uuid.uuid4().hex
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute(
            "INSERT INTO orders (order_id, user_id, kind, plan_id, plan_type, amount, status) VALUES (?, ?, 'topup', NULL, NULL, ?, 'pending')",
            (order_id, user["id"], amount),
        )
        await db.commit()

    invoice_link = await bot.create_invoice_link(
        title="Пополнение баланса VelocePN",
        description=f"Пополнение на {amount} ₽",
        payload=order_id,
        provider_token=PROVIDER_TOKEN,
        currency=CURRENCY,
        prices=[LabeledPrice(label="Пополнение", amount=amount * 100)],
    )
    return web.json_response({"invoiceLink": invoice_link, "orderId": order_id})


async def api_order_status(request: web.Request):
    order_id = request.query.get("orderId")
    async with aiosqlite.connect(DB_PATH) as db:
        cur = await db.execute("SELECT status FROM orders WHERE order_id = ?", (order_id,))
        row = await cur.fetchone()
    if not row:
        return web.json_response({"error": "not_found"}, status=404)
    return web.json_response({"ready": row[0] == "paid"})


async def api_subscription(request: web.Request):
    init_data = request.query.get("initData", "")
    user = validate_init_data(init_data, BOT_TOKEN)
    if user is None:
        return web.json_response({"error": "invalid_init_data"}, status=403)

    async with aiosqlite.connect(DB_PATH) as db:
        cur = await db.execute("SELECT * FROM subscriptions WHERE user_id = ?", (user["id"],))
        sub = await cur.fetchone()
        if not sub:
            return web.json_response({"subscription": None})

        (_, plan_id, plan_title, plan_type, price, traffic_limit, traffic_used,
         devices_limit, expires_at) = sub

        cur = await db.execute("SELECT id, name, platform FROM devices WHERE user_id = ?", (user["id"],))
        devices = [{"id": r[0], "name": r[1], "platform": r[2]} for r in await cur.fetchall()]

    expires_dt = datetime.fromisoformat(expires_at)
    return web.json_response({
        "subscription": {
            "planTitle": f"{plan_title} ({'Семейный' if plan_type == 'family' else 'Базовый'})",
            "price": price,
            "expiresAtIso": expires_dt.isoformat(),
            "expiresAtFormatted": expires_dt.strftime("%d.%m.%Y"),
            "trafficUsedGb": traffic_used,
            "trafficLimitGb": traffic_limit,
            "devicesUsed": len(devices),
            "devicesLimit": devices_limit,
            "devices": devices,
        }
    })


async def api_delete_device(request: web.Request):
    device_id = request.match_info["device_id"]
    body = await request.json()
    user = require_user(body)
    if user is None:
        return web.json_response({"error": "invalid_init_data"}, status=403)

    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute("DELETE FROM devices WHERE id = ? AND user_id = ?", (device_id, user["id"]))
        await db.commit()
    return web.json_response({"success": True})


async def api_balance(request: web.Request):
    init_data = request.query.get("initData", "")
    user = validate_init_data(init_data, BOT_TOKEN)
    if user is None:
        return web.json_response({"error": "invalid_init_data"}, status=403)

    async with aiosqlite.connect(DB_PATH) as db:
        await get_or_create_user(db, user["id"])
        await db.commit()
        cur = await db.execute("SELECT balance FROM users WHERE user_id = ?", (user["id"],))
        balance = (await cur.fetchone())[0]

        cur = await db.execute(
            "SELECT title, amount, type, date FROM history WHERE user_id = ? ORDER BY id DESC LIMIT 30",
            (user["id"],),
        )
        history = [{"title": r[0], "amount": r[1], "type": r[2], "date": r[3]} for r in await cur.fetchall()]

    return web.json_response({"balance": balance, "history": history})


async def api_apply_promo(request: web.Request):
    body = await request.json()
    user = require_user(body)
    if user is None:
        return web.json_response({"error": "invalid_init_data"}, status=403)

    code = body.get("code", "").strip().upper()

    async with aiosqlite.connect(DB_PATH) as db:
        cur = await db.execute("SELECT amount, max_uses, used_count FROM promo_codes WHERE code = ?", (code,))
        row = await cur.fetchone()
        if not row:
            return web.json_response({"success": False, "error": "not_found"})

        amount, max_uses, used_count = row
        if used_count >= max_uses:
            return web.json_response({"success": False, "error": "limit_reached"})

        await get_or_create_user(db, user["id"])
        await db.execute("UPDATE users SET balance = balance + ? WHERE user_id = ?", (amount, user["id"]))
        await db.execute("UPDATE promo_codes SET used_count = used_count + 1 WHERE code = ?", (code,))
        await add_history(db, user["id"], f"Промокод {code}", amount, "plus")
        await db.commit()

    return web.json_response({"success": True, "amount": amount})


def create_app() -> web.Application:
    app = web.Application()

    async def cors_middleware(app, handler):
        async def middleware_handler(request):
            if request.method == "OPTIONS":
                return web.Response(headers={
                    "Access-Control-Allow-Origin": "*",
                    "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
                    "Access-Control-Allow-Headers": "Content-Type",
                })
            response = await handler(request)
            response.headers["Access-Control-Allow-Origin"] = "*"
            return response
        return middleware_handler

    app.middlewares.append(cors_middleware)

    app.router.add_post("/api/create-invoice", api_create_invoice)
    app.router.add_post("/api/create-topup-invoice", api_create_topup_invoice)
    app.router.add_get("/api/order-status", api_order_status)
    app.router.add_get("/api/subscription", api_subscription)
    app.router.add_delete("/api/devices/{device_id}", api_delete_device)
    app.router.add_get("/api/balance", api_balance)
    app.router.add_post("/api/apply-promo", api_apply_promo)

    return app


async def main():
    await init_db()

    app = create_app()
    runner = web.AppRunner(app)
    await runner.setup()
    site = web.TCPSite(runner, "0.0.0.0", 8080)
    await site.start()
    log.info("HTTP API запущен на :8080")

    await dp.start_polling(bot)


if __name__ == "__main__":
    asyncio.run(main())
