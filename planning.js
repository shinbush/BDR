// Pure calendar and reserve calculations. Ranges include start, exclude end.
function planningBudgetProgress(limit, spent) {
  limit=Math.max(0,Number(limit)||0);spent=Math.max(0,Number(spent)||0);
  const over=spent>limit,percent=limit?Math.round(spent/limit*100):spent?100:0;
  return {over,percent,width:Math.min(percent,100),remaining:limit-spent};
}
function planningDateKey(date) {
  return `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}`;
}
function planningDay(date, days=0) {
  return new Date(date.getFullYear(),date.getMonth(),date.getDate()+days);
}
function planningValidDate(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value||'') && planningDateKey(new Date(`${value}T00:00:00`))===value;
}
function planningPeriod(mode, anchor, now=new Date(), month='', offset=0) {
  if(mode!=='salary') {
    const start=month?new Date(`${month}-01T00:00:00`):new Date(now.getFullYear(),now.getMonth(),1);
    const end=new Date(start.getFullYear(),start.getMonth()+1,1);
    return {mode:'month',key:planningDateKey(start).slice(0,7),start,end,startKey:planningDateKey(start),endKey:planningDateKey(end)};
  }
  const base=planningValidDate(anchor)?new Date(`${anchor}T00:00:00`):planningDay(now);
  const serial=date=>Date.UTC(date.getFullYear(),date.getMonth(),date.getDate())/86400000;
  const index=Math.floor((serial(now)-serial(base))/15)+offset;
  const start=planningDay(base,index*15),end=planningDay(start,15);
  return {mode:'salary',key:`15d:${planningDateKey(start)}`,start,end,startKey:planningDateKey(start),endKey:planningDateKey(end)};
}
function planningSpent(transactions, period) {
  const spent={};
  for(const t of transactions)if(t.type==='expense'&&t.date>=period.startKey&&t.date<period.endKey)spent[t.category]=(spent[t.category]||0)+Number(t.amount||0);
  return spent;
}
function planningZonedParts(timestamp, timeZone) {
  const parts=new Intl.DateTimeFormat('en-CA',{timeZone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(new Date(timestamp));
  return Object.fromEntries(parts.filter(p=>p.type!=='literal').map(p=>[p.type,Number(p.value)]));
}
function planningZonedEpoch(parts, timeZone) {
  const expected=Date.UTC(parts.year,parts.month-1,parts.day,parts.hour,parts.minute);
  let candidate=expected;
  for(let i=0;i<4;i++) {
    const actual=planningZonedParts(candidate,timeZone),delta=expected-Date.UTC(actual.year,actual.month-1,actual.day,actual.hour,actual.minute);
    if(!delta)return candidate;
    candidate+=delta;
  }
  return candidate;
}
function planningOccurrenceAfter(payment, timestamp, count=1) {
  const zone=payment.timezone||'UTC',p=planningZonedParts(timestamp,zone);
  const [hour,minute]=(payment.time_local||'09:00').split(':').map(Number);
  const interval=Number(payment.interval_days)||({daily:1,weekly:7,every_15_days:15}[payment.cadence]);
  let date;
  if(interval)date=new Date(Date.UTC(p.year,p.month-1,p.day+interval*count));
  else {
    const absolute=p.year*12+p.month-1+(payment.cadence==='yearly'?12:1)*count;
    const year=Math.floor(absolute/12),month=absolute%12;
    date=new Date(Date.UTC(year,month,Math.min(Number(payment.anchor_day)||p.day,new Date(Date.UTC(year,month+1,0)).getUTCDate())));
  }
  return planningZonedEpoch({year:date.getUTCFullYear(),month:date.getUTCMonth()+1,day:date.getUTCDate(),hour,minute},zone);
}
function planningForecast(payments, start, end, now=Date.now()) {
  const byCategory={},occurrences=[];
  for(const payment of payments) {
    if(payment.active===false||payment.active===0)continue;
    let at=Number(payment.next_reminder_at);
    if(!Number.isFinite(at)||at>=end)continue;
    const add=()=>occurrences.push({payment_id:payment.id,category_id:payment.category_id,amount:Math.max(0,Number(payment.amount)||0),occurrence_at:at});
    if(at<=now||at<start) {
      // Carry one unresolved overdue payment into the current period, never a
      // backlog for every missed interval. Future periods exclude this debt.
      if(at<=now&&start<=now&&now<end)add();
      const reference=Math.max(now,start-1);
      const p=planningZonedParts(at,payment.timezone||'UTC'),n=planningZonedParts(reference,payment.timezone||'UTC');
      const interval=Number(payment.interval_days)||({daily:1,weekly:7,every_15_days:15}[payment.cadence]);
      const count=interval?Math.floor((Date.UTC(n.year,n.month-1,n.day)-Date.UTC(p.year,p.month-1,p.day))/(interval*86400000)):payment.cadence==='yearly'?n.year-p.year:(n.year-p.year)*12+n.month-p.month;
      at=planningOccurrenceAfter(payment,at,Math.max(1,count));
      while(at<=reference)at=planningOccurrenceAfter(payment,at);
    }
    // Bounded to the same maximum forecast horizon as the API (370 days).
    for(let guard=0;at<end&&guard<372;guard++) {
      if(at>=start)add();
      const next=planningOccurrenceAfter(payment,at);if(next<=at)break;at=next;
    }
  }
  for(const item of occurrences)byCategory[item.category_id]=(byCategory[item.category_id]||0)+item.amount;
  return {total:occurrences.reduce((sum,item)=>sum+item.amount,0),byCategory,count:occurrences.length};
}
function planningGoalDetails(goal, transactions, period, now=new Date()) {
  if(period.mode==='month')return goalPlanDetails(goal,transactions,now,period.key);
  const remaining=Math.max(0,Number(goal.target||0)-Number(goal.current||0));
  let amount=0;
  // A 15-day plan receives its calendar-day share of the monthly contribution.
  for(let date=period.start;date<period.end;date=planningDay(date,1)) {
    if(planningDateKey(date).slice(0,7)<(goal.monthlyStartMonth||goalMonthKey(now)))continue;
    amount+=Number(goal.monthlyAmount||0)/new Date(date.getFullYear(),date.getMonth()+1,0).getDate();
  }
  amount=Math.round(amount);
  const paid=Math.max(0,transactions.reduce((sum,t)=>{
    if(String(t.goalId)!==String(goal.id)||t.initialFunding||t.date<period.startKey||t.date>=period.endKey)return sum;
    return sum+(t.type==='goal_deposit'?Number(t.amount||0):t.type==='goal_withdrawal'?-Number(t.amount||0):0);
  },0));
  const enabled=goal.monthlyEnabled===true&&period.endKey.slice(0,7)>=(goal.monthlyStartMonth||goalMonthKey(now));
  return {remaining,paid,amount,enabled,reserve:enabled?Math.min(remaining,Math.max(0,amount-paid)):0};
}
function planningReserves(available,plan,forecast,futureGoals=0) {
  const payments=Number(forecast.total||0);
  const budgetExtra=Object.entries(plan.budgets||{}).reduce((sum,[id,budget])=>sum+Math.max(0,Number(budget||0)-Number(plan.spent?.[id]||0)-Number(forecast.byCategory?.[id]||0)),0);
  return {available,payments,budgetExtra,futureGoals,afterPayments:available-payments,free:available-payments-budgetExtra-futureGoals};
}
