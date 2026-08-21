import { Resend } from 'resend';

const resend = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null;

/**
 * Format a 6dp USDC amount as a decimal string using integer math only.
 * Never Number()/toFixed on a money value: that routes through a float and
 * displayed can drift from actual. 94000 -> "0.094000" -> trimmed "0.094".
 * @param {bigint} amount6
 * @returns {string}
 */
function formatUsdc6(amount6) {
  const negative = amount6 < 0n;
  const v = negative ? -amount6 : amount6;
  const whole = v / 1000000n;
  const frac = (v % 1000000n).toString().padStart(6, '0').replace(/0+$/, '');
  const body = frac.length ? `${whole}.${frac}` : `${whole}`;
  return negative ? `-${body}` : body;
}

/// Notification must never break execution. Money has already moved on-chain by the
/// time this runs; a failed email is a support ticket, a thrown error is a stuck keeper.
export async function notifyAutoSave({ to, amount6, txHash, vault, savePct }) {
  if (!resend || !to) {
    console.log(`      [mail skipped] ${amount6} -> ${to || 'no address'}`);
    return;
  }
  const amt = formatUsdc6(amount6);
  try {
    const { error } = await resend.emails.send({
      from: process.env.MAIL_FROM,
      to,
      subject: `Auto-save ran: ${amt} USDC set aside`,
      text:
`Arc testnet — this moved test funds, not real money.

Your auto-save rule moved ${amt} USDC into a vault you control.

That's ${savePct}% of a tip you received on Tiplyfi, set aside automatically.

Vault: ${vault}
Transaction: ${txHash}

Turn this off any time in Tiplyfi settings.`,
    });
    if (error) console.error('      [mail error]', error.message);
    else console.log(`      [mail sent] ${amt} USDC -> ${to}`);
  } catch (err) {
    console.error('      [mail threw]', err.message);
  }
}
