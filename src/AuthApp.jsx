import { useEffect, useState } from 'react';

export default function AuthApp({ route, onAuthenticate, onVerify, onResend, onForgotRequest, onPasswordReset }) {
  const [role, setRole] = useState('student');
  const [photoUrl, setPhotoUrl] = useState('');
  const [passwordError, setPasswordError] = useState('');
  const email = sessionStorage.getItem('studynest_pending_email') || '';
  const resetEmail = sessionStorage.getItem('studynest_password_reset_email') || '';
  const registering = route === 'register';

  useEffect(() => {
    return () => {
      if (photoUrl) URL.revokeObjectURL(photoUrl);
    };
  }, [photoUrl]);

  useEffect(() => {
    setRole('student');
    setPhotoUrl('');
  }, [route]);

  function handlePhotoChange(event) {
    if (photoUrl) URL.revokeObjectURL(photoUrl);
    setPhotoUrl(event.target.files?.[0] ? URL.createObjectURL(event.target.files[0]) : '');
  }

  function handleSubmit(event) {
    event.preventDefault();
    const form = event.currentTarget;
    const values = new FormData(form);
    if (registering && values.get('password') !== values.get('password_confirmation')) {
      setPasswordError('Your passwords do not match. Check both fields and try again.');
      form.elements.password_confirmation.focus();
      return;
    }
    setPasswordError('');
    onAuthenticate(values, registering);
  }

  if (route === 'forgot-password') {
    return (
      <main className="auth-screen">
        <section className="auth-story">
          <a className="brand brand-light" href="#/login"><span className="brand-mark">s</span><span><b>StudyNest</b><small>account recovery</small></span></a>
          <div className="story-content"><div className="eyebrow">YOUR LEARNING SPACE IS SAFE</div><h1>Let’s get you back to learning.</h1><p>We’ll email you a secure, time-limited code to reset your password.</p><div className="story-doodle">✳</div></div>
        </section>
        <section className="auth-form-side">
          <form className="auth-form" id="forgot-password-form" onSubmit={(event) => {
            event.preventDefault();
            onForgotRequest(new FormData(event.currentTarget));
          }}>
            <div className="eyebrow">PASSWORD RECOVERY</div><h2>Forgot your password?</h2>
            <p>Enter the email address linked to your StudyNest account. We’ll send a reset code if the account is eligible.</p>
            <label>Email address<input name="email" required type="email" autoComplete="email" placeholder="you@example.com" /></label>
            <button type="submit" className="button button-primary button-full">Send reset code →</button>
            <div className="auth-switch"><a href="#/login">← Back to sign in</a></div>
          </form>
        </section>
      </main>
    );
  }

  if (route === 'reset-password') {
    return (
      <main className="auth-screen">
        <section className="auth-story">
          <a className="brand brand-light" href="#/login"><span className="brand-mark">s</span><span><b>StudyNest</b><small>secure password reset</small></span></a>
          <div className="story-content"><div className="eyebrow">ALMOST BACK IN</div><h1>Choose a new password.</h1><p>Enter the six-digit code from your email, then set a strong password for your account.</p><div className="story-doodle">✳</div></div>
        </section>
        <section className="auth-form-side">
          <form className="auth-form" id="reset-password-form" onSubmit={(event) => {
            event.preventDefault();
            const form = event.currentTarget;
            const values = new FormData(form);
            if (values.get('password') !== values.get('password_confirmation')) {
              setPasswordError('Your passwords do not match. Check both fields and try again.');
              form.elements.password_confirmation.focus();
              return;
            }
            setPasswordError('');
            onPasswordReset(values);
          }}>
            <div className="eyebrow">VERIFY IT’S YOU</div><h2>Reset your password</h2>
            <p>Enter the code sent to <b>{resetEmail || 'your email address'}</b>. It expires in 10 minutes.</p>
            <input type="hidden" name="email" value={resetEmail} />
            <label>Email code<input name="code" required inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" maxLength="6" placeholder="000000" /></label>
            <label>New password<input name="password" required type="password" minLength="8" autoComplete="new-password" placeholder="At least 8 characters" onChange={() => setPasswordError('')} /></label>
            <label>Confirm new password<input name="password_confirmation" required type="password" minLength="8" autoComplete="new-password" placeholder="Enter your new password again" onChange={() => setPasswordError('')} /></label>
            {passwordError && <p className="auth-form-error" role="alert">{passwordError}</p>}
            <button type="submit" className="button button-primary button-full">Save new password →</button>
            <button type="button" className="button button-outline button-full" onClick={() => onForgotRequest(resetEmail)}>Send a new code</button>
            <div className="auth-switch"><a href="#/login">← Back to sign in</a></div>
          </form>
        </section>
      </main>
    );
  }

  if (route === 'verify-email') {
    return (
      <main className="auth-screen">
        <section className="auth-story">
          <a className="brand brand-light" href="#/login"><span className="brand-mark">s</span><span><b>StudyNest</b><small>email verification</small></span></a>
          <div className="story-content"><div className="eyebrow">ONE QUICK CHECK</div><h1>Verify your email to get started.</h1><p>Enter the six-digit code we sent to your inbox.</p><div className="story-doodle">✳</div></div>
        </section>
        <section className="auth-form-side">
          <form className="auth-form" id="verify-email-form" onSubmit={(event) => {
            event.preventDefault();
            onVerify(new FormData(event.currentTarget));
          }}>
            <div className="eyebrow">CHECK YOUR INBOX</div><h2>Enter your verification code</h2>
            <p>We sent a time-limited code to <b>{email || 'your email address'}</b>.</p>
            <input type="hidden" name="email" value={email} />
            <label>Six-digit code<input name="code" required inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" maxLength="6" placeholder="000000" /></label>
            <button type="submit" className="button button-primary button-full">Verify email →</button>
            <button type="button" className="button button-outline button-full" onClick={() => onResend(email)}>Send a new code</button>
            <div className="auth-switch"><a href="#/login">← Back to sign in</a></div>
          </form>
        </section>
      </main>
    );
  }

  return (
    <main className="auth-screen">
      <section className="auth-story">
        <a className="brand brand-light" href="#/login"><span className="brand-mark">s</span><span><b>StudyNest</b><small>your learning space</small></span></a>
        <div className="story-content"><div className="eyebrow">A LITTLE PROGRESS, EVERY DAY</div><h1>Make room for what you want to learn.</h1><p>Find your focus. Build your rhythm.<br />Keep growing at your own pace.</p><div className="story-doodle">✳</div></div>
        <div className="story-footer">A calmer way to study, one small step at a time.</div>
      </section>
      <section className="auth-form-side">
        <form className="auth-form" id="auth-form" encType="multipart/form-data" onSubmit={handleSubmit}>
          <div className="eyebrow">{registering ? 'A LOVELY PLACE TO BEGIN' : 'WELCOME BACK'}</div>
          <h2>{registering ? 'Create your account' : 'Sign in to StudyNest'}</h2>
          <p>{registering ? 'Your learning space is just a few details away.' : 'Pick up right where you left off.'}</p>
          {registering && <>
            <label>Full name<input name="name" required maxLength="100" autoComplete="name" placeholder="Your name" /></label>
            <label>Account type<select name="role" id="signup-role" value={role} onChange={(event) => setRole(event.target.value)}><option value="student">Student</option><option value="teacher">Teacher</option></select></label>
            {role === 'teacher' && <div id="teacher-id-field">
              <label>Teacher ID photo<input name="teacher_id_photo" id="teacher-id-photo" type="file" accept="image/jpeg,image/png,image/webp" capture="environment" required onChange={handlePhotoChange} /><span className="form-help">Take a clear photo of your school-issued teacher ID, or upload an image. Maximum 5 MB.</span></label>
              {photoUrl && <img id="teacher-id-preview" className="teacher-id-preview" src={photoUrl} alt="Teacher ID photo preview" />}
              <p className="form-help">An administrator will review the photo before approving teacher access.</p>
            </div>}
          </>}
          <label>Email address<input name="email" required type="email" autoComplete="email" placeholder="you@example.com" /></label>
          <label>Password<input name="password" required type="password" minLength={registering ? 8 : 1} autoComplete={registering ? 'new-password' : 'current-password'} placeholder={registering ? 'At least 8 characters' : 'Your password'} onChange={() => setPasswordError('')} /></label>
          {registering && <>
          <label>Confirm password<input name="password_confirmation" required type="password" minLength="8" autoComplete="new-password" placeholder="Enter your password again" onChange={() => setPasswordError('')} /></label>
          {passwordError && <p className="auth-form-error" role="alert">{passwordError}</p>}
          </>}
          <button type="submit" className="button button-primary button-full">{registering ? 'Create my account' : 'Sign in'} <span>→</span></button>
          <div className="auth-switch">{registering ? 'Already have an account?' : 'New to StudyNest?'} <a href={`#/${registering ? 'login' : 'register'}`}>{registering ? 'Sign in' : 'Create an account'}</a></div>
          <a className="forgot-link" href="#/forgot-password">Forgot your password?</a>
          <div className="auth-divider"><span>or</span></div>
          <a href="#/google-auth" className="button button-google button-full">Continue with Google <span>↗</span></a>
          <small className="google-note">Google sign-in will be available soon.</small>
        </form>
      </section>
    </main>
  );
}
