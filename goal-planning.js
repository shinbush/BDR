// Calendar-month planning only: these calculations never create ledger entries.
function goalMonthKey(date) {
  return `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}`;
}
function goalMonthlyProgress(goal, transactions, month) {
  return Math.max(0, transactions.reduce((sum, transaction) => {
    if (String(transaction.goalId)!==String(goal.id) || transaction.date?.slice(0,7)!==month || transaction.initialFunding) return sum;
    const amount=Number(transaction.amount)||0;
    return sum+(transaction.type==='goal_deposit'?amount:transaction.type==='goal_withdrawal'?-amount:0);
  },0));
}
function goalPlanDetails(goal, transactions=[], now=new Date(), month=goalMonthKey(now)) {
  const remaining=Math.max(0,(Number(goal.target)||0)-(Number(goal.current)||0));
  const deadline=/^\d{4}-\d{2}-\d{2}$/.test(goal.date||'')?new Date(`${goal.date}T12:00:00`):null;
  const today=new Date(now.getFullYear(),now.getMonth(),now.getDate(),12);
  const hasDeadline=Boolean(deadline&&Number.isFinite(deadline.getTime()));
  const overdue=hasDeadline&&deadline<today&&remaining>0;
  // Include the current month: September through December means four payments.
  const months=hasDeadline?Math.max(1,(deadline.getFullYear()-now.getFullYear())*12+deadline.getMonth()-now.getMonth()+1):null;
  const paid=goalMonthlyProgress(goal,transactions,month);
  const enabled=goal.monthlyEnabled===true&&month>=(goal.monthlyStartMonth||goalMonthKey(now));
  const amount=Math.max(0,Number(goal.monthlyAmount)||0);
  const reserve=enabled?Math.min(remaining,Math.max(0,amount-paid)):0;
  const currentPaid=enabled?goalMonthlyProgress(goal,transactions,goalMonthKey(now)):0;
  const recommended=remaining>0&&months?Math.ceil((remaining+currentPaid)/months):0;
  return {remaining,months,overdue,hasDeadline,paid,enabled,amount,reserve,recommended};
}
function goalMonthlyReserve(goals, transactions, month=goalMonthKey(new Date()), now=new Date()) {
  return goals.reduce((sum,goal)=>sum+goalPlanDetails(goal,transactions,now,month).reserve,0);
}
