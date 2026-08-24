# Копилка — Telegram Mini App

Статический клиент Mini App для управления личным бюджетом. В браузере он работает как демо, а внутри Telegram получает тему и имя пользователя через Telegram Web Apps SDK.

## Подключение

1. Разместите папку на HTTPS-хостинге: Telegram не открывает `file://` и HTTP.
2. В [@BotFather](https://t.me/BotFather) создайте бота, затем в **Bot Settings → Menu Button → Configure menu button** укажите публичный HTTPS-адрес `index.html`.
3. Откройте чат с ботом и нажмите кнопку меню.

## Production

Пока данные хранятся локально в браузере Telegram и разделены по пользователям. Для синхронизации между устройствами нужен API и БД. На сервере проверяйте `Telegram.WebApp.initData` по HMAC с токеном бота; `initDataUnsafe` не является доверенной авторизацией.

## API и база данных (Cloudflare D1)

В проект добавлены `worker.js`, `schema.sql` и `wrangler.jsonc`. Worker проверяет подпись Telegram `initData`, а затем сохраняет финансовый профиль пользователя в D1. Токен бота не попадает в клиентский код или Git.

1. Установите Wrangler и выполните вход в Cloudflare:

   ```bash
   npm install -g wrangler
   wrangler login
   ```

2. Создайте базу и скопируйте её `database_id` из ответа:

   ```bash
   wrangler d1 create kopilka-db
   ```

3. Вставьте этот ID вместо `REPLACE_WITH_D1_DATABASE_ID` в `wrangler.jsonc`, затем примените схему:

   ```bash
   wrangler d1 execute kopilka-db --remote --file=schema.sql
   ```

4. Добавьте токен созданного в BotFather бота как секрет и опубликуйте Worker:

   ```bash
   wrangler secret put BOT_TOKEN
   wrangler deploy
   ```

После этого Mini App будет загружать и сохранять данные через `/api/state`. В браузерном режиме она продолжает работать локально; синхронизация включается только в Telegram.
