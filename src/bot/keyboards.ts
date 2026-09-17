import { InlineKeyboard, Keyboard } from 'grammy';
import { formatMoney } from '../utils/money';
import type { IPlan } from '../models';
import type { PaymentGateway } from '../services/payments';
import { planDuration } from './texts';

/* Callback-data scheme (Telegram caps this at 64 bytes):
   plans | plan:<planId> | pay:<planId>:<gateway> | check:<reference>
   status | link | renew | help | menu
   adm:* for every administrator action                                     */

export const CB = {
  plans: 'plans',
  status: 'status',
  link: 'link',
  renew: 'renew',
  help: 'help',
  menu: 'menu',
} as const;

export function mainMenuKeyboard(hasActiveSubscription: boolean): InlineKeyboard {
  const keyboard = new InlineKeyboard()
    .text('\u{1F4E6} View Plans', CB.plans)
    .text('✅ My Subscription', CB.status)
    .row();

  if (hasActiveSubscription) {
    keyboard.text('\u{1F517} Get Invite Link', CB.link).text('♻️ Renew', CB.renew).row();
  }

  keyboard.text('ℹ️ Help', CB.help);
  return keyboard;
}

export function persistentMenu(): Keyboard {
  return new Keyboard()
    .text('\u{1F4E6} Plans')
    .text('✅ My Subscription')
    .row()
    .text('\u{1F517} Invite Link')
    .text('ℹ️ Help')
    .resized()
    .persistent();
}

export function plansKeyboard(plans: IPlan[]): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  for (const plan of plans) {
    keyboard
      .text(
        `${plan.name} • ${formatMoney(plan.priceMinor, plan.currency)} • ${planDuration(plan.durationDays)}`,
        `plan:${String(plan._id)}`,
      )
      .row();
  }
  keyboard.text('⬅️ Back', CB.menu);
  return keyboard;
}

export function gatewayKeyboard(planId: string, gateways: PaymentGateway[]): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  for (const gateway of gateways) {
    const icon = gateway.id === 'paystack' ? '\u{1F4B3}' : '\u{1F98B}';
    keyboard.text(`${icon} Pay with ${gateway.label}`, `pay:${planId}:${gateway.id}`).row();
  }
  keyboard.text('⬅️ Back to plans', CB.plans);
  return keyboard;
}

export function checkoutKeyboard(checkoutUrl: string, reference: string): InlineKeyboard {
  return new InlineKeyboard()
    .url('\u{1F4B3} Pay Now', checkoutUrl)
    .row()
    .text('✅ I have paid', `check:${reference}`)
    .row()
    .text('❌ Cancel', CB.plans);
}

export function joinGroupKeyboard(inviteLink: string): InlineKeyboard {
  return new InlineKeyboard().url('\u{1F680} Join the group', inviteLink);
}

export function renewKeyboard(): InlineKeyboard {
  return new InlineKeyboard().text('♻️ Renew now', CB.renew).row().text('ℹ️ Help', CB.help);
}

export function subscribeKeyboard(): InlineKeyboard {
  return new InlineKeyboard().text('\u{1F4E6} View Plans', CB.plans);
}

export function backToMenuKeyboard(): InlineKeyboard {
  return new InlineKeyboard().text('⬅️ Back to menu', CB.menu);
}

/* ── Admin keyboards ─────────────────────────────────────────── */

export function adminMenuKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text('\u{1F4CA} Stats', 'adm:stats')
    .text('\u{1F465} Members', 'adm:members:0')
    .row()
    .text('\u{1F4B3} Payments', 'adm:payments:0')
    .text('\u{1F9FE} Plans', 'adm:plans')
    .row()
    .text('\u{1F4E3} Broadcast', 'adm:bc')
    .text('\u{1F4E2} Post to group', 'adm:post')
    .row()
    .text('\u{1F50D} Find member', 'adm:find')
    .row();
}

export function adminBackKeyboard(): InlineKeyboard {
  return new InlineKeyboard().text('⬅️ Admin menu', 'adm:menu');
}

export function broadcastAudienceKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text('\u{1F310} All subscribers', 'adm:bc:all')
    .row()
    .text('✅ Active only', 'adm:bc:active')
    .row()
    .text('⏰ Expired only', 'adm:bc:expired')
    .row()
    .text('⬅️ Admin menu', 'adm:menu');
}

export function broadcastConfirmKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text('\u{1F680} Send now', 'adm:bc:send')
    .text('❌ Cancel', 'adm:bc:cancel');
}

export function paginationKeyboard(prefix: string, page: number, hasNext: boolean): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  if (page > 0) keyboard.text('⬅️ Previous', `${prefix}:${page - 1}`);
  if (hasNext) keyboard.text('Next ➡️', `${prefix}:${page + 1}`);
  keyboard.row().text('⬅️ Admin menu', 'adm:menu');
  return keyboard;
}

export function memberActionsKeyboard(telegramId: number, isActive: boolean): InlineKeyboard {
  const keyboard = new InlineKeyboard().text('✉️ Message', `adm:dm:${telegramId}`).row();
  keyboard.text('\u{1F381} Grant / extend', `adm:grant:${telegramId}`).row();
  if (isActive) keyboard.text('\u{1F6AB} Revoke access', `adm:revoke:${telegramId}`).row();
  keyboard.text('⬅️ Admin menu', 'adm:menu');
  return keyboard;
}

export function planAdminKeyboard(plans: IPlan[]): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  for (const plan of plans) {
    keyboard
      .text(
        `${plan.isActive ? '✅' : '\u{1F6AB}'} ${plan.name} • ${formatMoney(plan.priceMinor, plan.currency)}`,
        `adm:plan:${String(plan._id)}`,
      )
      .row();
  }
  keyboard.text('➕ Add plan', 'adm:planadd').row().text('⬅️ Admin menu', 'adm:menu');
  return keyboard;
}

export function planEditKeyboard(planId: string, isActive: boolean): InlineKeyboard {
  return new InlineKeyboard()
    .text('\u{1F4B0} Change price', `adm:planprice:${planId}`)
    .row()
    .text('✏️ Rename', `adm:planname:${planId}`)
    .row()
    .text('\u{1F4C5} Change duration', `adm:plandays:${planId}`)
    .row()
    .text(isActive ? '\u{1F6AB} Retire plan' : '✅ Re-activate plan', `adm:plantoggle:${planId}`)
    .row()
    .text('⬅️ All plans', 'adm:plans');
}

export function cancelKeyboard(): InlineKeyboard {
  return new InlineKeyboard().text('❌ Cancel', 'adm:cancel');
}
