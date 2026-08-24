# Копилка — Telegram Mini App

Статический клиент Mini App для управления личным бюджетом. В браузере он работает как демо, а внутри Telegram получает тему и имя пользователя через Telegram Web Apps SDK.

## Подключение

1. Разместите папку на HTTPS-хостинге: Telegram не открывает `file://` и HTTP.
2. В [@BotFather](https://t.me/BotFather) создайте бота, затем в **Bot Settings → Menu Button → Configure menu button** укажите публичный HTTPS-адрес `index.html`.
3. Откройте чат с ботом и нажмите кнопку меню.

## Production

Пока данные хранятся локально в браузере Telegram и разделены по пользователям. Для синхронизации между устройствами нужен API и БД. На сервере проверяйте `Telegram.WebApp.initData` по HMAC с токеном бота; `initDataUnsafe` не является доверенной авторизацией.
