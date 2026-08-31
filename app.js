const defaults = {
  income: 0,
  categories: [
    {id:'food',type:'expense',emoji:'🛒',name:'Продукты',color:'#7664dd'}, {id:'transport',type:'expense',emoji:'🚗',name:'Транспорт',color:'#52b6d2'}, {id:'cafe',type:'expense',emoji:'🍔',name:'Кафе',color:'#ed9b55'}, {id:'fun',type:'expense',emoji:'🎮',name:'Развлечения',color:'#ed7282'},
    {id:'salary',type:'income',emoji:'💼',name:'Зарплата',color:'#1aaa85'}, {id:'freelance',type:'income',emoji:'💻',name:'Фриланс',color:'#1aaa85'}, {id:'investment',type:'income',emoji:'📈',name:'Инвестиции',color:'#1aaa85'}
  ],
  goals: [],
  transactions: [],
  onboarding: { openingBalanceHandled: false }
};
const $ = s => document.querySelector(s);
const storageKey = window.TG?.storageKey || 'kopilka-data';
let state = JSON.parse(localStorage.getItem(storageKey) || 'null') || structuredClone(defaults);
let selectedPlanMonth = monthKey(new Date()), categoryTab = 'expense', historyFilter = 'all', analyticsPeriod = 'current', analyticsSelectedBucketKey = '', remoteReady = false, syncTimer, stateSaveQueue = Promise.resolve();
let plannedPayments = [], plannedPaymentsLoading = false, plannedPaymentsReady = false, plannedPaymentsUnavailable = false, pendingPaymentCompletion = null;
let plannedPaymentsForecast = null, plannedPaymentsForecastLoading = false, plannedPaymentsForecastReady = false, plannedPaymentsForecastUnavailable = false;
let paymentUrlIntent = null;
const money = n => new Intl.NumberFormat('ru-RU').format(Math.round(n || 0)) + ' ₽';
const haptic = () => window.Telegram?.WebApp?.HapticFeedback?.notificationOccurred?.('success');
function monthKey(value) { const d = value instanceof Date ? value : new Date(value + 'T12:00:00'); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`; }
function dateLabel(value) { return value ? `до ${new Date(value+'T12:00:00').toLocaleDateString('ru-RU',{month:'long',year:'numeric'})}` : 'Без срока'; }
function nowFields() { const now=new Date(); return {date:`${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}`,time:now.toTimeString().slice(0,5)}; }
function getCategory(id) { return state.categories.find(c => c.id === id); }
function getGoal(id) { return state.goals.find(g => String(g.id) === String(id)); }
function activeCategories(type) { return state.categories.filter(c => c.type === type && !c.archived); }
function getPlan(key=selectedPlanMonth, create=true) { if (!state.plans[key] && create) state.plans[key] = { incomeTarget: 0, budgets: {}, spent: {} }; return state.plans[key]; }
function planCategories() { const plan=getPlan(); return activeCategories('expense').filter(c => Object.hasOwn(plan.budgets,c.id)); }
function openingBalance() { return state.transactions.filter(t=>t.type==='opening_balance').reduce((sum,t)=>sum+Number(t.amount||0),0); }
function expenses() { return state.transactions.filter(t=>t.type==='expense').reduce((sum,t)=>sum+Number(t.amount||0),0); }
function goalNet() { return state.transactions.filter(t=>t.type==='goal_deposit'||t.type==='goal_withdrawal').reduce((sum,t)=>sum+(t.type==='goal_deposit'?t.amount:-t.amount),0); }
function availableNow() { return openingBalance() + state.income - expenses() - goalNet(); }
function allocated() { return Object.values(getPlan().budgets).reduce((sum,n)=>sum+Number(n||0),0); }
function reserved() { const plan=getPlan(); return Object.keys(plan.budgets).reduce((sum,id)=>sum+Math.max(0,Number(plan.budgets[id]||0)-Number(plan.spent[id]||0)),0); }
function normalizeState() {
  state.income ??= 0; state.categories ??=[]; state.goals ??=[]; state.transactions ??=[]; state.plans ??={};
  const hasOpeningBalanceFlag=Boolean(state.onboarding&&typeof state.onboarding==='object'&&Object.hasOwn(state.onboarding,'openingBalanceHandled'));
  if(!state.onboarding||typeof state.onboarding!=='object')state.onboarding={};
  // Existing users had no onboarding flag before this release, so do not interrupt
  // them with the first-launch question.
  if(!hasOpeningBalanceFlag)state.onboarding.openingBalanceHandled=true;
  state.categories.forEach(c=>{ c.type ??= ['salary','freelance','investment'].includes(c.id)?'income':'expense'; });
  defaults.categories.filter(c=>c.type==='income'&&!state.categories.some(x=>x.id===c.id)).forEach(c=>state.categories.push(structuredClone(c)));
  const current=monthKey(new Date());
  if (!state.plans[current]) { const legacy={incomeTarget:state.planIncome||state.income,budgets:{},spent:{}}; state.categories.filter(c=>c.type==='expense'&&c.inPlan!==false&&Number(c.plan)>0).forEach(c=>{legacy.budgets[c.id]=Number(c.plan)}); state.plans[current]=legacy; }
  state.transactions.forEach(t=>{t.time??='';});
  rebuildLedgerTotals();
}
function rebuildLedgerTotals(){
  // History is the source of truth. Old versions stored category totals separately,
  // which left phantom expenses after a history record was deleted.
  state.income=0;
  state.categories.filter(c=>c.type==='expense').forEach(c=>c.spent=0);
  Object.values(state.plans).forEach(plan=>plan.spent={});
  state.transactions.forEach(t=>{
    const amount=Number(t.amount||0);
    if(t.type==='income') state.income+=amount;
    if(t.type==='expense'){
      const category=getCategory(t.category); if(category)category.spent+=amount;
      const plan=getPlan(monthKey(t.date)); plan.spent[t.category]=(plan.spent[t.category]||0)+amount;
    }
  });
}
normalizeState();
function setSyncStatus(message='', error=false) { const el=$('#syncStatus'); if(!el)return; el.textContent=message; el.classList.toggle('error',error); }
const canSync=()=>Boolean(window.TG?.isTelegram&&window.TG.webApp?.initData);
async function apiFetch(path, options={}) {
  const headers = new Headers(options.headers || {});
  if (canSync()) headers.set('authorization', `tma ${window.TG.webApp.initData}`);
  const response = await fetch(path, {...options, headers});
  let payload = null;
  try { payload = await response.json(); } catch {}
  if (!response.ok) throw new Error(payload?.error || payload?.message || 'Не удалось выполнить запрос');
  return payload;
}
async function saveRemote(){const snapshot=JSON.stringify({state});const write=async()=>{try{const response=await fetch('/api/state',{method:'PUT',headers:{'content-type':'application/json','authorization':`tma ${window.TG.webApp.initData}`},body:snapshot});if(!response.ok)throw Error();setSyncStatus('Сохранено');setTimeout(()=>setSyncStatus(),1800);return true}catch{setSyncStatus('Нет синхронизации',true);return false}};stateSaveQueue=stateSaveQueue.then(write,write);return stateSaveQueue}
async function saveRemoteNow(){if(!canSync())return false;clearTimeout(syncTimer);return saveRemote()}
function save(){localStorage.setItem(storageKey,JSON.stringify(state));if(remoteReady&&canSync()){clearTimeout(syncTimer);syncTimer=setTimeout(saveRemote,500)}}
async function hydrateRemote(){
  if(!canSync())return;
  setSyncStatus('Загрузка…');
  try{
    const response=await fetch('/api/state',{headers:{authorization:`tma ${window.TG.webApp.initData}`}});
    if(!response.ok)throw Error();
    const payload=await response.json();
    if(payload.state&&typeof payload.state==='object'){state=payload.state;normalizeState();render()}
    remoteReady=true;
    if(!state.onboarding?.openingBalanceHandled)openOpeningBalanceModal(true);
    else save();
    setSyncStatus('Синхронизировано');
    setTimeout(()=>setSyncStatus(),1800);
  }catch{remoteReady=true;setSyncStatus('Нет синхронизации',true)}
}

// Planned payments live in their own API/table. They are deliberately not added to
// `state`, because `state` is the financial ledger that is synchronised as a whole.
const paymentStorageKey = `${storageKey}-planned-payments`;
const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[char]));
const localTimeZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
const cadenceLabel = cadence => ({weekly:'Каждую неделю',monthly:'Каждый месяц',yearly:'Каждый год'}[cadence] || 'По расписанию');
function epochMilliseconds(value) { const number=Number(value); if(Number.isFinite(number)) return number<200000000000 ? number*1000 : number; const parsed=Date.parse(value); return Number.isFinite(parsed)?parsed:Number.NaN; }
function localDateInput(value) { const date=new Date(epochMilliseconds(value)); if(Number.isNaN(date.getTime())) return nowFields().date; return `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}`; }
function localTimeInput(value, fallback='09:00') { const date=new Date(epochMilliseconds(value)); if(Number.isNaN(date.getTime())) return fallback; return `${String(date.getHours()).padStart(2,'0')}:${String(date.getMinutes()).padStart(2,'0')}`; }
function toLocalEpoch(date, time) { const value=new Date(`${date}T${time || '09:00'}`); return Number.isFinite(value.getTime())?value.getTime():Date.now(); }
function normalizePayment(payment) { return {...payment,amount:Number(payment.amount||0),next_reminder_at:epochMilliseconds(payment.next_reminder_at),active:!(payment.active===false||Number(payment.active)===0)}; }
function readLocalPayments() { try { const items=JSON.parse(localStorage.getItem(paymentStorageKey)||'[]'); return Array.isArray(items)?items.map(normalizePayment):[]; } catch { return []; } }
function writeLocalPayments() { localStorage.setItem(paymentStorageKey,JSON.stringify(plannedPayments)); }
function nextPaymentTime(payment, mode='advance') { const base=new Date(Math.max(Date.now(),epochMilliseconds(payment.next_reminder_at)||Date.now())); if(mode==='postpone') { base.setDate(base.getDate()+1); return base.getTime(); } if(payment.cadence==='weekly') base.setDate(base.getDate()+7); else if(payment.cadence==='yearly') base.setFullYear(base.getFullYear()+1); else base.setMonth(base.getMonth()+1); return base.getTime(); }
function safeSpendingCutoff() { const now=new Date(); return new Date(now.getFullYear(),now.getMonth()+1,1).getTime(); }
function safeSpendingUntilLabel(cutoff=safeSpendingCutoff()) { return `до ${new Date(cutoff-1).toLocaleDateString('ru-RU',{day:'numeric',month:'long'})}`; }
function nextLocalForecastPaymentTime(payment, timestamp) {
  const current=new Date(timestamp),[hour,minute]=(payment.time_local||localTimeInput(timestamp,'09:00')).split(':').map(Number),anchorDay=Number(payment.anchor_day)||current.getDate();
  if(payment.cadence==='weekly') return new Date(current.getFullYear(),current.getMonth(),current.getDate()+7,hour,minute).getTime();
  if(payment.cadence==='yearly') { const year=current.getFullYear()+1,month=current.getMonth(); return new Date(year,month,Math.min(anchorDay,new Date(year,month+1,0).getDate()),hour,minute).getTime(); }
  const year=current.getFullYear(),month=current.getMonth()+1;
  return new Date(year,month,Math.min(anchorDay,new Date(year,month+1,0).getDate()),hour,minute).getTime();
}
function localPaymentForecast(until=safeSpendingCutoff(), now=Date.now()) {
  const byCategory={}, occurrences=[];
  sortedPayments().forEach(payment=>{
    let occurrence=epochMilliseconds(payment.next_reminder_at), guard=0;
    if(!Number.isFinite(occurrence)||occurrence>=until)return;
    // A missed reminder is one unresolved payment, not every missed weekly/monthly interval.
    if(occurrence<=now) {
      occurrences.push({category_id:payment.category_id,amount:Number(payment.amount||0)});
      do { const next=nextLocalForecastPaymentTime(payment,occurrence); if(next<=occurrence)break; occurrence=next; guard+=1; } while(occurrence<=now&&guard<5200);
    }
    while(occurrence<until&&guard<5220) {
      occurrences.push({category_id:payment.category_id,amount:Number(payment.amount||0)});
      const next=nextLocalForecastPaymentTime(payment,occurrence); if(next<=occurrence)break; occurrence=next; guard+=1;
    }
  });
  occurrences.forEach(item=>{byCategory[item.category_id]=(byCategory[item.category_id]||0)+item.amount});
  return {total:occurrences.reduce((sum,item)=>sum+item.amount,0),byCategory,count:occurrences.length};
}
function normalizePaymentForecast(payload) {
  const source=payload?.by_category&&typeof payload.by_category==='object'?payload.by_category:{};
  const byCategory=Object.fromEntries(Object.entries(source).map(([id,value])=>[id,Math.max(0,Number(value)||0)]));
  return {total:Math.max(0,Number(payload?.total)||0),byCategory,count:Math.max(0,Number(payload?.occurrence_count)||0)};
}
async function loadPlannedPaymentsForecast() {
  const until=safeSpendingCutoff();
  plannedPaymentsForecastLoading=true; plannedPaymentsForecastUnavailable=false; renderSafeSpending();
  if(!canSync()) {
    plannedPaymentsForecast=localPaymentForecast(until); plannedPaymentsForecastReady=true; plannedPaymentsForecastLoading=false; renderSafeSpending(); return;
  }
  try {
    plannedPaymentsForecast=normalizePaymentForecast(await apiFetch(`/api/planned-payments/forecast?until=${encodeURIComponent(until)}`));
    plannedPaymentsForecastReady=true;
  } catch {
    plannedPaymentsForecast=null; plannedPaymentsForecastReady=true; plannedPaymentsForecastUnavailable=true;
  } finally {
    plannedPaymentsForecastLoading=false; renderSafeSpending();
  }
}
function paymentDateText(payment) { const date=new Date(epochMilliseconds(payment.next_reminder_at)); if(Number.isNaN(date.getTime())) return 'Дата напоминания не задана'; const day=date.toLocaleDateString('ru-RU',{day:'numeric',month:'long'}); return `Следующее: ${day} · ${payment.time_local || localTimeInput(payment.next_reminder_at)}`; }
function paymentStatusText(payment) { return payment.open_reminder_id ? 'Ждёт вашего решения' : 'Запланирован'; }
function paymentCategory(payment) { return getCategory(payment.category_id) || {emoji:'💳',name:'Категория удалена',color:'#8f98a9'}; }
function sortedPayments() { return [...plannedPayments].filter(payment=>payment.active!==false).sort((a,b)=>epochMilliseconds(a.next_reminder_at)-epochMilliseconds(b.next_reminder_at)); }
function setPlannedPaymentsNotice(message='', tone='') { const notice=$('#plannedPaymentsNotice'); if(!notice)return; notice.textContent=message; notice.hidden=!message; notice.className=`inline-notice${tone?` ${tone}`:''}`; }
function setPlannedPaymentFormNotice(message='', tone='error') { const notice=$('#plannedPaymentFormNotice'); if(!notice)return; notice.textContent=message; notice.hidden=!message; notice.className=`inline-notice form-notice${message?` ${tone}`:''}`; }
function plannedPaymentCard(payment, compact=false) {
  const category=paymentCategory(payment), id=escapeHtml(payment.id), reminderId=escapeHtml(payment.open_reminder_id||'');
  const title=escapeHtml(payment.title), categoryName=escapeHtml(category.name), categoryEmoji=escapeHtml(category.emoji||'💳');
  if(compact) return `<button class="planned-preview-card" type="button" data-go="payments"><span class="planned-payment-icon">${categoryEmoji}</span><span class="planned-preview-copy"><b>${title}</b><small>${paymentDateText(payment)}</small></span><strong>${money(payment.amount)}</strong><span class="planned-preview-chevron">›</span></button>`;
  const actions=payment.open_reminder_id
    ? `<div class="planned-payment-actions"><button class="payment-complete" type="button" data-planned-action="complete" data-planned-payment-id="${id}" data-reminder-id="${reminderId}">Провести в Копилке</button><button type="button" data-planned-action="postpone" data-planned-payment-id="${id}" data-reminder-id="${reminderId}">Отложить</button><button type="button" data-planned-action="skip" data-planned-payment-id="${id}" data-reminder-id="${reminderId}">Пропустить</button></div>`
    : '<p class="planned-payment-waiting">Telegram напомнит о платеже в назначенное время.</p>';
  return `<article class="planned-payment-card">
    <div class="planned-payment-card-top"><span class="planned-payment-icon">${categoryEmoji}</span><div class="planned-payment-copy"><b>${title}</b><small>${categoryName} · ${paymentDateText(payment)}</small></div><strong>${money(payment.amount)}</strong><button class="planned-payment-edit" type="button" data-edit-planned-payment="${id}" aria-label="Изменить напоминание">✎</button></div>
    <div class="planned-payment-meta"><span class="payment-status${payment.open_reminder_id?' due':''}">${paymentStatusText(payment)}</span><span>${escapeHtml(cadenceLabel(payment.cadence))}</span></div>
    ${actions}
  </article>`;
}
function renderPlannedPayments() {
  renderSafeSpending();
  const upcoming=$('#upcomingPayments'), list=$('#plannedPaymentsList'); if(!upcoming||!list)return;
  const payments=sortedPayments();
  if(plannedPaymentsLoading&&!plannedPaymentsReady) { upcoming.innerHTML='<p class="hint">Загружаем напоминания…</p>'; list.innerHTML='<p class="hint">Загружаем напоминания…</p>'; return; }
  upcoming.innerHTML=payments.length?payments.slice(0,3).map(payment=>plannedPaymentCard(payment,true)).join(''):'<button class="empty-planned-payments" type="button" data-go="payments">Добавьте напоминание о регулярном платеже</button>';
  list.innerHTML=payments.length?payments.map(payment=>plannedPaymentCard(payment)).join(''):'<div class="empty-planned-payments-card"><b>Плановых платежей пока нет</b><p>Создайте напоминание, чтобы не забыть о важных оплатах.</p><button class="text-button" type="button" id="emptyAddPlannedPayment">Добавить</button></div>';
}
function currentMonthPlanForSafeSpending() {
  return state.plans?.[monthKey(new Date())] || {budgets:{},spent:{}};
}
function safeSpendingDetails(forecast) {
  const plan=currentMonthPlanForSafeSpending(), paymentByCategory=forecast?.byCategory||{}, remainingByCategory={};
  Object.keys(plan.budgets||{}).forEach(id=>{
    remainingByCategory[id]=Math.max(0,Number(plan.budgets[id]||0)-Number(plan.spent?.[id]||0));
  });
  const budgetExtra=Object.entries(remainingByCategory).reduce((sum,[id,remaining])=>sum+Math.max(0,remaining-Number(paymentByCategory[id]||0)),0);
  const planned=Math.max(0,Number(forecast?.total||0)), available=availableNow(), goalReserve=Math.max(0,goalNet());
  return {available,planned,budgetExtra,goalReserve,free:available-planned-budgetExtra};
}
function renderSafeSpending() {
  const card=$('#safeSpendingCard'); if(!card)return;
  const title=$('#safeSpendingTitle'),value=$('#safeSpendingValue'),subtitle=$('#safeSpendingSubtitle'),breakdown=$('#safeSpendingBreakdown'),note=$('#safeSpendingNote'),link=$('#safeSpendingLink');
  const waitingForPayments=plannedPaymentsLoading&&!plannedPaymentsReady;
  const waitingForForecast=plannedPaymentsForecastLoading&&!plannedPaymentsForecastReady;
  card.classList.remove('negative','unavailable');
  if(waitingForPayments||waitingForForecast||(!plannedPaymentsReady&&!plannedPaymentsForecastReady)) {
    title.textContent='Рассчитываем свободную сумму'; value.textContent='…'; subtitle.textContent='Проверяем план и напоминания до конца месяца.';
    breakdown.innerHTML='<div class="safe-spending-loading">Это займёт несколько секунд.</div>'; note.textContent=''; link.hidden=true; return;
  }
  if(plannedPaymentsUnavailable||plannedPaymentsForecastUnavailable) {
    card.classList.add('unavailable'); title.textContent='Не удалось учесть напоминания'; value.textContent='—';
    subtitle.textContent='Проверьте подключение и откройте приложение ещё раз.';
    breakdown.innerHTML='<div class="safe-spending-loading">Свободную сумму пока нельзя подтвердить.</div>';
    note.textContent='Баланс и операции не изменились.'; link.hidden=false; link.textContent='Открыть напоминания'; return;
  }
  const forecast=canSync()?plannedPaymentsForecast:localPaymentForecast(), details=safeSpendingDetails(forecast), until=safeSpendingUntilLabel();
  const noReserves=!details.planned&&!details.budgetExtra;
  if(details.free<0) { title.textContent='Свободных денег не хватает'; subtitle.textContent=`Чтобы покрыть планы и напоминания ${until}, не хватает ${money(Math.abs(details.free))}.`; card.classList.add('negative'); }
  else if(details.free===0&&details.available===0&&noReserves) { title.textContent='Пока нет свободных денег'; subtitle.textContent='Добавьте стартовый баланс или первый доход.'; }
  else if(details.free===0) { title.textContent='Весь остаток уже распределён'; subtitle.textContent=`Планы и напоминания ${until} покрывают весь доступный остаток.`; }
  else if(noReserves) { title.textContent='Можно свободно потратить'; subtitle.textContent=`Планов и напоминаний ${until} пока нет.`; }
  else { title.textContent='Можно свободно потратить'; subtitle.textContent=`После планов и напоминаний ${until}.`; }
  value.textContent=money(details.free);
  breakdown.innerHTML=`
    <div class="safe-spending-row"><span>Доступно сейчас</span><b>${money(details.available)}</b></div>
    <div class="safe-spending-row deduction"><span>Напоминания ${until}</span><b>−${money(details.planned)}</b></div>
    <div class="safe-spending-row deduction"><span>Резерв по бюджету</span><b>−${money(details.budgetExtra)}</b></div>
    ${details.goalReserve?`<div class="safe-spending-row context"><span>Уже в целях <small>уже исключено из доступного</small></span><b>${money(details.goalReserve)}</b></div>`:''}
    <div class="safe-spending-divider"></div>
    <div class="safe-spending-row result"><span>Свободно потратить</span><b>${money(details.free)}</b></div>`;
  note.textContent='Это прогноз: деньги не списываются автоматически. Напоминания, уже покрытые бюджетом, дважды не учитываются.';
  link.hidden=false; link.textContent=details.planned?'Посмотреть напоминания':'Добавить напоминание';
}
function paymentUrlIntentFromLocation() { const params=new URLSearchParams(window.location.search); const paymentId=params.get('payment'); return paymentId?{paymentId,reminderId:params.get('reminder')||''}:null; }
function clearPaymentUrlIntent() { try { const url=new URL(window.location.href); url.searchParams.delete('payment'); url.searchParams.delete('reminder'); window.history.replaceState({},'',`${url.pathname}${url.search}${url.hash}`); } catch {} }
function consumePaymentUrlIntent() { if(!paymentUrlIntent)return; const payment=plannedPayments.find(item=>String(item.id)===String(paymentUrlIntent.paymentId)); if(!payment)return; const intent=paymentUrlIntent; paymentUrlIntent=null; clearPaymentUrlIntent(); showScreen('payments'); openPlannedPaymentExpense(payment.id,intent.reminderId); }
async function loadPlannedPayments() {
  plannedPaymentsLoading=true; plannedPaymentsUnavailable=false; renderPlannedPayments();
  if(!canSync()) { plannedPayments=readLocalPayments(); plannedPaymentsReady=true; plannedPaymentsLoading=false; renderPlannedPayments(); await loadPlannedPaymentsForecast(); consumePaymentUrlIntent(); return; }
  try { const payload=await apiFetch('/api/planned-payments'); plannedPayments=Array.isArray(payload?.payments)?payload.payments.map(normalizePayment):[]; plannedPaymentsReady=true; }
  catch(error) { if(!plannedPaymentsReady)plannedPayments=[]; plannedPaymentsReady=true; plannedPaymentsUnavailable=true; setPlannedPaymentsNotice(`Не удалось загрузить напоминания: ${error.message}`, 'error'); }
  finally { plannedPaymentsLoading=false; renderPlannedPayments(); }
  await loadPlannedPaymentsForecast();
  consumePaymentUrlIntent();
}
function fillPlannedPaymentCategories(selected) {
  const select=$('#plannedPaymentCategory'); const categories=activeCategories('expense').slice(); const current=getCategory(selected);
  if(current&&!categories.some(category=>category.id===current.id))categories.unshift(current);
  select.disabled=!categories.length;
  select.innerHTML=categories.length?categories.map(category=>`<option value="${escapeHtml(category.id)}" ${category.id===selected?'selected':''}>${escapeHtml(category.emoji)} ${escapeHtml(category.name)}</option>`).join(''):'<option value="">Нет активных категорий расходов</option>';
}
function openPlannedPaymentModal(id='') {
  const payment=id?plannedPayments.find(item=>String(item.id)===String(id)):null;
  if(!payment&&!activeCategories('expense').length) { setPlannedPaymentsNotice('Сначала создайте хотя бы одну категорию расходов.', 'error'); return; }
  const form=$('#plannedPaymentForm'); form.reset(); setPlannedPaymentFormNotice();
  $('#plannedPaymentId').value=payment?.id||''; $('#plannedPaymentModalTitle').textContent=payment?'Изменить напоминание':'Новый плановый платёж';
  $('#plannedPaymentTitle').value=payment?.title||''; $('#plannedPaymentAmount').value=payment?.amount||''; fillPlannedPaymentCategories(payment?.category_id);
  $('#plannedPaymentFrequency').value=payment?.cadence||'monthly'; $('#plannedPaymentDate').value=payment?localDateInput(payment.next_reminder_at):nowFields().date; $('#plannedPaymentTime').value=payment?.time_local||localTimeInput(payment?.next_reminder_at,'09:00'); $('#deletePlannedPayment').hidden=!payment; openModal('plannedPaymentModal');
}
function paymentPayloadFromForm() { const date=$('#plannedPaymentDate').value,time=$('#plannedPaymentTime').value; return {title:$('#plannedPaymentTitle').value.trim(),amount:Number($('#plannedPaymentAmount').value),category_id:$('#plannedPaymentCategory').value,cadence:$('#plannedPaymentFrequency').value,time_local:time,timezone:localTimeZone(),next_reminder_at:toLocalEpoch(date,time)}; }
async function activatePaymentNotifications() {
  if(!canSync())return;
  try { await apiFetch('/api/notifications/activate',{method:'POST'}); }
  catch { setPlannedPaymentsNotice('Напоминание сохранено. Уведомления в Telegram будут доступны после настройки бота.', 'warning'); }
}
async function savePlannedPayment() {
  const id=$('#plannedPaymentId').value,payload=paymentPayloadFromForm(),submit=$('#plannedPaymentForm button[type="submit"]');
  if(!payload.title||!payload.amount||!payload.category_id) { setPlannedPaymentFormNotice('Заполните название, сумму и категорию.'); return; }
  submit.disabled=true; setPlannedPaymentFormNotice();
  try {
    if(canSync()) { await apiFetch(id?`/api/planned-payments/${encodeURIComponent(id)}`:'/api/planned-payments',{method:id?'PUT':'POST',headers:{'content-type':'application/json'},body:JSON.stringify(payload)}); closeModal(); await loadPlannedPayments(); setPlannedPaymentsNotice('Напоминание сохранено. Баланс не изменился.'); await activatePaymentNotifications(); }
    else { const payment=normalizePayment({id:id||`local-payment-${Date.now()}`,...payload,active:true}); if(id)plannedPayments=plannedPayments.map(item=>String(item.id)===String(id)?payment:item); else plannedPayments.unshift(payment); writeLocalPayments(); closeModal(); renderPlannedPayments(); setPlannedPaymentsNotice('Напоминание сохранено только в этом браузере. В Telegram оно будет синхронизироваться между устройствами.'); }
    haptic();
  } catch(error) { setPlannedPaymentFormNotice(error.message || 'Не удалось сохранить напоминание.'); }
  finally { submit.disabled=false; }
}
async function deletePlannedPayment() {
  const id=$('#plannedPaymentId').value,payment=plannedPayments.find(item=>String(item.id)===String(id)); if(!payment||!confirm(`Удалить напоминание «${payment.title}»?`))return;
  try { if(canSync()) { await apiFetch(`/api/planned-payments/${encodeURIComponent(id)}`,{method:'DELETE'}); closeModal(); await loadPlannedPayments(); } else { plannedPayments=plannedPayments.filter(item=>String(item.id)!==String(id)); writeLocalPayments(); closeModal(); renderPlannedPayments(); } setPlannedPaymentsNotice('Напоминание удалено.'); haptic(); }
  catch(error) { setPlannedPaymentFormNotice(error.message || 'Не удалось удалить напоминание.'); }
}
async function performPlannedPaymentAction(action, id, reminderId='') {
  const payment=plannedPayments.find(item=>String(item.id)===String(id)); if(!payment)return;
  if(action==='complete') { openPlannedPaymentExpense(id,reminderId); return; }
  const question=action==='skip'?'Пропустить этот платёж? Деньги списаны не будут.':'Отложить напоминание на завтра?'; if(!confirm(question))return;
  try {
    if(canSync()) { await apiFetch(`/api/planned-payments/${encodeURIComponent(id)}/${action}`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(reminderId?{reminder_id:reminderId}:{})}); await loadPlannedPayments(); }
    else { payment.next_reminder_at=nextPaymentTime(payment,action); payment.open_reminder_id=''; payment.open_reminder_occurrence_at=null; writeLocalPayments(); renderPlannedPayments(); }
    setPlannedPaymentsNotice(action==='skip'?'Платёж пропущен. Баланс не изменился.':'Напоминание перенесено на завтра.'); haptic();
  } catch(error) { setPlannedPaymentsNotice(error.message || 'Не удалось обновить напоминание.', 'error'); }
}
function openPlannedPaymentExpense(id, reminderId='') {
  const payment=plannedPayments.find(item=>String(item.id)===String(id)); if(!payment)return;
  openOperation('expense'); $('#operationTitle').textContent='Провести платёж'; $('#operationAmount').value=payment.amount||''; $('#operationComment').value=payment.title||'';
  if(activeCategories('expense').some(category=>category.id===payment.category_id)) $('#operationCategory').value=payment.category_id;
  pendingPaymentCompletion={paymentId:payment.id,reminderId:reminderId||payment.open_reminder_id||''};
  $('#operationContext').textContent='После сохранения расход попадёт в историю, а напоминание будет отмечено выполненным.'; $('#operationContext').hidden=false;
}
async function completePlannedPaymentAfterOperation(completion) {
  try {
    if(canSync()) { const ledgerSaved=await saveRemoteNow(); if(!ledgerSaved) { setPlannedPaymentsNotice('Расход сохранён на устройстве, но не синхронизирован. Напоминание оставлено открытым.', 'error'); return; } await apiFetch(`/api/planned-payments/${encodeURIComponent(completion.paymentId)}/complete`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(completion.reminderId?{reminder_id:completion.reminderId}:{})}); await loadPlannedPayments(); }
    else { const payment=plannedPayments.find(item=>String(item.id)===String(completion.paymentId)); if(payment) { payment.next_reminder_at=nextPaymentTime(payment); payment.open_reminder_id=''; payment.open_reminder_occurrence_at=null; writeLocalPayments(); renderPlannedPayments(); } }
    setPlannedPaymentsNotice('Расход сохранён, напоминание отмечено выполненным.');
  } catch(error) { setPlannedPaymentsNotice(`Расход сохранён, но напоминание не обновилось: ${error.message}`, 'error'); }
}
function applyOperation(t, direction) {
  const amount=Number(t.amount||0)*direction;
  if(t.type==='income') state.income += amount;
  if(t.type==='expense') { const c=getCategory(t.category); if(c)c.spent=Math.max(0,Number(c.spent||0)+amount); const plan=getPlan(monthKey(t.date)); plan.spent[t.category]=Math.max(0,Number(plan.spent[t.category]||0)+amount); }
  if(t.type==='goal_deposit'||t.type==='goal_withdrawal') { const goal=getGoal(t.goalId); const multiplier=t.type==='goal_deposit'?1:-1; if(goal)goal.current=Math.max(0,Number(goal.current||0)+amount*multiplier); }
}
function operationTarget(t){
  if(t.type==='opening_balance')return {emoji:'🏁',name:'Начальный баланс'};
  if(t.type==='goal_deposit'||t.type==='goal_withdrawal'){const g=getGoal(t.goalId);return {emoji:g?.emoji||'🎯',name:g?.title||'Цель'}}
  const c=getCategory(t.category);return {emoji:c?.emoji||'💳',name:c?.name||'Операция'};
}
function transactionHtml(t){
  const target=operationTarget(t),opening=t.type==='opening_balance',sign=opening||['income','goal_withdrawal'].includes(t.type)?'+':'−';
  const kind=opening?'opening':t.type==='income'?'income':t.type==='goal_withdrawal'?'income':'expense';
  const label=opening?'Начальный баланс':t.type==='goal_deposit'?'Пополнение цели':t.type==='goal_withdrawal'?'Снятие с цели':target.name;
  const date=new Date(t.date+'T12:00:00').toLocaleDateString('ru-RU',{day:'numeric',month:'short'});
  const controls=opening
    ? `<button class="edit-transaction" data-edit-opening-balance="${t.id}" aria-label="Изменить стартовый баланс">✎</button>`
    : `<button class="edit-transaction" data-edit-operation="${t.id}" aria-label="Изменить операцию">✎</button><button class="delete-transaction" data-delete-transaction="${t.id}" aria-label="Удалить операцию">×</button>`;
  return `<div class="transaction${opening?' opening-transaction':''}"><span class="transaction-icon">${target.emoji}</span><div><div class="transaction-title">${opening?label:t.comment||label}</div><div class="transaction-meta">${opening?'Старт учёта':label} · ${date}${t.time?' · '+t.time:''}</div></div><span class="transaction-amount ${kind}">${sign}${money(t.amount)}</span>${controls}</div>`
}
function renderHistory(){const types=historyFilter==='income'?['income','goal_withdrawal']:historyFilter==='expense'?['expense','goal_deposit']:null,list=types?state.transactions.filter(t=>types.includes(t.type)):state.transactions;$('#historyList').innerHTML=list.length?list.map((t,i)=>`${i===0||t.date!==list[i-1].date?`<div class="history-date">${new Date(t.date+'T12:00:00').toLocaleDateString('ru-RU',{day:'numeric',month:'long'})}</div>`:''}${transactionHtml(t)}`).join(''):'<p class="hint">Операций этого типа пока нет.</p>';document.querySelectorAll('[data-history-filter]').forEach(button=>button.classList.toggle('selected',button.dataset.historyFilter===historyFilter))}
function localDay(value) { const date=new Date(`${value}T12:00:00`); return Number.isNaN(date.getTime())?null:date; }
function addLocalDays(date, days) { return new Date(date.getFullYear(),date.getMonth(),date.getDate()+days,12); }
function analyticsDateRangeLabel(start, end) {
  const lastDay=addLocalDays(end,-1);
  const options={day:'numeric',month:'long'};
  if(start.getFullYear()===lastDay.getFullYear()&&start.getMonth()===lastDay.getMonth()) return `${start.getDate()}–${lastDay.toLocaleDateString('ru-RU',options)}`;
  return `${start.toLocaleDateString('ru-RU',options)} — ${lastDay.toLocaleDateString('ru-RU',{...options,year:'numeric'})}`;
}
function analyticsBounds() {
  const now=new Date(), today=new Date(now.getFullYear(),now.getMonth(),now.getDate(),12), currentStart=new Date(now.getFullYear(),now.getMonth(),1,12), currentEnd=addLocalDays(today,1);
  let start=currentStart, end=currentEnd, previousStart=new Date(now.getFullYear(),now.getMonth()-1,1,12), previousEnd, eyebrow='ТЕКУЩИЙ МЕСЯЦ', chartTitle='По неделям';
  const daysInPreviousMonth=new Date(now.getFullYear(),now.getMonth(),0).getDate();
  previousEnd=new Date(now.getFullYear(),now.getMonth()-1,Math.min(today.getDate(),daysInPreviousMonth)+1,12);
  if(analyticsPeriod==='previous') { start=new Date(now.getFullYear(),now.getMonth()-1,1,12); end=currentStart; previousStart=new Date(now.getFullYear(),now.getMonth()-2,1,12); previousEnd=start; eyebrow='ПРОШЛЫЙ МЕСЯЦ'; }
  if(analyticsPeriod==='quarter') {
    start=new Date(now.getFullYear(),now.getMonth()-2,1,12);
    previousEnd=new Date(start);
    previousStart=addLocalDays(start,-Math.round((end-start)/86400000));
    eyebrow='ПОСЛЕДНИЕ 3 МЕСЯЦА'; chartTitle='По месяцам';
  }
  return {start,end,previousStart,previousEnd,eyebrow,chartTitle};
}
function transactionsForAnalytics(start, end) {
  return state.transactions.filter(transaction=>{
    if(!['income','expense'].includes(transaction.type)) return false;
    const date=localDay(transaction.date);
    return date&&date>=start&&date<end;
  });
}
function analyticsTotals(transactions) {
  return transactions.reduce((totals,transaction)=>{
    const amount=Number(transaction.amount||0);
    if(transaction.type==='income') totals.income+=amount;
    if(transaction.type==='expense') totals.expense+=amount;
    return totals;
  },{income:0,expense:0});
}
function analyticsBuckets(bounds, transactions) {
  const buckets=[];
  if(analyticsPeriod==='quarter') {
    for(let cursor=new Date(bounds.start.getFullYear(),bounds.start.getMonth(),1,12);cursor<bounds.end;cursor=new Date(cursor.getFullYear(),cursor.getMonth()+1,1,12)) {
      const next=new Date(cursor.getFullYear(),cursor.getMonth()+1,1,12);
      buckets.push({start:cursor,end:next<bounds.end?next:bounds.end,label:cursor.toLocaleDateString('ru-RU',{month:'short'}).replace('.',''),income:0,expense:0});
    }
  } else {
    for(let cursor=new Date(bounds.start);cursor<bounds.end;cursor=addLocalDays(cursor,7)) {
      const next=addLocalDays(cursor,7), end=next<bounds.end?next:bounds.end, last=addLocalDays(end,-1);
      buckets.push({start:cursor,end,label:`${cursor.getDate()}–${last.getDate()}`,income:0,expense:0});
    }
  }
  transactions.forEach(transaction=>{
    const date=localDay(transaction.date), bucket=buckets.find(item=>date>=item.start&&date<item.end);
    if(bucket) bucket[transaction.type]+=Number(transaction.amount||0);
  });
  return buckets;
}
function comparisonChange(current, previous, kind) {
  if(!previous) return current?{label:'Новый',tone:'neutral'}:{label:'Нет данных',tone:'neutral'};
  const delta=Math.round((current-previous)/previous*100);
  if(!delta) return {label:'Без изменений',tone:'neutral'};
  const improved=kind==='expense'?delta<0:delta>0;
  return {label:`${delta>0?'+':''}${delta}%`,tone:improved?'good':'attention'};
}
function operationCountLabel(count) {
  const value=Math.abs(Number(count)||0)%100, last=value%10;
  if(value>10&&value<20) return 'операций';
  if(last===1) return 'операция';
  if(last>=2&&last<=4) return 'операции';
  return 'операций';
}
function analyticsBucketKey(bucket) {
  return `${bucket.start.getFullYear()}-${String(bucket.start.getMonth()+1).padStart(2,'0')}-${String(bucket.start.getDate()).padStart(2,'0')}`;
}
function renderAnalyticsChart(bounds, transactions) {
  const buckets=analyticsBuckets(bounds,transactions), maximum=Math.max(1,...buckets.flatMap(bucket=>[bucket.income,bucket.expense]));
  const hasData=buckets.some(bucket=>bucket.income||bucket.expense);
  const selectedBucket=buckets.find(bucket=>analyticsBucketKey(bucket)===analyticsSelectedBucketKey);
  if(!selectedBucket) analyticsSelectedBucketKey='';
  $('#analyticsChartTitle').textContent=bounds.chartTitle;
  $('#analyticsChart').innerHTML=buckets.map(bucket=>{
    const incomeHeight=bucket.income?Math.max(5,Math.round(bucket.income/maximum*100)):0;
    const expenseHeight=bucket.expense?Math.max(5,Math.round(bucket.expense/maximum*100)):0;
    const key=analyticsBucketKey(bucket), selected=key===analyticsSelectedBucketKey;
    return `<button type="button" class="analytics-chart-group ${selected?'selected':''}" data-analytics-bucket="${key}" aria-pressed="${selected}" aria-label="${escapeHtml(`${bucket.label}: доходы ${money(bucket.income)}, расходы ${money(bucket.expense)}`)}"><span class="analytics-chart-bars"><i class="analytics-chart-bar income" style="height:${incomeHeight}%"></i><i class="analytics-chart-bar expense" style="height:${expenseHeight}%"></i></span></button>`;
  }).join('');
  $('#analyticsChartLabels').innerHTML=buckets.map(bucket=>`<span class="${analyticsBucketKey(bucket)===analyticsSelectedBucketKey?'selected':''}">${escapeHtml(bucket.label)}</span>`).join('');
  $('#analyticsEmptyChart').hidden=hasData;
  $('#analyticsChartHint').textContent=analyticsPeriod==='quarter'?'Нажмите на столбец месяца, чтобы увидеть точные суммы.':'Нажмите на столбцы недели, чтобы увидеть точные суммы.';
  $('#analyticsChartHint').hidden=Boolean(selectedBucket);
  $('#analyticsChartDetail').hidden=!selectedBucket;
  if(selectedBucket) $('#analyticsChartDetail').innerHTML=`<strong>${escapeHtml(analyticsDateRangeLabel(selectedBucket.start,selectedBucket.end))}</strong><div><span>Доходы <b>${money(selectedBucket.income)}</b></span><span>Расходы <b>${money(selectedBucket.expense)}</b></span></div>`;
}
function renderAnalyticsComparison(bounds, totals, previousTotals) {
  const previousLabel=analyticsDateRangeLabel(bounds.previousStart,bounds.previousEnd);
  const incomeChange=comparisonChange(totals.income,previousTotals.income,'income');
  const expenseChange=comparisonChange(totals.expense,previousTotals.expense,'expense');
  $('#analyticsComparison').innerHTML=`<p class="analytics-comparison-period">По сравнению с ${escapeHtml(previousLabel)}</p><div class="analytics-comparison-grid"><article><span>Доходы</span><strong>${money(totals.income)}</strong><small><b class="${incomeChange.tone}">${incomeChange.label}</b> · было ${money(previousTotals.income)}</small></article><article><span>Расходы</span><strong>${money(totals.expense)}</strong><small><b class="${expenseChange.tone}">${expenseChange.label}</b> · было ${money(previousTotals.expense)}</small></article></div>`;
}
function renderAnalyticsBudgetWarning(bounds, transactions) {
  const host=$('#analyticsBudgetWarning');
  if(analyticsPeriod==='quarter') {
    host.innerHTML='<article class="analytics-budget-note"><strong>Контроль бюджета — по месяцам</strong><p>Выберите «Этот месяц» или «Прошлый», чтобы увидеть предупреждение по категориям.</p></article>';
    return;
  }
  const plan=state.plans?.[monthKey(bounds.start)], budgets=plan?.budgets||{}, budgetIds=Object.keys(budgets);
  if(!budgetIds.length) {
    host.innerHTML='<article class="analytics-budget-note"><strong>Бюджет не настроен</strong><p>Добавьте категории в финансовый план, и здесь появится контроль перерасхода.</p></article>';
    return;
  }
  const spentByCategory=transactions.filter(transaction=>transaction.type==='expense').reduce((map,transaction)=>{
    map[transaction.category]=(map[transaction.category]||0)+Number(transaction.amount||0);
    return map;
  },{});
  const alerts=budgetIds.map(id=>{
    const budget=Math.max(0,Number(budgets[id]||0)), spent=Number(spentByCategory[id]||0), category=getCategory(id)||{emoji:'💳',name:'Удалённая категория'};
    return {id,budget,spent,category,over:spent-budget,percent:budget?spent/budget*100:(spent?Infinity:0)};
  }).filter(item=>item.over>0||item.percent>=80).sort((a,b)=>b.percent-a.percent);
  if(!alerts.length) {
    host.innerHTML='<article class="analytics-budget-note success"><strong>Бюджет под контролем</strong><p>Ни одна категория пока не приблизилась к лимиту.</p></article>';
    return;
  }
  const hasOver=alerts.some(alert=>alert.over>0), hasExhausted=alerts.some(alert=>alert.over===0&&alert.percent>=100), shown=alerts.slice(0,3);
  const details=shown.map(alert=>`<li><span>${escapeHtml(alert.category.emoji||'💳')} ${escapeHtml(alert.category.name)}</span><b>${alert.over>0?`+${money(alert.over)}`:alert.percent>=100?'Лимит исчерпан':`${Math.round(alert.percent)}%`}</b></li>`).join('');
  const more=alerts.length>shown.length?`<p class="analytics-warning-more">Ещё категорий: ${alerts.length-shown.length}</p>`:'';
  const title=hasOver?'Есть перерасход бюджета':hasExhausted?'Лимит бюджета исчерпан':'Бюджет почти исчерпан';
  const description=hasOver?'Проверьте категории с превышенным лимитом.':hasExhausted?'Новые расходы в этих категориях приведут к перерасходу.':'В этих категориях осталось меньше 20% лимита.';
  host.innerHTML=`<article class="analytics-budget-warning ${hasOver?'over':hasExhausted?'exhausted':'near'}"><div><span class="analytics-warning-icon">${hasOver?'!':'◷'}</span><div><strong>${title}</strong><p>${description}</p></div></div><ul>${details}</ul>${more}</article>`;
}
function renderAnalyticsTopCategories(transactions, expenseTotal) {
  const byCategory=transactions.filter(transaction=>transaction.type==='expense').reduce((map,transaction)=>{
    const id=transaction.category||'uncategorized'; map[id]=(map[id]||0)+Number(transaction.amount||0); return map;
  },{});
  const items=Object.entries(byCategory).map(([id,amount])=>({id,amount,category:getCategory(id)||{emoji:'💳',name:'Без категории'}})).sort((a,b)=>b.amount-a.amount).slice(0,3);
  $('#analyticsTopCategories').innerHTML=items.length?items.map((item,index)=>{
    const share=expenseTotal?Math.round(item.amount/expenseTotal*100):0;
    return `<article class="analytics-top-row"><span class="analytics-top-rank">${index+1}</span><span class="analytics-top-emoji">${escapeHtml(item.category.emoji||'💳')}</span><div><strong>${escapeHtml(item.category.name)}</strong><small>${share}% всех расходов</small></div><b>${money(item.amount)}</b></article>`;
  }).join(''):'<p class="hint">За выбранный период расходов по категориям пока нет.</p>';
}
function renderAnalytics() {
  const bounds=analyticsBounds(), transactions=transactionsForAnalytics(bounds.start,bounds.end), previousTransactions=transactionsForAnalytics(bounds.previousStart,bounds.previousEnd), totals=analyticsTotals(transactions), previousTotals=analyticsTotals(previousTransactions), net=totals.income-totals.expense;
  $('#analyticsPeriodLabel').textContent=bounds.eyebrow;
  $('#analyticsRange').textContent=analyticsDateRangeLabel(bounds.start,bounds.end);
  $('#analyticsOperationsCount').textContent=`${transactions.length} ${operationCountLabel(transactions.length)}`;
  $('#analyticsIncome').textContent=money(totals.income);
  $('#analyticsExpense').textContent=money(totals.expense);
  $('#analyticsNet').textContent=`${net>0?'+':''}${money(net)}`;
  $('#analyticsNet').classList.toggle('negative',net<0);
  document.querySelectorAll('[data-analytics-period]').forEach(button=>button.classList.toggle('selected',button.dataset.analyticsPeriod===analyticsPeriod));
  renderAnalyticsChart(bounds,transactions);
  renderAnalyticsComparison(bounds,totals,previousTotals);
  renderAnalyticsBudgetWarning(bounds,transactions);
  renderAnalyticsTopCategories(transactions,totals.expense);
}
function render(){
  const available=availableNow(), plan=getPlan(), assigned=reserved(), unallocated=available-assigned, pct=available?Math.max(0,Math.round(assigned/available*100)):0;
  $('#balanceValue').textContent=money(available);$('#incomeSmall').textContent=money(state.income);$('#expenseSmall').textContent=money(expenses());$('#planUnallocated').textContent=money(unallocated);
  const [year,month]=selectedPlanMonth.split('-');$('#planMonthLabel').textContent=new Date(Number(year),Number(month)-1,1).toLocaleDateString('ru-RU',{month:'long',year:'numeric'}).toUpperCase();
  $('#recentTransactions').innerHTML=state.transactions.slice(0,3).map(transactionHtml).join('');renderHistory();
  $('#budgetList').innerHTML=planCategories().map(c=>{const budget=Number(plan.budgets[c.id]||0),spent=Number(plan.spent[c.id]||0),percent=budget?Math.round(spent/budget*100):0,over=spent>budget;return `<article class="budget-item ${over?'over':''}" data-edit-budget="${c.id}"><div class="budget-row"><span class="budget-emoji">${c.emoji}</span><div><div class="budget-name">${c.name}</div><div class="budget-numbers">Потрачено ${money(spent)} из ${money(budget)}</div></div><div class="budget-remain">${money(budget-spent)}<small>${over?'Перерасход':percent+'% использовано'}</small></div></div><div class="budget-bar"><span style="width:${Math.min(percent,100)}%;background:${c.color||''}"></span></div></article>`}).join('')||'<p class="hint">В этом месяце ещё нет распределённых категорий.</p>';
  const total=state.goals.reduce((s,g)=>s+Number(g.current||0),0),target=state.goals.reduce((s,g)=>s+Number(g.target||0),0);$('#goalsTotal').textContent=money(total);$('.goals-total p').textContent=`Вы уже на ${target?Math.round(total/target*100):0}% пути к своим целям`;$('#goalsList').innerHTML=state.goals.map(g=>{const p=Math.min(100,Math.round(g.current/g.target*100));return `<article class="goal-card" data-edit-goal="${g.id}"><div class="goal-card-top"><div class="goal-title">${g.emoji||'🎯'} ${g.title}</div><div class="goal-amount">${p}%</div></div><div class="goal-info">${g.description?g.description+' · ':''}${money(g.current)} из ${money(g.target)}</div><div class="goal-info">${dateLabel(g.date)}</div><div class="goal-progress"><span style="width:${p}%"></span></div><div class="goal-actions"><button data-goal-move="deposit" data-goal-id="${g.id}">Пополнить</button><button data-goal-move="withdraw" data-goal-id="${g.id}">Снять</button></div></article>`}).join('');
  renderAnalytics();renderCategories();renderPlannedPayments();save();
}
function renderCategories(){const list=activeCategories(categoryTab);$('#categoryList').innerHTML=list.length?list.map(c=>`<article class="budget-item category-item" data-edit-category="${c.id}"><div class="budget-row"><span class="budget-emoji" style="background:${c.color}22">${c.emoji}</span><div><div class="budget-name">${c.name}</div><div class="budget-numbers">${c.type==='expense'?'Расходы и планирование':'Доходы'}</div></div><span class="category-edit">Изменить ›</span></div></article>`).join(''):'<p class="hint">Категорий пока нет. Создайте первую кнопкой «+».</p>';document.querySelectorAll('[data-category-type]').forEach(b=>b.classList.toggle('selected',b.dataset.categoryType===categoryTab))}
function showScreen(id){document.querySelectorAll('.screen').forEach(s=>s.classList.toggle('active',s.id===id));document.querySelectorAll('.nav-item').forEach(b=>b.classList.toggle('active',b.dataset.go===id));if(id==='stats')renderAnalytics();window.Telegram?.WebApp?.BackButton?.[id==='home'?'hide':'show']?.();window.scrollTo(0,0)}
function closeModal(){document.querySelectorAll('.modal').forEach(x=>x.classList.remove('open'));$('#modalBackdrop').classList.remove('open');$('#operationContext').hidden=true;pendingPaymentCompletion=null;window.Telegram?.WebApp?.BackButton?.hide?.()}
function openModal(id){closeModal();$('#'+id).classList.add('open');$('#modalBackdrop').classList.add('open');window.Telegram?.WebApp?.BackButton?.[id==='openingBalanceModal'?'hide':'show']?.()}
function openingBalanceTransaction(){return state.transactions.find(t=>t.type==='opening_balance')}
function chronologyKey(transaction){return `${transaction.date||'9999-12-31'}T${transaction.time||'00:00'}:${String(transaction.id)}`}
function isFirstIncomeTransaction(transaction){
  const firstIncome=[...state.transactions].filter(t=>t.type==='income').sort((a,b)=>chronologyKey(a).localeCompare(chronologyKey(b)))[0];
  return String(firstIncome?.id)===String(transaction?.id);
}
function setOpeningBalanceNotice(message=''){const notice=$('#openingBalanceNotice');notice.textContent=message;notice.hidden=!message}
function openOpeningBalanceModal(onboarding=false){
  const transaction=openingBalanceTransaction();
  $('#openingBalanceModalTitle').textContent=onboarding?'Начнём с текущего остатка':'Стартовый баланс';
  $('#openingBalanceIntro').textContent=onboarding?'Сколько у вас доступно сейчас?':'Укажите текущий остаток. Он не будет считаться доходом.';
  $('#openingBalanceAmount').value=transaction?.amount??'';
  $('#skipOpeningBalance').hidden=!onboarding;
  setOpeningBalanceNotice();
  openModal('openingBalanceModal');
}
function finishOpeningBalance(amount){
  const normalized=Math.round(Number(amount||0));
  if(!Number.isFinite(normalized)||normalized<0){setOpeningBalanceNotice('Введите сумму от 0 ₽.');return}
  const transaction=openingBalanceTransaction();
  state.onboarding.openingBalanceHandled=true;
  if(normalized===0)state.transactions=state.transactions.filter(t=>t.type!=='opening_balance');
  else if(transaction)Object.assign(transaction,{amount:normalized,comment:'Начальный баланс'});
  else{const fields=nowFields();state.transactions.unshift({id:`opening-${Date.now()}`,type:'opening_balance',amount:normalized,comment:'Начальный баланс',...fields})}
  closeModal();
  render();
  haptic();
}
function maybeOpenOpeningBalance(){if(!state.onboarding?.openingBalanceHandled)openOpeningBalanceModal(true)}
function fillCategories(select,type,selected){select.innerHTML=activeCategories(type).map(c=>`<option value="${c.id}" ${c.id===selected?'selected':''}>${c.emoji} ${c.name}</option>`).join('')}function fillGoals(select,selected){select.innerHTML=state.goals.map(g=>`<option value="${g.id}" ${String(g.id)===String(selected)?'selected':''}>${g.emoji||'🎯'} ${g.title}</option>`).join('')}
function openOperation(type,operation){
  const f=$('#operationForm');
  f.reset();
  $('#operationId').value=operation?.id||'';
  $('#operationType').value=type;
  const isGoal=type==='goal_deposit'||type==='goal_withdrawal';
  $('#operationTitle').textContent=operation?'Изменить операцию':type==='income'?'Новый доход':type==='expense'?'Новый расход':type==='goal_deposit'?'Пополнить цель':'Снять с цели';
  $('#operationTargetLabel').childNodes[0].textContent=isGoal?'Цель':'Категория';
  if(isGoal)fillGoals($('#operationCategory'),operation?.goalId);else fillCategories($('#operationCategory'),type,operation?.category);
  const now=nowFields();
  $('#operationAmount').value=operation?.amount||'';
  $('#operationComment').value=operation?.comment||'';
  $('#operationDate').value=operation?.date||now.date;
  $('#operationTime').value=operation?.time||now.time;
  const canConvertToOpeningBalance=Boolean(operation&&type==='income'&&!openingBalanceTransaction()&&isFirstIncomeTransaction(operation));
  $('#convertIncomeToOpeningBalance').hidden=!canConvertToOpeningBalance;
  $('#convertIncomeToOpeningBalanceHint').hidden=!canConvertToOpeningBalance;
  openModal('operationModal');
}
function convertIncomeToOpeningBalance(){
  const income=state.transactions.find(t=>String(t.id)===String($('#operationId').value));
  if(!income||income.type!=='income'||openingBalanceTransaction()||!isFirstIncomeTransaction(income))return;
  const hasUnsavedChanges=Number($('#operationAmount').value)!==Number(income.amount||0)||$('#operationComment').value!==(income.comment||'')||$('#operationDate').value!==income.date||$('#operationTime').value!==(income.time||'')||$('#operationCategory').value!==(income.category||'');
  if(hasUnsavedChanges){alert('Сначала сохраните изменения операции, затем откройте её снова и преобразуйте в стартовый баланс.');return}
  if(!confirm(`Преобразовать доход ${money(income.amount)} в стартовый баланс? Доступно сейчас не изменится, но сумма перестанет считаться доходом и исчезнет из аналитики.`))return;
  Object.assign(income,{type:'opening_balance',category:undefined,comment:'Начальный баланс'});
  state.onboarding??={};
  state.onboarding.openingBalanceHandled=true;
  rebuildLedgerTotals();
  closeModal();
  render();
  haptic();
}
function editBudget(id){const c=getCategory(id),plan=getPlan();$('#budgetId').value=c.id;$('#budgetModalTitle').textContent=`Бюджет: ${c.name}`;fillCategories($('#budgetCategory'),'expense',c.id);$('#budgetCategory').disabled=true;$('#budgetAmount').value=plan.budgets[c.id]||0;$('#removeBudget').hidden=false;openModal('budgetModal')}function editGoal(id){const g=getGoal(id);$('#goalModalTitle').textContent='Изменить цель';$('#goalId').value=g.id;$('#goalTitle').value=g.title;$('#goalDescription').value=g.description||'';$('#goalAmount').value=g.target;$('#goalCurrent').value=g.current;$('#goalCurrent').disabled=true;$('#goalDate').value=g.date||'';$('#deleteGoal').hidden=false;openModal('goalModal')}function editCategory(id){const c=getCategory(id);$('#categoryModalTitle').textContent='Изменить категорию';$('#categoryId').value=c.id;$('#categoryType').value=c.type;$('#categoryEmoji').value=c.emoji;$('#categoryName').value=c.name;$('#categoryColor').value=c.color||'#6756d9';$('#archiveCategory').hidden=false;openModal('categoryModal')}
function deleteOperation(id){const t=state.transactions.find(x=>String(x.id)===String(id));if(!t||!confirm(`Удалить операцию на ${money(t.amount)}?`))return;applyOperation(t,-1);state.transactions=state.transactions.filter(x=>String(x.id)!==String(id));render();haptic()}
document.addEventListener('click',e=>{const go=e.target.closest('[data-go]');if(go)showScreen(go.dataset.go);const action=e.target.closest('[data-action]');if(action){const type=action.dataset.action;if(type==='goal'){$('#goalForm').reset();$('#goalId').value='';$('#goalCurrent').disabled=false;$('#goalModalTitle').textContent='Новая цель';$('#deleteGoal').hidden=true;openModal('goalModal')}else if(type==='plan')showScreen('plan');else if(type==='category'){$('#categoryForm').reset();$('#categoryId').value='';$('#categoryType').value=categoryTab;$('#categoryColor').value='#6756d9';$('#categoryModalTitle').textContent='Новая категория';$('#archiveCategory').hidden=true;openModal('categoryModal')}else openOperation(type)}if(e.target.closest('#addBudget')){$('#budgetForm').reset();$('#budgetId').value='';$('#budgetModalTitle').textContent='Распределить бюджет';fillCategories($('#budgetCategory'),'expense');$('#budgetCategory').disabled=false;$('#removeBudget').hidden=true;openModal('budgetModal')}if(e.target.closest('#editPlan')){$('#planIncome').value=getPlan().incomeTarget||availableNow();openModal('planModal')}if(e.target.closest('#prevPlanMonth')){const d=new Date(selectedPlanMonth+'-01T12:00:00');d.setMonth(d.getMonth()-1);selectedPlanMonth=monthKey(d);render()}if(e.target.closest('#nextPlanMonth')){const d=new Date(selectedPlanMonth+'-01T12:00:00');d.setMonth(d.getMonth()+1);selectedPlanMonth=monthKey(d);render()}const b=e.target.closest('[data-edit-budget]');if(b)editBudget(b.dataset.editBudget);const g=e.target.closest('[data-edit-goal]');if(g&&!e.target.closest('[data-goal-move]'))editGoal(g.dataset.editGoal);const move=e.target.closest('[data-goal-move]');if(move)openOperation(move.dataset.goalMove==='deposit'?'goal_deposit':'goal_withdrawal',{goalId:move.dataset.goalId});const c=e.target.closest('[data-edit-category]');if(c)editCategory(c.dataset.editCategory);const tab=e.target.closest('[data-category-type]');if(tab){categoryTab=tab.dataset.categoryType;renderCategories()}const historyTab=e.target.closest('[data-history-filter]');if(historyTab){historyFilter=historyTab.dataset.historyFilter;renderHistory()}const edit=e.target.closest('[data-edit-operation]');if(edit){const t=state.transactions.find(x=>String(x.id)===String(edit.dataset.editOperation));if(t)openOperation(t.type,t)}const del=e.target.closest('[data-delete-transaction]');if(del)deleteOperation(del.dataset.deleteTransaction);if(e.target.closest('.close-modal')||e.target===$('#modalBackdrop'))closeModal()});
document.addEventListener('click',event=>{
  if(event.target===$('#modalBackdrop')&&$('#openingBalanceModal').classList.contains('open'))event.stopImmediatePropagation();
},true);
document.addEventListener('click',event=>{
  const edit=event.target.closest('[data-edit-opening-balance]');
  if(edit)openOpeningBalanceModal(false);
});
document.addEventListener('click',event=>{const period=event.target.closest('[data-analytics-period]');if(period){analyticsPeriod=period.dataset.analyticsPeriod;analyticsSelectedBucketKey='';renderAnalytics();return}const bucket=event.target.closest('[data-analytics-bucket]');if(bucket){analyticsSelectedBucketKey=bucket.dataset.analyticsBucket;renderAnalytics();}});
const today=nowFields();$('#todayLabel').textContent=new Date().toLocaleDateString('ru-RU',{weekday:'long',day:'numeric',month:'long'}).toUpperCase();$('#operationDate').value=today.date;$('#operationTime').value=today.time;
$('#operationForm').addEventListener('submit',e=>{e.preventDefault();const oldId=$('#operationId').value,old=state.transactions.find(t=>String(t.id)===oldId),type=$('#operationType').value;const t={id:old?old.id:Date.now(),type,category:type==='goal_deposit'||type==='goal_withdrawal'?undefined:$('#operationCategory').value,goalId:type==='goal_deposit'||type==='goal_withdrawal'?$('#operationCategory').value:undefined,amount:Number($('#operationAmount').value),comment:$('#operationComment').value,date:$('#operationDate').value,time:$('#operationTime').value};const completion=pendingPaymentCompletion;if(old)applyOperation(old,-1);applyOperation(t,1);if(old)state.transactions=state.transactions.map(x=>String(x.id)===String(old.id)?t:x);else state.transactions.unshift(t);closeModal();render();haptic();if(completion)completePlannedPaymentAfterOperation(completion)});
$('#convertIncomeToOpeningBalance').addEventListener('click',convertIncomeToOpeningBalance);
$('#openingBalanceForm').addEventListener('submit',event=>{event.preventDefault();finishOpeningBalance($('#openingBalanceAmount').value)});
$('#skipOpeningBalance').addEventListener('click',()=>finishOpeningBalance(0));
$('#budgetForm').addEventListener('submit',e=>{e.preventDefault();const plan=getPlan(),id=$('#budgetCategory').value;plan.budgets[id]=Number($('#budgetAmount').value);plan.spent[id]??=0;closeModal();render();haptic()});$('#planForm').addEventListener('submit',e=>{e.preventDefault();getPlan().incomeTarget=Number($('#planIncome').value);closeModal();render();haptic()});
$('#goalForm').addEventListener('submit',e=>{e.preventDefault();const id=$('#goalId').value,data={title:$('#goalTitle').value,description:$('#goalDescription').value,target:Number($('#goalAmount').value),date:$('#goalDate').value};if(id)Object.assign(getGoal(id),data);else{const goal={id:Date.now(),emoji:'🎯',current:Number($('#goalCurrent').value||0),...data};state.goals.unshift(goal);if(goal.current){const fields=nowFields(),t={id:Date.now()+1,type:'goal_deposit',goalId:goal.id,amount:goal.current,comment:'Первоначальное накопление',...fields};state.transactions.unshift(t)}}closeModal();render();haptic()});
$('#categoryForm').addEventListener('submit',e=>{e.preventDefault();const id=$('#categoryId').value,data={type:$('#categoryType').value,emoji:$('#categoryEmoji').value,name:$('#categoryName').value,color:$('#categoryColor').value};if(id)Object.assign(getCategory(id),data);else state.categories.push({id:'cat-'+Date.now(),...data,spent:0,archived:false});closeModal();categoryTab=data.type;render();haptic()});$('#archiveCategory').addEventListener('click',()=>{const c=getCategory($('#categoryId').value);if(c){c.archived=true;closeModal();render();haptic()}});$('#removeBudget').addEventListener('click',()=>{const plan=getPlan(),id=$('#budgetId').value,c=getCategory(id);if(c&&confirm(`Убрать «${c.name}» из финансового плана?`)){delete plan.budgets[id];delete plan.spent[id];closeModal();render();haptic()}});$('#deleteGoal').addEventListener('click',()=>{const g=getGoal($('#goalId').value);if(g&&confirm(`Удалить цель «${g.title}»?`)){if(g.current){const fields=nowFields();state.transactions.unshift({id:Date.now(),type:'goal_withdrawal',goalId:g.id,amount:g.current,comment:'Закрытие цели',...fields})}state.goals=state.goals.filter(x=>x.id!==g.id);closeModal();render();haptic()}});

document.addEventListener('click',event=>{
  if(event.target.closest('[data-go="payments"]')) { loadPlannedPayments(); return; }
  if(event.target.closest('#addPlannedPayment')||event.target.closest('#emptyAddPlannedPayment')) { event.preventDefault(); openPlannedPaymentModal(); return; }
  const edit=event.target.closest('[data-edit-planned-payment]'); if(edit) { event.preventDefault(); openPlannedPaymentModal(edit.dataset.editPlannedPayment); return; }
  const action=event.target.closest('[data-planned-action]'); if(action) { event.preventDefault(); performPlannedPaymentAction(action.dataset.plannedAction,action.dataset.plannedPaymentId,action.dataset.reminderId); }
});
$('#plannedPaymentForm').addEventListener('submit',event=>{event.preventDefault();savePlannedPayment()});
$('#deletePlannedPayment').addEventListener('click',event=>{event.preventDefault();deletePlannedPayment()});

window.showKopilkaScreen=showScreen;window.closeKopilkaModal=closeModal;paymentUrlIntent=paymentUrlIntentFromLocation();render();if(canSync())hydrateRemote();else maybeOpenOpeningBalance();loadPlannedPayments();
