import { getEnv } from '../../config/env';
import { formatMoney, parseAmountToMinor } from '../../utils/money';
import { escapeHtml } from '../../utils/text';
import { Plan } from '../../models';
import type { BotContext } from '../context';
import { adminBackKeyboard, cancelKeyboard, planAdminKeyboard, planEditKeyboard } from '../keyboards';
import { planDuration } from '../texts';
import { render, reply } from '../helpers';

export async function showPlanAdmin(ctx: BotContext): Promise<void> {
  const plans = await Plan.find({}).sort({ sortOrder: 1, priceMinor: 1 });

  const lines = ['\u{1F9FE} <b>Plans</b>', ''];
  if (plans.length === 0) {
    lines.push('<i>No plans yet. Add one to start selling.</i>');
  } else {
    for (const plan of plans) {
      lines.push(
        `${plan.isActive ? '✅' : '\u{1F6AB}'} <b>${escapeHtml(plan.name)}</b> — ${formatMoney(plan.priceMinor, plan.currency)} • ${planDuration(plan.durationDays)}`,
        `  code <code>${escapeHtml(plan.code)}</code>`,
      );
    }
  }
  lines.push('', '<i>Retiring a plan hides it from subscribers. Existing subscriptions are untouched.</i>');

  await render(ctx, lines.join('\n'), planAdminKeyboard(plans));
}

export async function showPlanEditor(ctx: BotContext, planId: string): Promise<void> {
  const plan = await Plan.findById(planId);
  if (!plan) {
    await render(ctx, '⚠️ That plan no longer exists.', adminBackKeyboard());
    return;
  }

  const lines = [
    `\u{1F9FE} <b>${escapeHtml(plan.name)}</b>`,
    '',
    `Code: <code>${escapeHtml(plan.code)}</code>`,
    `Price: <b>${formatMoney(plan.priceMinor, plan.currency)}</b>`,
    `Duration: <b>${planDuration(plan.durationDays)}</b> (${plan.durationDays} days)`,
    `Status: <b>${plan.isActive ? 'on sale' : 'retired'}</b>`,
  ];
  if (plan.description) lines.push('', escapeHtml(plan.description));

  await render(ctx, lines.join('\n'), planEditKeyboard(planId, plan.isActive));
}

export async function togglePlan(ctx: BotContext, planId: string): Promise<void> {
  const plan = await Plan.findById(planId);
  if (!plan) {
    await render(ctx, '⚠️ That plan no longer exists.', adminBackKeyboard());
    return;
  }
  plan.isActive = !plan.isActive;
  await plan.save();
  await showPlanEditor(ctx, planId);
}

export async function promptPlanField(ctx: BotContext, planId: string, field: 'price' | 'name' | 'days'): Promise<void> {
  ctx.session.step = `adm_plan_${field}`;
  ctx.session.admin = { ...ctx.session.admin, planId };

  const prompts: Record<typeof field, string> = {
    price: 'Send the new price in ' + getEnv().CURRENCY + ', for example <code>25000</code>.',
    name: 'Send the new plan name, for example <code>Monthly Access</code>.',
    days: 'Send the new duration in days, for example <code>30</code>.',
  };

  await render(ctx, `✏️ ${prompts[field]}`, cancelKeyboard());
}

export async function promptPlanAdd(ctx: BotContext): Promise<void> {
  ctx.session.step = 'adm_plan_add';
  await render(
    ctx,
    [
      '➕ <b>Add a plan</b>',
      '',
      'Send one line in this format:',
      '<code>code | Name | price | days</code>',
      '',
      'Example:',
      '<code>monthly | Monthly Access | 25000 | 30</code>',
    ].join('\n'),
    cancelKeyboard(),
  );
}

/** Handles the text replies for every plan editing step. Returns true if consumed. */
export async function handlePlanStep(ctx: BotContext): Promise<boolean> {
  const step = ctx.session.step;
  const text = ctx.message?.text?.trim() ?? '';
  if (!step?.startsWith('adm_plan')) return false;

  if (step === 'adm_plan_add') {
    const parts = text.split('|').map((p) => p.trim());
    if (parts.length < 4) {
      await reply(ctx, '⚠️ Use the format <code>code | Name | price | days</code>.');
      return true;
    }
    const [code, name, priceRaw, daysRaw] = parts;
    const priceMinor = parseAmountToMinor(priceRaw);
    const durationDays = Number(daysRaw);

    if (!code || !name || !priceMinor || !Number.isInteger(durationDays) || durationDays < 1) {
      await reply(ctx, '⚠️ Could not read that. Check the price and the number of days, then try again.');
      return true;
    }

    const existing = await Plan.findOne({ code: code.toLowerCase() });
    if (existing) {
      await reply(ctx, `⚠️ A plan with the code <code>${escapeHtml(code)}</code> already exists.`);
      return true;
    }

    await Plan.create({
      code: code.toLowerCase(),
      name,
      priceMinor,
      currency: getEnv().CURRENCY,
      durationDays,
      isActive: true,
      sortOrder: durationDays,
    });

    ctx.session.step = undefined;
    await reply(ctx, `✅ Created <b>${escapeHtml(name)}</b>.`);
    await showPlanAdmin(ctx);
    return true;
  }

  const planId = ctx.session.admin?.planId;
  const plan = planId ? await Plan.findById(planId) : null;
  if (!plan) {
    ctx.session.step = undefined;
    await reply(ctx, '⚠️ That plan no longer exists.');
    return true;
  }

  if (step === 'adm_plan_price') {
    const priceMinor = parseAmountToMinor(text);
    if (!priceMinor) {
      await reply(ctx, '⚠️ Send a number, for example <code>25000</code>.');
      return true;
    }
    plan.priceMinor = priceMinor;
  } else if (step === 'adm_plan_name') {
    if (text.length < 2 || text.length > 60) {
      await reply(ctx, '⚠️ The name must be between 2 and 60 characters.');
      return true;
    }
    plan.name = text;
  } else if (step === 'adm_plan_days') {
    const days = Number(text);
    if (!Number.isInteger(days) || days < 1 || days > 3650) {
      await reply(ctx, '⚠️ Send a whole number of days between 1 and 3650.');
      return true;
    }
    plan.durationDays = days;
  } else {
    return false;
  }

  await plan.save();
  ctx.session.step = undefined;
  await reply(ctx, '✅ Plan updated.');
  await showPlanEditor(ctx, String(plan._id));
  return true;
}
