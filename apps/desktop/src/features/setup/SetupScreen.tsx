import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { Button } from '@/components/Button';
import { Field } from '@/components/Field';
import { PinPad } from '@/components/PinPad';
import { ApiError, api, type Session } from '@/lib/api';

interface SetupScreenProps {
  shopName: string;
  onDone: (session: Session) => void;
  /** This computer joined a shop that already exists; there is no session yet. */
  onJoined: () => void;
}

type Step = 'choose' | 'shop' | 'pin' | 'confirm' | 'join';

/**
 * First run. Either names a new shop and creates the owner's account, or
 * connects this computer to a shop that already exists.
 *
 * The second path is not a convenience. Without it there is only one way
 * through this screen, so putting the app on a replacement computer means
 * creating a second owner account, overwriting the real shop details with
 * freshly typed ones, and ending up with a PIN screen showing the same person
 * twice.
 *
 * Only ever seen once, so it explains rather than assumes: the person doing this
 * is a shop owner setting up software, not an administrator who already knows
 * what a "user account" is. The left panel shows the receipt header taking shape
 * as they type, so the shop details are not an abstract form.
 */
export function SetupScreen({
  shopName,
  onDone,
  onJoined,
}: SetupScreenProps): React.JSX.Element {
  const [step, setStep] = useState<Step>('choose');
  const [shop, setShop] = useState(shopName);
  const [fullName, setFullName] = useState('');
  const [username, setUsername] = useState('');
  const [phone, setPhone] = useState('');
  const [address, setAddress] = useState('');
  const [pin, setPin] = useState('');
  const [confirmPin, setConfirmPin] = useState('');
  const [pinError, setPinError] = useState<string>();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');

  const join = useMutation({
    mutationFn: () => api.joinExistingShop(email.trim(), password),
    onSuccess: () => {
      setPassword('');
      onJoined();
    },
  });

  const create = useMutation({
    mutationFn: api.setupOwner,
    onSuccess: onDone,
    onError: () => {
      setStep('pin');
      setPin('');
      setConfirmPin('');
    },
  });

  const error = create.error instanceof ApiError ? create.error : null;
  const joinError = join.error instanceof ApiError ? join.error.message : undefined;
  const detailsReady =
    shop.trim().length >= 2 && fullName.trim().length >= 2 && username.trim().length >= 3;

  function handlePinComplete(entered: string): void {
    setPinError(undefined);
    setPin(entered);
    setStep('confirm');
  }

  function handleConfirmComplete(entered: string): void {
    if (entered !== pin) {
      setPinError('Those PINs are different. Enter the new PIN again.');
      setPin('');
      setConfirmPin('');
      setStep('pin');
      return;
    }
    create.mutate({
      fullName: fullName.trim(),
      username: username.trim().toLowerCase(),
      pin,
      shopName: shop.trim(),
      phone: phone.trim() || undefined,
      addressLine1: address.trim() || undefined,
    });
  }

  return (
    <div className="flex h-full bg-paper">
      <aside className="flex w-96 shrink-0 flex-col justify-between bg-ink p-10 text-white">
        <div>
          <p className="text-meta text-white/45">Every receipt will be headed</p>
          <div className="mt-4 border-l-2 border-board pl-4">
            <p className="text-title font-semibold leading-tight tracking-tight">
              {shop.trim() || 'Your shop name'}
            </p>
            {address.trim() && <p className="mt-1.5 text-base text-white/60">{address.trim()}</p>}
            {phone.trim() && <p className="text-base text-white/60">{phone.trim()}</p>}
          </div>
        </div>
        {step !== 'choose' && step !== 'join' && <Progress step={step} />}
      </aside>

      <main className="flex flex-1 items-center justify-center overflow-y-auto p-10">
        <div className="w-full max-w-md">
          <h1 className="text-title font-semibold tracking-tight text-ink">
            {step === 'choose'
              ? 'Welcome'
              : step === 'join'
                ? 'Connect to your shop'
                : step === 'shop'
                  ? 'Set up the shop'
                  : 'Choose your PIN'}
          </h1>

          {step === 'choose' && (
            <div className="mt-7 space-y-3">
              <p className="text-base text-ink-soft">
                Is this the first computer for this shop, or does the shop already run on another
                one?
              </p>

              <button
                type="button"
                onClick={() => setStep('shop')}
                className="w-full rounded border border-rule px-4 py-3.5 text-left transition-colors duration-100 hover:border-board hover:bg-board/10"
              >
                <span className="block text-base font-medium text-ink">This is a new shop</span>
                <span className="mt-0.5 block text-meta text-ink-soft">
                  Name the shop and create your own account.
                </span>
              </button>

              <button
                type="button"
                onClick={() => setStep('join')}
                className="w-full rounded border border-rule px-4 py-3.5 text-left transition-colors duration-100 hover:border-board hover:bg-board/10"
              >
                <span className="block text-base font-medium text-ink">
                  The shop is already set up on another computer
                </span>
                <span className="mt-0.5 block text-meta text-ink-soft">
                  Bring everything down to this one — the items, the customers, the bills, and who
                  can sign in.
                </span>
              </button>
            </div>
          )}

          {step === 'join' && (
            <form
              className="mt-7 space-y-5"
              onSubmit={(event) => {
                event.preventDefault();
                if (email.trim() && password) join.mutate();
              }}
            >
              <p className="text-base text-ink-soft">
                Sign in with the shop account and this computer will take a copy of everything.
                Signing in to the till itself still happens with your own PIN.
              </p>

              <Field
                label="Email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                autoFocus
                autoComplete="off"
                maxLength={200}
              />
              <Field
                label="Password"
                type="password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                autoComplete="off"
                maxLength={200}
                hint="Used once to sign in. It is not kept on this computer."
              />

              {joinError && (
                <p className="rounded border border-due/30 bg-due-tint px-3 py-2.5 text-meta text-due">
                  {joinError}
                </p>
              )}

              <div className="flex items-center gap-3">
                <Button
                  type="submit"
                  variant="primary"
                  disabled={join.isPending || !email.trim() || !password}
                >
                  {join.isPending ? 'Bringing everything down…' : 'Connect this computer'}
                </Button>
                <Button variant="quiet" onClick={() => setStep('choose')} disabled={join.isPending}>
                  Back
                </Button>
              </div>

              {join.isPending && (
                <p className="text-meta text-ink-soft">
                  This can take a minute on a slow connection. It only happens once.
                </p>
              )}
            </form>
          )}

          {step === 'shop' && (
            <form
              className="mt-7 space-y-5"
              onSubmit={(event) => {
                event.preventDefault();
                if (detailsReady) setStep('pin');
              }}
            >
              <Field
                label="Shop name"
                value={shop}
                onChange={(event) => setShop(event.target.value)}
                autoFocus
                maxLength={80}
              />
              <div className="grid grid-cols-2 gap-4">
                <Field
                  label="Phone number"
                  value={phone}
                  onChange={(event) => setPhone(event.target.value)}
                  inputMode="tel"
                  placeholder="0300 1234567"
                  maxLength={40}
                />
                <Field
                  label="Address"
                  value={address}
                  onChange={(event) => setAddress(event.target.value)}
                  placeholder="Main Bazaar, Dina"
                  maxLength={120}
                />
              </div>

              <div className="border-t border-rule pt-5">
                <h2 className="text-section font-semibold text-ink">Your account</h2>
                <p className="mt-1 text-meta text-ink-soft">
                  You will be the owner, with access to everything. Add staff later and choose what
                  each of them can do.
                </p>
                <div className="mt-4 grid grid-cols-2 gap-4">
                  <Field
                    label="Your name"
                    value={fullName}
                    onChange={(event) => setFullName(event.target.value)}
                    maxLength={60}
                  />
                  <Field
                    label="Username"
                    value={username}
                    onChange={(event) => setUsername(event.target.value.toLowerCase())}
                    hint="Letters and numbers, no spaces."
                    maxLength={32}
                  />
                </div>
              </div>

              <Button
                type="submit"
                variant="primary"
                size="lg"
                disabled={!detailsReady}
                className="w-full"
              >
                Continue
              </Button>
            </form>
          )}

          {(step === 'pin' || step === 'confirm') && (
            <div className="mt-7">
              <p className="mb-7 text-row text-ink-soft">
                {step === 'pin'
                  ? 'You will type this four-digit PIN every time you sign in. Avoid 1234 and four of the same digit.'
                  : 'Enter the same PIN once more to confirm it.'}
              </p>

              <PinPad
                key={step}
                value={step === 'pin' ? pin : confirmPin}
                onChange={step === 'pin' ? setPin : setConfirmPin}
                onComplete={step === 'pin' ? handlePinComplete : handleConfirmComplete}
                disabled={create.isPending}
                error={pinError ?? error?.message}
              />

              <div className="mt-7 flex items-center gap-3">
                <Button
                  onClick={() => {
                    setPinError(undefined);
                    if (step === 'confirm') {
                      setConfirmPin('');
                      setStep('pin');
                    } else {
                      setPin('');
                      setStep('shop');
                    }
                  }}
                  disabled={create.isPending}
                >
                  Back
                </Button>
                {create.isPending && (
                  <p className="text-meta text-ink-soft">Creating your account…</p>
                )}
              </div>
            </div>
          )}
        </div>
      </main>
    </div>
  );
}

/** Two steps, so the owner can see there is an end to this. */
function Progress({ step }: { step: Step }): React.JSX.Element {
  const stage = step === 'shop' ? 0 : 1;
  const labels = ['Shop details', 'Your PIN'];

  return (
    <ol className="space-y-2.5">
      {labels.map((label, index) => (
        <li key={label} className="flex items-center gap-3">
          <span
            className={[
              'h-1.5 w-8 rounded-full transition-colors duration-200',
              index <= stage ? 'bg-board' : 'bg-white/20',
            ].join(' ')}
          />
          <span className={index <= stage ? 'text-meta text-white/80' : 'text-meta text-white/35'}>
            {label}
          </span>
        </li>
      ))}
    </ol>
  );
}
