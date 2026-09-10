/* Telegram Web Apps integration. Works as a no-op in a normal browser. */
(function () {
  const webApp = window.Telegram && window.Telegram.WebApp;
  const root = document.documentElement;
  window.TG = { webApp, isTelegram: Boolean(webApp && webApp.initData), user: webApp?.initDataUnsafe?.user || null, storageKey: 'kopilka-data' };
  if (!webApp) return;
  webApp.ready(); webApp.expand(); webApp.disableVerticalSwipes?.();
  const applySafeArea = () => {
    for (const side of ['top','right','bottom','left']) {
      const device=Math.max(0,Number(webApp.safeAreaInset?.[side])||0);
      const content=Math.max(0,Number(webApp.contentSafeAreaInset?.[side])||0);
      root.style.setProperty(`--app-safe-${side}`, `${device+content}px`);
    }
    root.classList.toggle('tg-fullscreen',Boolean(webApp.isFullscreen));
  };
  applySafeArea();
  for (const event of ['safeAreaChanged','contentSafeAreaChanged','fullscreenChanged'])webApp.onEvent?.(event,applySafeArea);
  webApp.onEvent?.('fullscreenFailed',()=>{webApp.expand();applySafeArea()});
  if(window.TG.isTelegram && webApp.isVersionAtLeast?.('8.0') && !webApp.isFullscreen) {
    try { webApp.requestFullscreen?.(); } catch { webApp.expand(); }
  }
  webApp.setHeaderColor?.('bg_color'); webApp.setBackgroundColor?.('bg_color');
  const applyTheme = () => { const theme = webApp.themeParams || {}; root.style.setProperty('--tg-bg', theme.bg_color || '#f5f6fa'); root.style.setProperty('--tg-surface', theme.secondary_bg_color || '#ffffff'); root.style.setProperty('--tg-ink', theme.text_color || '#152036'); root.style.setProperty('--tg-link', theme.button_color || '#6756d9'); };
  applyTheme(); webApp.onEvent?.('themeChanged', applyTheme);
  const user = window.TG.user;
  if (user) { window.TG.storageKey = `kopilka-data-${user.id}`; document.getElementById('profileButton').textContent = `${user.first_name?.[0] || ''}${user.last_name?.[0] || ''}`.toUpperCase() || 'Я'; }
  webApp.BackButton?.onClick(() => { if (document.querySelector('.modal.open')) window.closeKopilkaModal?.(); else if (!document.getElementById('home').classList.contains('active')) window.showKopilkaScreen?.('home'); else webApp.close(); });
})();
