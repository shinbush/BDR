const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const {DatabaseSync}=require('node:sqlite');
const {webcrypto}=require('node:crypto');
const root=path.join(__dirname,'..');
const read=name=>fs.readFileSync(path.join(root,name),'utf8');
const client=vm.createContext({});
vm.runInContext(read('goal-planning.js')+'\n'+read('planning.js'),client);
const server=vm.createContext({TextEncoder,TextDecoder,crypto:webcrypto,console,Intl,URL,Response,Request,Headers});
vm.runInContext(read('worker.js').replace('export default {','const worker = {'),server);
const day=value=>new Date(`${value}T00:00:00`);
const now=day('2026-09-10');
const payment=(overrides={})=>({id:'p',active:true,amount:1000,category_id:'food',cadence:'every_15_days',time_local:'09:00',timezone:'Asia/Omsk',anchor_day:10,next_reminder_at:Date.parse('2026-09-10T09:00:00+06:00'),...overrides});
test('15 days are not two weeks: cross months, years, leap days and DST',()=>{
  for(const [date,next,zone] of [['2026-09-25','2026-10-10','Asia/Omsk'],['2026-12-25','2027-01-09','UTC'],['2028-02-20','2028-03-06','UTC'],['2026-03-01','2026-03-16','America/New_York']]) {
    const p=payment({timezone:zone}),at=client.planningZonedEpoch({year:+date.slice(0,4),month:+date.slice(5,7),day:+date.slice(8),hour:9,minute:0},zone);
    const result=client.planningOccurrenceAfter(p,at);
    assert.equal(result,server.occurrenceAfter(p,at));
    const parts=client.planningZonedParts(result,zone);
    assert.equal(`${parts.year}-${String(parts.month).padStart(2,'0')}-${String(parts.day).padStart(2,'0')}`,next);assert.equal(parts.hour,9);
  }
});
test('month end preserves anchor through February and back to March',()=>{
  const p=payment({cadence:'monthly',anchor_day:31,timezone:'UTC'});
  const feb=client.planningOccurrenceAfter(p,Date.parse('2026-01-31T09:00Z'));
  assert.equal(new Date(feb).toISOString(),'2026-02-28T09:00:00.000Z');
  assert.equal(new Date(client.planningOccurrenceAfter(p,feb)).toISOString(),'2026-03-31T09:00:00.000Z');
});
test('salary periods include 15 dates, do not overlap, and roll forward on launch',()=>{
  const first=client.planningPeriod('salary','2026-09-05',now);
  assert.equal(first.startKey,'2026-09-05');assert.equal(first.endKey,'2026-09-20');
  const next=client.planningPeriod('salary','2026-09-05',now,'',1);
  assert.equal(next.startKey,first.endKey);assert.equal(next.endKey,'2026-10-05');
  assert.equal(client.planningPeriod('salary','2026-09-05',day('2026-10-06')).startKey,'2026-10-05');
  assert.equal(client.planningPeriod('month','',now).key,'2026-09');
  assert.equal(client.planningValidDate('2026-02-30'),false);
});
test('period expenses recompute after editing/deleting, boundaries are exclusive',()=>{
  const period=client.planningPeriod('salary','2026-09-05',now);
  const tx=[{type:'expense',category:'food',date:'2026-09-05',amount:100},{type:'expense',category:'food',date:'2026-09-19',amount:200},{type:'expense',category:'food',date:'2026-09-20',amount:900},{type:'income',category:'food',date:'2026-09-10',amount:5000}];
  assert.equal(client.planningSpent(tx,period).food,300);
  tx[1].date='2026-09-21';assert.equal(client.planningSpent(tx,period).food,100);
  tx.shift();assert.equal(client.planningSpent(tx,period).food,undefined);
});
test('forecast reserves one overdue item and future occurrences, client equals server',()=>{
  const start=day('2026-09-01').getTime(),end=day('2026-10-01').getTime();
  for(const cadence of ['daily','weekly','every_15_days','monthly','yearly']) {
    const p=payment({cadence,next_reminder_at:Date.parse('2026-07-01T09:00Z')});
    const forecast=client.planningForecast([p],start,end,now.getTime());
    const expected=server.forecastPaymentOccurrences(p,end,now.getTime());
    assert.equal(forecast.count,expected.length,cadence);assert.equal(forecast.total,expected.length*1000,cadence);
  }
});
test('forecast includes start, excludes end, skips inactive and paid schedules',()=>{
  const start=Date.parse('2026-09-10T09:00Z'),end=Date.parse('2026-09-25T09:00Z'),p=payment({timezone:'UTC',next_reminder_at:start});
  assert.equal(client.planningForecast([p],start,end,start-1).count,1);
  assert.equal(client.planningForecast([{...p,active:false}],start,end,start-1).total,0);
  assert.equal(client.planningForecast([{...p,next_reminder_at:end}],start,end,start-1).total,0);
  // No overdue debt in a future period; calculate even far beyond this year.
  assert.equal(client.planningForecast([p],Date.parse('2028-01-01'),Date.parse('2028-01-16'),now.getTime()).count,1);
});
test('daily forecast covers a full year, not the old 64-occurrence cap',()=>{
  const at=Date.parse('2026-09-10T09:00Z'),p=payment({cadence:'daily',timezone:'UTC',next_reminder_at:at});
  assert.equal(server.forecastPaymentOccurrences(p,at+370*86400000,at-1).length,370);
});
test('payments covered by category budgets are never subtracted twice',()=>{
  const result=client.planningReserves(82000,{budgets:{rent:20000,food:10000},spent:{food:2000}},{total:23000,byCategory:{rent:20000,food:3000}},5000);
  assert.equal(result.afterPayments,59000);assert.equal(result.budgetExtra,5000);assert.equal(result.free,49000);
  assert.equal(client.planningReserves(100,{budgets:{},spent:{}},{total:200,byCategory:{}},0).free,-100);
});
test('15-day goal reserve is proportional, paid contributions release it',()=>{
  const goal={id:'g',target:100000,current:0,monthlyAmount:3000,monthlyEnabled:true,monthlyStartMonth:'2026-09'};
  const period=client.planningPeriod('salary','2026-09-01',now);
  assert.equal(client.planningGoalDetails(goal,[],period,now).reserve,1500);
  assert.equal(client.planningGoalDetails(goal,[{goalId:'g',type:'goal_deposit',date:'2026-09-10',amount:500}],period,now).reserve,1000);
  assert.equal(client.planningGoalDetails({...goal,current:100000},[],period,now).reserve,0);
  assert.equal(client.planningGoalDetails({...goal,monthlyEnabled:false},[],period,now).reserve,0);
});
function dbEnvironment(db) {
  return {DB:{prepare(sql){return {bind(...args){const statement=db.prepare(sql);return {async first(){return statement.get(...args)||null},async all(){return {results:statement.all(...args)}},async run(){return {meta:statement.run(...args)}}}}}},async batch(statements){return Promise.all(statements.map(statement=>statement.run()))}}};
}
test('additive migration preserves existing payments/reminders; API CRUD and advance use 15 days',async()=>{
  const db=new DatabaseSync(':memory:');db.exec('PRAGMA foreign_keys=ON;'+read('migrations/0001_planned_payments.sql'));
  db.exec("INSERT INTO planned_payments(id,telegram_id,title,amount,category_id,cadence,time_local,timezone,anchor_day,next_reminder_at) VALUES('old','1','Legacy',100,'food','monthly','09:00','UTC',10,1789030800000); INSERT INTO payment_reminders(id,payment_id,telegram_id,occurrence_at,next_attempt_at) VALUES('old-reminder','old','1',1789030800000,1789030800000);");
  db.exec(read('migrations/0003_payment_intervals.sql'));
  assert.equal(db.prepare('SELECT count(*) n FROM payment_reminders').get().n,1);
  assert.equal(db.prepare('SELECT cadence FROM planned_payments WHERE id=?').get('old').cadence,'monthly');
  const env=dbEnvironment(db),payload={title:'Rent',category_id:'rent',amount:1000,cadence:'every_15_days',time_local:'09:00',timezone:'UTC',next_reminder_at:Date.parse('2026-09-10T09:00Z')};
  let p=await server.createPayment(env,'1',payload);assert.equal(p.cadence,'every_15_days');assert.equal(p.interval_days,15);
  assert.equal(await server.getPayment(env,'other-user',p.id),null);
  db.prepare('INSERT INTO payment_reminders(id,payment_id,telegram_id,occurrence_at,next_attempt_at) VALUES(?,?,?,?,?)').run('r',p.id,'1',p.next_reminder_at,p.next_reminder_at);
  p=await server.advanceReminder(env,'1',p.id,'r','skipped');assert.equal(new Date(p.next_reminder_at).toISOString(),'2026-09-25T09:00:00.000Z');
  p=await server.updatePayment(env,'1',p.id,{...payload,cadence:'monthly'});assert.equal(p.interval_days,null);assert.equal(p.cadence,'monthly');
  p=await server.updatePayment(env,'1',p.id,{...payload,cadence:'daily'});assert.equal(p.interval_days,1);assert.equal(p.cadence,'daily');
  assert.throws(()=>server.parsePaymentPayload({...payload,cadence:'invalid'}));
  await server.deletePayment(env,'1',p.id);assert.equal(await server.getPayment(env,'1',p.id),null);
  assert.equal(db.prepare('PRAGMA foreign_key_check').all().length,0);db.close();
});
