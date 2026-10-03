/**
 * <sura-phone-verify> — OTP gate on the registration form.
 *
 * Talks only to the App Proxy, so requests are same-origin and no gateway
 * credential exists in the browser. Enforcement happens server-side in the
 * customers/create webhook; this element is the customer-facing half.
 */
class SuraPhoneVerify extends HTMLElement {
  connectedCallback() {
    this.proxy = this.dataset.proxy || '/apps/sura-notify';
    this.form = this.closest('form') || document.getElementById(this.dataset.form);

    this.phoneInput = this.querySelector('#sura-verify-phone');
    this.codeInput = this.querySelector('#sura-verify-code');
    this.codeStep = this.querySelector('[data-step="code"]');
    this.message = this.querySelector('[data-role="message"]');
    this.tokenField = this.querySelector('[data-role="token"]');
    // Minimog wraps forms in its own markup; if the register form contains more
    // than one submit control, pass data-submit="<selector>" on the snippet.
    this.submitButton = this.form?.querySelector(this.dataset.submit || '[type="submit"]');

    this.verified = false;
    this.lock();

    this.addEventListener('click', (event) => {
      const action = event.target.closest('[data-action]')?.dataset.action;
      if (action === 'request' || action === 'resend') this.request(event.target);
      if (action === 'verify') this.verify(event.target);
    });

    this.codeInput.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        this.verify(this.querySelector('[data-action="verify"]'));
      }
    });

    // A number change invalidates an earlier verification.
    this.phoneInput.addEventListener('input', () => {
      if (this.verified) this.reset();
    });

    this.form?.addEventListener('submit', (event) => {
      if (!this.verified) {
        event.preventDefault();
        this.say('Verify your mobile number to create the account.', 'error');
        this.phoneInput.focus();
      }
    });
  }

  get phone() {
    return this.phoneInput.value.replace(/\D/g, '');
  }

  get email() {
    return this.form?.querySelector('input[name="customer[email]"]')?.value || undefined;
  }

  async request(button) {
    if (!/^[6-9]\d{9}$/.test(this.phone)) {
      return this.say('Enter a valid 10-digit mobile number.', 'error');
    }

    const data = await this.post('/otp/request', { phone: this.phone, email: this.email }, button, 'Sending…');
    if (!data) return;

    this.codeStep.hidden = false;
    this.codeInput.focus();
    this.say(`Code sent to ${this.phone}. It is valid for ${Math.round(data.expiresIn / 60)} minutes.`, 'success');
    this.startResendTimer(data.resendAfter || 60);
  }

  async verify(button) {
    if (!/^\d{4,6}$/.test(this.codeInput.value.trim())) {
      return this.say('Enter the code from the SMS.', 'error');
    }

    const data = await this.post(
      '/otp/verify',
      { phone: this.phone, code: this.codeInput.value.trim() },
      button,
      'Checking…',
    );
    if (!data) return;

    this.verified = true;
    this.tokenField.value = data.token;
    this.phoneInput.readOnly = true;
    this.codeInput.readOnly = true;
    this.querySelectorAll('[data-action]').forEach((el) => { el.disabled = true; });
    this.say('Mobile number verified.', 'success');
    this.unlock();
  }

  async post(path, body, button, busyLabel) {
    const original = button?.textContent;
    if (button) {
      button.disabled = true;
      button.textContent = busyLabel;
    }

    try {
      const res = await fetch(`${this.proxy}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json();

      if (!res.ok || !data.ok) {
        this.say(data.message || 'Something went wrong. Try again.', 'error');
        return null;
      }
      return data;
    } catch {
      this.say('Could not reach the server. Check your connection and try again.', 'error');
      return null;
    } finally {
      if (button && original !== undefined) {
        button.disabled = false;
        button.textContent = original;
      }
    }
  }

  startResendTimer(seconds) {
    const resend = this.querySelector('[data-action="resend"]');
    if (!resend) return;
    let remaining = seconds;

    clearInterval(this.timer);
    const tick = () => {
      resend.disabled = remaining > 0;
      resend.textContent = remaining > 0 ? `Resend code in ${remaining}s` : 'Resend code';
      if (remaining <= 0) clearInterval(this.timer);
      remaining -= 1;
    };
    tick();
    this.timer = setInterval(tick, 1000);
  }

  reset() {
    this.verified = false;
    this.tokenField.value = '';
    this.codeStep.hidden = true;
    this.codeInput.value = '';
    this.say('');
    this.lock();
  }

  lock() {
    if (this.submitButton) this.submitButton.disabled = true;
  }

  unlock() {
    if (this.submitButton) this.submitButton.disabled = false;
  }

  say(text, tone) {
    this.message.textContent = text;
    if (tone) this.message.dataset.tone = tone;
    else delete this.message.dataset.tone;
  }

  disconnectedCallback() {
    clearInterval(this.timer);
  }
}

if (!customElements.get('sura-phone-verify')) {
  customElements.define('sura-phone-verify', SuraPhoneVerify);
}
