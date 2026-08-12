import { Resend } from 'resend';

const resend = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null;

/// Notification must never break execution. Money has already moved on-chain by the
/// time this runs; a failed email is a support ticket, a thrown error is a stuck keeper.
export async function notifyAutoSave({ to, amount6, txHash, vault, savePct }) {
  if (!resend || !to) {
    console.log(`      [mail skipped] ${amount6} -> ${to || 'no address'}`);
    return;
  }
  const usd = (Number(amount6) / 1e6).toFixed(2);
  try {
    const { error } = await resend.emails.send({
      from: process.env.MAIL_FROM,
      to,
      subject: `You just saved $${usd}`,
      text:
`Your auto-save rule moved $${usd} into your Safemi account.

That's ${savePct}% of a tip you received on Tiplyfi, set aside automatically.

It's sitting in Flex — no lock, no penalty, withdraw any time.
Log in at safemi.app with the same account you use for Tiplyfi.

Vault: ${vault}
Transaction: ${txHash}

Turn this off any time in Tiplyfi settings.`,
    });
    if (error) console.error('      [mail error]', error.message);
    else console.log(`      [mail sent] $${usd} -> ${to}`);
  } catch (err) {
    console.error('      [mail threw]', err.message);
  }
}
